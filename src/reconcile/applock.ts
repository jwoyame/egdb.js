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
