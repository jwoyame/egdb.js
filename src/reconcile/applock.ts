/**
 * Fabric-wide advisory lock used for compress/edit run-level mutual exclusion
 * (N9 — see openparcels/handoff/N9_LOCK_DESIGN.md). Compress holds it EXCLUSIVE
 * for its whole run; every editor state-mutating transaction holds it SHARED as
 * the first statement of its transaction. Shared holders coexist (normal
 * multi-editor editing is unaffected); exclusive waits for all shared holders and
 * blocks new ones. A distinct resource from the per-version `egdb_version:<name>`
 * post-serialization lock (`lockVersion`), which is unchanged.
 *
 * Transaction-scoped: released automatically at the holding transaction's
 * commit/rollback, and — for the compress exclusive hold on its dedicated
 * connection — on connection death (crash self-heal). The caller MUST already be
 * in a transaction.
 */
import type { IDatabaseConnection } from '../connections/connection';

export const COMPRESS_LOCK_RESOURCE = 'egdb_compress';

/** How long an editor waits for the SHARED lock before BOUNCING (throwing
 * ApplockTimeoutError → the app shows "maintenance in progress, retry"). Kept
 * short: compress holds the exclusive lock for its WHOLE run, so a blocked editor
 * would otherwise wait — and freeze its connection's RwLock — for that whole run.
 * Steady-state nightly compress is seconds, so an editor rarely waits at all. */
export const EDITOR_SHARED_LOCK_TIMEOUT_MS = 5000;

/** A short, distinct 2-int keyspace for the compress lock on PostgreSQL so it can
 * never hash-collide with `lockVersion`'s single-int `hashtext('egdb_version:…')`. */
const PG_COMPRESS_LOCK_KEY1 = 0x6567_6462; // 'egdb'
const PG_COMPRESS_LOCK_KEY2 = 0x636f_6d70; // 'comp'

export class ApplockTimeoutError extends Error {
  constructor(public readonly resource: string, public readonly mode: 'Exclusive' | 'Shared') {
    super(`Timed out acquiring ${mode} lock on ${resource} (another ${mode === 'Exclusive' ? 'editor/compress' : 'compress'} run holds it).`);
    this.name = 'ApplockTimeoutError';
  }
}

/**
 * Acquire the fabric-wide compress applock in `mode` on `connection` (which must
 * already be in a transaction), waiting at most `timeoutMs`. Throws
 * ApplockTimeoutError on timeout — so an editor blocked behind a long compress
 * BOUNCES (app maps it to "maintenance in progress, retry") instead of hanging
 * and freezing the connection's RwLock for the whole run.
 */
export async function acquireCompressLock(
  connection: IDatabaseConnection,
  mode: 'Exclusive' | 'Shared',
  timeoutMs: number,
): Promise<void> {
  if (!connection.inTransaction()) {
    throw new Error('acquireCompressLock must be called inside a transaction (the lock is transaction-scoped).');
  }
  if (connection.driver === 'sqlserver') {
    const sql = `
      DECLARE @r int;
      EXEC @r = sp_getapplock @Resource = @p0, @LockMode = @p1, @LockOwner = 'Transaction', @LockTimeout = @p2;
      SELECT @r AS code;`;
    const rows = await connection.query<{ code: number }>(sql, [COMPRESS_LOCK_RESOURCE, mode, timeoutMs]);
    const code = rows[0]?.code ?? -999;
    // 0 = granted, 1 = granted after wait. Negative = failure: -1 timeout, -3 deadlock.
    if (code < 0) {
      if (code === -1) throw new ApplockTimeoutError(COMPRESS_LOCK_RESOURCE, mode);
      throw new Error(`Failed to acquire ${mode} lock on ${COMPRESS_LOCK_RESOURCE}: sp_getapplock code ${code}`);
    }
  } else {
    // PostgreSQL: SET LOCAL statement_timeout bounds the wait (advisory-lock funcs
    // block indefinitely otherwise). Inlined constant — SET LOCAL rejects binds.
    const fn = mode === 'Exclusive' ? 'pg_advisory_xact_lock' : 'pg_advisory_xact_lock_shared';
    try {
      await connection.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      await connection.query(`SELECT ${fn}(${PG_COMPRESS_LOCK_KEY1}, ${PG_COMPRESS_LOCK_KEY2})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('statement timeout') || msg.includes('canceling statement')) {
        throw new ApplockTimeoutError(COMPRESS_LOCK_RESOURCE, mode);
      }
      throw e;
    }
  }
}

/**
 * Holds the compress EXCLUSIVE lock for the WHOLE compress run on a DEDICATED
 * connection, via an open (empty) transaction — because compress is many separate
 * transactions on its main connection, a transaction-scoped lock there would
 * release between them. The dedicated connection is pinned to a single pooled
 * session (so it is never idle-reaped or double-handed) and kept warm by a
 * periodic ping that also DETECTS a silent connection death: an idle empty tx held
 * ~50 min can be dropped by an RDS/TCP idle timeout, which auto-releases the lock;
 * `assertHeld()` (called between phases) then aborts the run rather than letting it
 * proceed with no lock. The tx-scoped lock also auto-releases on crash (self-heal).
 */
export class CompressLockHolder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lost = false;
  private lostReason = '';
  private released = false;

  private constructor(private readonly conn: IDatabaseConnection) {}

  /** Acquire the exclusive lock on `dedicatedConn` (freshly connected, single-
   * session pool). Throws ApplockTimeoutError if it can't be acquired within
   * `timeoutMs` (→ caller defers); closes the connection on any failure. */
  static async acquire(dedicatedConn: IDatabaseConnection, timeoutMs: number, keepAliveMs = 10000): Promise<CompressLockHolder> {
    await dedicatedConn.beginTransaction();
    try {
      await acquireCompressLock(dedicatedConn, 'Exclusive', timeoutMs);
    } catch (e) {
      try { if (dedicatedConn.inTransaction()) await dedicatedConn.rollbackTransaction(); } catch { /* ignore */ }
      try { await dedicatedConn.close(); } catch { /* ignore */ }
      throw e;
    }
    const holder = new CompressLockHolder(dedicatedConn);
    holder.timer = setInterval(() => { void holder.ping(); }, keepAliveMs);
    (holder.timer as { unref?: () => void }).unref?.(); // don't keep the process alive
    return holder;
  }

  private async ping(): Promise<void> {
    if (this.lost || this.released) return;
    try {
      await this.conn.query('SELECT 1 AS ka'); // runs on the tx-pinned session; keeps TCP warm + detects death
    } catch (e) {
      this.lost = true;
      this.lostReason = e instanceof Error ? e.message : String(e);
    }
  }

  /** Throw if the exclusive lock may no longer be held (dedicated connection died).
   * Call between compress phases so a lost lock aborts rather than proceeding blind. */
  assertHeld(): void {
    if (this.lost) throw new Error(`compress exclusive lock lost mid-run (dedicated connection died: ${this.lostReason}); aborting to avoid running unlocked.`);
  }

  async release(): Promise<void> {
    this.released = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { if (this.conn.inTransaction()) await this.conn.rollbackTransaction(); } catch { /* connection may be dead */ }
    try { await this.conn.close(); } catch { /* ignore */ }
  }
}
