/**
 * SQL Server connection implementation
 */
import sql from 'mssql';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { SqlServerConfig } from '../types';
import { RwLock } from '../utils/rw-lock';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait for `p` to settle, giving up after `ms`. Rejections are absorbed, and
 * the give-up timer is cleared so it can't hold the event loop open. */
const settleWithin = (p: Promise<unknown>, ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(() => undefined, () => undefined).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/** How long to wait for a canceled statement to finish unwinding. Longer than
 * the driver's own cancelTimeout (3000, set in the constructor) so the driver
 * always gets to tear the connection down first, which ends the request cleanly;
 * only a connection that ignores both is left for the drop path below. */
export const CANCEL_DRAIN_MS = 7000;

/** How long endTransaction keeps retrying while the driver still reports a
 * request in progress, before dropping the connection. */
const TX_END_RETRY_MS = 100;
const TX_END_RETRIES = 10;

/**
 * True when mssql refused a commit/rollback because a request is still active on
 * the transaction. In that state it sends nothing to the server and does not
 * release the pooled connection, so the transaction stays open until something
 * else ends it.
 */
function isRequestInProgress(err: unknown): boolean {
  return (err as { code?: unknown } | null | undefined)?.code === 'EREQINPROG';
}

/** The tedious connection a transaction borrows, as far as the drop path uses it. */
interface BorrowedConnection {
  close?: () => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** The private mssql Transaction fields the drop path needs. */
interface TransactionInternals {
  _acquiredConnection?: BorrowedConnection | null;
  _acquiredConfig?: unknown;
  _aborted?: boolean;
  /** Listener the driver attaches to the connection's 'rollbackTransaction'
   * event, to notice the server rolling the transaction back on its own. */
  _abort?: (...args: unknown[]) => void;
  parent?: { release?: (c: unknown) => void };
}

/** Driver-side refusals: mssql raised these without sending anything to the
 * server, because the transaction was already over or never started. */
const NOT_SENT_CODES = new Set(['EABORT', 'ENOTBEGUN']);

let warnedAboutInternals = false;

/**
 * The connection this transaction borrowed from the pool, or null.
 *
 * mssql exposes no public accessor, so this reads a private field, pinned by the
 * exact driver version in package.json. If a driver upgrade renames the field the
 * drop path below silently becomes a no-op and open transactions start leaking
 * again, so say so loudly the first time instead.
 */
function borrowedConnection(tx: sql.Transaction): BorrowedConnection | null {
  const t = tx as unknown as TransactionInternals;
  if (!('_acquiredConnection' in t)) {
    if (!warnedAboutInternals) {
      warnedAboutInternals = true;
      console.error(
        '[egdb] mssql internals changed: Transaction has no _acquiredConnection field. ' +
        'A transaction the driver will not end can no longer be cleaned up, so open ' +
        'transactions may be left holding locks. Update dropTransactionConnection in ' +
        'src/connections/sqlserver.ts for this driver version.',
      );
    }
    return null;
  }
  return t._acquiredConnection ?? null;
}

/**
 * End a transaction the driver could not, by closing the connection it ran on:
 * SQL Server rolls the transaction back and frees its locks, and the pool
 * validates the dead connection, destroys it and opens a replacement.
 *
 * `conn` is captured before the attempt, because by the time the failure reaches
 * us the driver may have let go of it, and how it let go decides what is safe:
 *
 * - Still borrowed: the driver refused outright (a request still in progress),
 *   sent nothing and kept the connection. Close it and hand it back ourselves.
 * - Released after reaching the server: the commit or rollback was sent and
 *   failed, and the driver returned the connection to the pool regardless,
 *   possibly with the transaction still open. Close it, but do not release it
 *   again - that would corrupt the pool's accounting.
 * - Released because the server already rolled back: the driver's abort handler
 *   returned the connection, clean, and the pool may already have handed it to
 *   another caller. Closing it then would kill that caller's live query, for
 *   nothing, so leave it alone.
 *
 * Every step is best-effort.
 */
function dropTransactionConnection(tx: sql.Transaction, conn: BorrowedConnection | null, err: unknown): void {
  if (!conn) return;
  const t = tx as unknown as TransactionInternals;
  const stillBorrowed = t._acquiredConnection === conn;
  if (!stillBorrowed) {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (t._aborted || (typeof code === 'string' && NOT_SENT_CODES.has(code))) return;
    try { conn.close?.(); } catch { /* already gone */ }
    return;
  }
  // Detach the driver's abort listener first. Once the transaction lets go of the
  // connection, a late rollback notice from the half-read response would run that
  // listener against a missing connection and throw inside the driver's token
  // handler, which it rethrows and which crashes the process.
  if (t._abort) {
    try { conn.removeListener?.('rollbackTransaction', t._abort); } catch { /* not attached */ }
  }
  try { conn.close?.(); } catch { /* already gone */ }
  try { t.parent?.release?.(conn); } catch { /* pool no longer tracks it */ }
  t._acquiredConnection = null;
  t._acquiredConfig = null;
}

/**
 * Classify a driver error so we can retry transient connection blips (a brief
 * RDS/network hiccup). Note there is NO driver signal that proves a statement
 * never reached the server -- a socket reset can arrive after a commit -- so we
 * never rely on this to make a WRITE retry-safe. It gates only idempotent reads
 * and BEGIN TRAN (which the server auto-rolls-back if the connection drops):
 *
 *  - 'connection'      -- a connection-level failure (mssql ConnectionError,
 *                         socket errors, or a bare timeout with no server
 *                         context). Retried only for reads and begin.
 *  - 'request-timeout' -- a RequestError timeout: the statement reached the
 *                         server and may have committed. Retried only for an
 *                         idempotent read, never for a write or begin.
 *  - 'other'           -- a real SQL/logic error; never retry.
 */
export function classifyConnError(err: unknown): 'connection' | 'request-timeout' | 'other' {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  const code = typeof e?.code === 'string' ? e.code : '';
  const name = typeof e?.name === 'string' ? e.name : '';
  const msg = typeof e?.message === 'string' ? e.message : '';

  if (name === 'ConnectionError') return 'connection';
  if (['ESOCKET', 'ECONNCLOSED', 'ECONNRESET', 'EPIPE', 'ENOTOPEN', 'ENOCONN'].includes(code)) return 'connection';
  if (/failed to connect|connection is closed|connection not yet open|connection lost|socket hang up|connection to .* failed|not connected/i.test(msg)) {
    return 'connection';
  }
  // A request that reached the server then timed out: same ETIMEOUT code, but a
  // RequestError. Retry only reads.
  if (name === 'RequestError' && (code === 'ETIMEOUT' || code === 'ETIMEDOUT')) return 'request-timeout';
  // A bare timeout with no RequestError name is a connect/acquire timeout.
  if (code === 'ETIMEOUT' || code === 'ETIMEDOUT') return 'connection';
  return 'other';
}

export class SqlServerConnection implements IDatabaseConnection {
  private pool: sql.ConnectionPool | null = null;
  private config: sql.config;
  private transaction: sql.Transaction | null = null;
  // When true, this connection owns a PRIVATE ConnectionPool instead of mssql's
  // process-global one — so closing it doesn't close every other egdb connection.
  // Required for the compress exclusive-lock holder, which opens/closes its own
  // dedicated connection while the main connection stays live.
  private readonly dedicatedPool: boolean;

  // Serialises the single `this.transaction` slot against concurrent
  // statements: a transaction holds this exclusively for its whole lifetime,
  // plain statements take it shared. The owner's own in-transaction statements
  // bypass it (they detect `this.transaction`). Streaming reads use a dedicated
  // pooled request and don't touch the lock. See utils/rw-lock.ts.
  private lock = new RwLock();

  // Optional per-statement timeout (ms) applied to execute/executeInsert/query
  // requests when set (enforced by canceling the request, since mssql has no
  // per-request timeout). Lets an edit operation fail fast on a transient DB
  // stall (e.g. a merge, which is normally sub-second) instead of waiting the
  // full pool requestTimeout. Note: it does NOT cover streaming reads or the
  // COMMIT statement (mssql builds its own request for tx.commit()), so a stall
  // there still rides the pool default. Set via withStatementTimeout().
  private statementTimeoutMs: number | null = null;

  readonly driver = 'sqlserver' as const;

  /**
   * Run `fn` with a per-statement timeout applied to this connection's
   * IN-TRANSACTION execute/executeInsert/query requests (see runWithTimeout).
   * Restores the previous value after.
   *
   * The timeout field is shared on the connection and this save/restore is NOT
   * safe across concurrent callers that use DIFFERENT timeout values -- it
   * assumes a single caller (today: the merge, always 12s). Because the timeout
   * only arms for in-transaction statements and those run under the exclusive
   * write lock, wrap ONLY the transaction (not preceding reads) so the armed
   * window is exactly when this op owns the write path.
   */
  async withStatementTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.statementTimeoutMs;
    this.statementTimeoutMs = ms;
    try {
      return await fn();
    } finally {
      this.statementTimeoutMs = prev;
    }
  }

  // Run a request with the active per-statement timeout, if one is set. mssql has
  // no per-request timeout, so we enforce it by canceling the request (an
  // attention token) when the timer fires; that rejects `exec()` with a
  // cancellation error, which classifyConnError treats as a request-timeout.
  private async runWithTimeout<T>(request: sql.Request, exec: () => Promise<T>): Promise<T> {
    const ms = this.statementTimeoutMs;
    // Only enforce the timeout on statements running INSIDE our own transaction.
    // The connection is shared per-connection-id across concurrent requests, and
    // statementTimeoutMs is a shared field; if we also applied it to pooled
    // statements, a merge's fast-fail timer could cancel an unrelated concurrent
    // read. In-transaction statements run only while this operation holds the
    // exclusive write lock, so they are exclusively ours -- safe to cancel.
    if (ms == null || this.transaction == null) return exec();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Statement canceled after ${ms}ms (edit fast-fail timeout)`) as Error & { code: string; name: string };
        err.code = 'ETIMEOUT';
        err.name = 'RequestError';
        // Reject before canceling, so the caller always sees this error and can
        // classify it, rather than whatever shape the driver's own cancellation
        // error takes when it happens to land first.
        reject(err);
        try { request.cancel(); } catch { /* already done */ }
      }, ms);
    });
    const running = exec();
    // The race below can leave `running` rejecting with nobody attached, which
    // Node reports as an unhandled rejection. Attach a no-op handler now.
    running.catch(() => { /* reported via the race or the drain below */ });
    try {
      return await Promise.race([running, timeout]);
    } catch (err) {
      // A cancel is only a request to the server; the driver keeps the request
      // marked active until the server acknowledges it, and mssql refuses to
      // COMMIT or ROLLBACK a transaction while a request is active. That refusal
      // sends nothing to the server and never hands the pooled connection back,
      // so the caller's rollback would leave BEGIN TRAN open, holding locks for
      // the life of the process. Wait for the request to finish unwinding first.
      await settleWithin(running, CANCEL_DRAIN_MS);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  constructor(config: SqlServerConfig) {
    this.config = {
      server: config.server,
      port: config.port ?? 1433,
      database: config.database,
      user: config.user,
      password: config.password,
      options: {
        encrypt: config.options?.encrypt ?? true,
        trustServerCertificate: config.options?.trustServerCertificate ?? true,
        // How long the driver waits for the server to acknowledge a cancel
        // before tearing the connection down itself. Held below CANCEL_DRAIN_MS
        // so the driver's own teardown always wins the race: it ends the request
        // properly, which lets the caller's rollback go through, rather than
        // leaving us to drop the connection by hand.
        cancelTimeout: config.options?.cancelTimeout ?? 3000,
      },
      connectionTimeout: config.options?.connectionTimeout ?? 30000,
      requestTimeout: config.options?.requestTimeout ?? 30000,
      // Streaming reads each hold a pooled connection for their lifetime and a
      // write transaction needs one too; the default max of 10 is tight for a
      // shared single-login server, where a writer could otherwise wait on a
      // free connection while holding the RW write lock. Give some headroom.
      pool: {
        max: config.options?.pool?.max ?? 20,
        min: config.options?.pool?.min ?? 0,
        idleTimeoutMillis: config.options?.pool?.idleTimeoutMillis ?? 30000,
      },
    };
    this.dedicatedPool = config.options?.dedicatedPool ?? false;
  }

  get isConnected(): boolean {
    return this.pool?.connected ?? false;
  }

  async connect(): Promise<void> {
    // A dedicated connection owns a PRIVATE pool so close() only tears down this
    // connection, not mssql's process-global pool that every other egdb connection
    // shares. Default connections keep the historical global-pool behaviour.
    this.pool = this.dedicatedPool
      ? await new sql.ConnectionPool(this.config).connect()
      : await sql.connect(this.config);
  }

  // Re-establish the pool if it has dropped. For a shared (non-dedicated)
  // connection this calls sql.connect, which rebuilds mssql's global pool if it
  // closed but returns the existing one if it's healthy -- so we never yank the
  // pool out from under other connections. Best-effort: on failure we leave the
  // pool as-is and let the retried op surface a fresh error.
  private async reestablishIfDown(): Promise<void> {
    if (this.pool?.connected) return;
    if (this.dedicatedPool) {
      // Close the dead PRIVATE pool before replacing it so its sockets don't leak.
      try { await this.pool?.close(); } catch { /* already down */ }
      try { this.pool = await new sql.ConnectionPool(this.config).connect(); }
      catch { /* leave as-is; the caller's retry will report if still down */ }
    } else {
      // Shared pool: sql.connect rebuilds mssql's global pool if it closed but
      // returns the existing one if healthy, so we never close it out from under
      // other connections.
      try { this.pool = await sql.connect(this.config); }
      catch { /* leave as-is */ }
    }
  }

  // Run an idempotent READ op, retrying ONCE through a transient connection blip.
  // Only reads use this -- writes never auto-retry (a commit's ack can be lost,
  // making a retry a double-apply). `retryRequestTimeout` is true for reads so a
  // slow-then-timed-out read also retries. Never retries while a transaction is
  // open: a lost connection there dooms the whole transaction and the caller must
  // roll back and re-run it.
  private async withConnRetry<T>(op: () => Promise<T>, retryRequestTimeout: boolean): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (this.transaction) throw err;
      const kind = classifyConnError(err);
      const retriable = kind === 'connection' || (retryRequestTimeout && kind === 'request-timeout');
      if (!retriable) throw err;
      await this.reestablishIfDown();
      await delay(300);
      return op();
    }
  }

  async query<T>(sqlQuery: string, params?: unknown[], opts?: { mutating?: boolean }): Promise<T[]> {
    if (!this.pool) throw new Error('Not connected');

    // Inside our own transaction: run on it directly (we hold the write lock).
    if (this.transaction) {
      const request = this.transaction.request();
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await this.runWithTimeout(request, () => request.query(sqlQuery));
      return result.recordset as T[];
    }
    const op = async (): Promise<T[]> => {
      const request = this.pool!.request();
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await this.runWithTimeout(request, () => request.query(sqlQuery));
      return result.recordset as T[];
    };
    // A mutating call routed through query() -- an SDE stored proc like
    // create_version/delete_version/edit_version -- is not idempotent, so it must
    // NOT auto-retry (same reasoning as execute()). Callers pass mutating:true.
    // A plain read has no side effect and is safe to retry through a blip.
    if (opts?.mutating) return this.lock.read(op);
    return this.lock.read(() => this.withConnRetry(op, true));
  }

  async *stream(
    sqlQuery: string,
    params?: unknown[]
  ): AsyncIterable<Record<string, unknown>> {
    if (!this.pool) throw new Error('Not connected');

    // Always stream on a fresh pooled request, independent of any open
    // transaction. A long generator driven by network backpressure must not
    // sit on the transaction slot (it would collide with the owner) or on the
    // RW lock (it would block writers for the stream's whole lifetime). Reads
    // see committed data under READ COMMITTED; that's the same isolation the
    // postgres driver's cursor stream uses.
    const request = this.pool.request();
    request.stream = true;

    if (params) {
      params.forEach((param, index) => {
        request.input(`p${index}`, param);
      });
    }

    // Create a promise-based async iterator from event-based stream
    type QueueItem =
      | { type: 'row'; value: Record<string, unknown> }
      | { type: 'done' }
      | { type: 'error'; error: Error };

    const queue: QueueItem[] = [];
    let resolveWait: (() => void) | null = null;
    let waitPromise: Promise<void> | null = null;
    let streamFinished = false;

    const push = (item: QueueItem) => {
      queue.push(item);
      if (resolveWait) {
        resolveWait();
        resolveWait = null;
        waitPromise = null;
      }
    };

    request.on('row', (row: Record<string, unknown>) => {
      push({ type: 'row', value: row });
    });

    request.on('error', (err: Error) => {
      streamFinished = true;
      push({ type: 'error', error: err });
    });

    request.on('done', () => {
      streamFinished = true;
      push({ type: 'done' });
    });

    // Start the query
    request.query(sqlQuery);

    try {
      // Yield results as they come
      while (true) {
        if (queue.length === 0) {
          // Wait for more items
          waitPromise = new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
          await waitPromise;
        }

        const item = queue.shift();
        if (!item) continue;

        if (item.type === 'error') {
          throw item.error;
        }

        if (item.type === 'done') {
          return;
        }

        yield item.value;
      }
    } finally {
      // If the consumer broke out early (return/throw mid-stream), the
      // underlying TDS request is still busy. A follow-up statement on
      // the same connection (e.g. transaction.rollback() after an apply
      // throws) would queue behind it and hang forever. Wait for done/error
      // before returning so the connection is idle for the next caller.
      if (!streamFinished) {
        await new Promise<void>((resolve) => {
          request.once('done', () => resolve());
          request.once('error', () => resolve());
        });
      }
    }
  }

  async scalar<T>(sqlQuery: string, params?: unknown[]): Promise<T | null> {
    const results = await this.query<Record<string, T>>(sqlQuery, params);
    if (results.length === 0) return null;
    const firstRow = results[0];
    if (!firstRow) return null;
    const keys = Object.keys(firstRow);
    return keys.length > 0 ? firstRow[keys[0]!]! : null;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  /**
   * Execute a statement (INSERT/UPDATE/DELETE) without returning rows
   */
  async execute(sqlStatement: string, params?: unknown[]): Promise<ExecuteResult> {
    if (!this.pool) throw new Error('Not connected');

    const run = async (request: sql.Request): Promise<ExecuteResult> => {
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await this.runWithTimeout(request, () => request.query(sqlStatement));
      return { rowsAffected: result.rowsAffected.reduce((sum, n) => sum + n, 0) };
    };

    if (this.transaction) return run(this.transaction.request());
    // No auto-retry for a write. An autocommit INSERT/UPDATE/DELETE can commit on
    // the server and then have its ack lost (a socket reset arrives after the
    // commit), which is indistinguishable from "never ran" at the driver level -
    // so retrying could double-apply. The caller must decide whether re-running
    // is safe.
    return this.lock.read(() => run(this.pool!.request()));
  }

  /**
   * Execute an INSERT statement and return the inserted ID(s)
   * The SQL should include OUTPUT INSERTED.OBJECTID (or similar)
   */
  async executeInsert(sqlStatement: string, params?: unknown[]): Promise<number[]> {
    if (!this.pool) throw new Error('Not connected');

    const run = async (request: sql.Request): Promise<number[]> => {
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await this.runWithTimeout(request, () => request.query(sqlStatement));
      // Extract OBJECTID from recordset (OUTPUT INSERTED.OBJECTID)
      if (result.recordset && result.recordset.length > 0) {
        return result.recordset.map((row: Record<string, unknown>) => {
          const id = row.OBJECTID ?? row.objectid ?? row.id ?? row.ID;
          return typeof id === 'number' ? id : parseInt(String(id), 10);
        });
      }
      return [];
    };

    if (this.transaction) return run(this.transaction.request());
    // No auto-retry for a write (see execute()).
    return this.lock.read(() => run(this.pool!.request()));
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(options?: { isolation?: 'serializable' }): Promise<void> {
    if (!this.pool) throw new Error('Not connected');
    // Guard re-entrant begin BEFORE taking the lock: the write lock is not
    // reentrant, so an owner that re-begins would self-deadlock. Callers guard
    // with inTransaction(); this is the last-resort check.
    if (this.transaction) throw new Error('Transaction already in progress');

    // Hold the connection exclusively for the whole transaction. Acquire the
    // lock before assigning `this.transaction` so no reader observes it mid-open.
    await this.lock.acquireWrite();
    try {
      const isoLevel = options?.isolation === 'serializable'
        ? sql.ISOLATION_LEVEL.SERIALIZABLE
        : undefined;
      this.transaction = await this.beginWithRetry(isoLevel);
    } catch (err) {
      // begin() failed — release the lock so the connection isn't stranded.
      this.lock.releaseWrite();
      throw err;
    }
  }

  // Open a transaction, retrying ONCE only when the failure dropped the
  // connection. On a dropped connection SQL Server auto-rolls-back any BEGIN it
  // had started, so nothing is left applied and re-beginning on a fresh
  // connection is safe. A request-timeout is deliberately NOT retried: the
  // connection may survive with BEGIN TRAN already open, and starting a second
  // transaction would leave the first connection poisoned (an inherited open
  // transaction holding locks) back in the pool.
  private async beginWithRetry(isoLevel: number | undefined): Promise<sql.Transaction> {
    const start = async (): Promise<sql.Transaction> => {
      const tx = new sql.Transaction(this.pool!);
      if (isoLevel !== undefined) await tx.begin(isoLevel);
      else await tx.begin();
      return tx;
    };
    try {
      return await start();
    } catch (err) {
      if (classifyConnError(err) !== 'connection') throw err;
      await this.reestablishIfDown();
      await delay(300);
      return start();
    }
  }

  /**
   * Commit the current transaction
   */
  async commitTransaction(): Promise<void> {
    if (!this.transaction) throw new Error('No transaction in progress');
    const tx = this.transaction;
    try {
      await this.endTransaction(tx, 'commit');
    } finally {
      // Clear the slot BEFORE releasing so a freshly-woken reader never routes
      // into a finished transaction; release even if commit threw so a driver
      // error can't freeze the connection forever.
      this.transaction = null;
      this.lock.releaseWrite();
    }
  }

  /**
   * Rollback the current transaction
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.transaction) throw new Error('No transaction in progress');
    const tx = this.transaction;
    try {
      await this.endTransaction(tx, 'rollback');
    } finally {
      this.transaction = null;
      this.lock.releaseWrite();
    }
  }

  /**
   * Commit or roll back `tx`, making sure the server-side transaction really
   * ends, and that the connection it ran on never goes back into the pool with
   * that transaction still open. A pooled session holding locks blocks every
   * other session that needs those rows.
   *
   * Two ways the driver leaves that behind. It refuses both commit and rollback
   * while a request is still active on the transaction (EREQINPROG - what a
   * just-canceled statement looks like for a moment), sending nothing to the
   * server and keeping the connection borrowed; retrying clears that once the
   * request unwinds. And when an attempt does reach the server and fails, it
   * releases the connection to the pool regardless, open transaction and all.
   *
   * So a failure to end the transaction closes the connection, which makes the
   * server roll back and frees the locks. That is safe whichever way the failure
   * went: a commit that never reached the server committed nothing, and one that
   * did land is already durable, so closing the socket afterward loses no write.
   * The one exception is a transaction the server already rolled back itself;
   * see dropTransactionConnection.
   */
  private async endTransaction(tx: sql.Transaction, kind: 'commit' | 'rollback'): Promise<void> {
    // Captured up front: the driver nulls its own reference before the failure
    // reaches us, so after the fact there would be nothing left to close.
    const borrowed = borrowedConnection(tx);
    let lastErr: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        if (kind === 'commit') await tx.commit();
        else await tx.rollback();
        return;
      } catch (err) {
        lastErr = err;
        if (!isRequestInProgress(err) || attempt >= TX_END_RETRIES) break;
        await delay(TX_END_RETRY_MS);
      }
    }
    dropTransactionConnection(tx, borrowed, lastErr);
    throw lastErr;
  }

  /**
   * Check if currently in a transaction
   */
  inTransaction(): boolean {
    return this.transaction !== null;
  }
}
