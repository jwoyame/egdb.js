/**
 * SQL Server connection implementation
 */
import sql from 'mssql';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { SqlServerConfig } from '../types';
import { RwLock } from '../utils/rw-lock';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  readonly driver = 'sqlserver' as const;

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
      const result = await request.query(sqlQuery);
      return result.recordset as T[];
    }
    const op = async (): Promise<T[]> => {
      const request = this.pool!.request();
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await request.query(sqlQuery);
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
      const result = await request.query(sqlStatement);
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
      const result = await request.query(sqlStatement);
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
      await tx.commit();
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
      await tx.rollback();
    } finally {
      this.transaction = null;
      this.lock.releaseWrite();
    }
  }

  /**
   * Check if currently in a transaction
   */
  inTransaction(): boolean {
    return this.transaction !== null;
  }
}
