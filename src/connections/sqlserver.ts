/**
 * SQL Server connection implementation
 */
import sql from 'mssql';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { SqlServerConfig } from '../types';
import { RwLock } from '../utils/rw-lock';
import { ownsToken, runAsOwner } from './tx-ownership';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const ignore = (): void => {};

// Per-statement timeouts set by withStatementTimeout(), keyed by connection and
// scoped to the call tree of the callback passed to it. Scoping by call tree
// (not a field on the connection) keeps one caller's timeout from arming, or
// being cleared by, another concurrent caller on the same connection.
const statementTimeouts = new AsyncLocalStorage<ReadonlyMap<SqlServerConnection, number>>();

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
  // The open transaction, if any, and the token of the call tree that owns it
  // (see tx-ownership.ts). Both are set together and cleared together.
  private transaction: sql.Transaction | null = null;
  private txToken: object | null = null;
  // When true, this connection owns a PRIVATE ConnectionPool instead of mssql's
  // process-global one — so closing it doesn't close every other egdb connection.
  // Required for the compress exclusive-lock holder, which opens/closes its own
  // dedicated connection while the main connection stays live.
  private readonly dedicatedPool: boolean;

  // Allows one transaction at a time on this connection (used in write mode
  // only). A second withTransaction() waits here until the first one ends.
  // Statements from callers that don't own the transaction never wait on it:
  // they run on their own pooled connection. That matters because an owner can
  // await work a non-owner started (for example a shared openTable() load); if
  // that work waited for the owner to finish, neither would ever finish.
  private txLock = new RwLock();

  // Tail of the queue of statements on the open transaction. mssql allows one
  // request at a time on a transaction and throws EREQINPROG otherwise, so the
  // owner's own concurrent statements (e.g. a Promise.all inside the callback)
  // and the final commit/rollback run one after another. Each entry settles
  // only when its driver request settles, even if a statement timeout already
  // rejected it, so a rollback never starts while a canceled request is still
  // active.
  private txTail: Promise<void> = Promise.resolve();

  readonly driver = 'sqlserver' as const;

  /**
   * Run `fn` with a per-statement timeout applied to this connection's
   * IN-TRANSACTION execute/executeInsert/query requests made from `fn`'s call
   * tree (see runWithTimeout). It does not cover streaming reads or the COMMIT
   * statement, and it has no effect on pooled statements or on other callers.
   */
  async withStatementTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
    const next = new Map(statementTimeouts.getStore());
    next.set(this, ms);
    return statementTimeouts.run(next, fn);
  }

  // Race a driver request against the caller's statement timeout, if one is
  // set. mssql has no per-request timeout, so we enforce it by cancelling the
  // request (an attention token) when the timer fires and rejecting with an
  // ETIMEOUT RequestError, which classifyConnError treats as a request-timeout.
  private async runWithTimeout<T>(request: sql.Request, driverCall: Promise<T>): Promise<T> {
    const ms = statementTimeouts.getStore()?.get(this);
    if (ms == null) return driverCall;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { request.cancel(); } catch { /* already done */ }
        const err = new Error(`Statement canceled after ${ms}ms (edit fast-fail timeout)`) as Error & { code: string; name: string };
        err.code = 'ETIMEOUT';
        err.name = 'RequestError';
        reject(err);
      }, ms);
    });
    try {
      return await Promise.race([driverCall, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Run one statement on the open transaction, after any earlier ones settle.
  private runOnTransaction<T>(
    tx: sql.Transaction,
    params: unknown[] | undefined,
    exec: (request: sql.Request) => Promise<T>,
  ): Promise<T> {
    const started = this.txTail.then(() => {
      const request = tx.request();
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const driverCall = exec(request);
      return { driverCall, result: this.runWithTimeout(request, driverCall) };
    });
    this.txTail = started.then(({ driverCall }) => driverCall.then(ignore, ignore), ignore);
    return started.then(({ result }) => result);
  }

  // The open transaction if the caller owns it, else null.
  private ownedTransaction(): sql.Transaction | null {
    return this.transaction !== null && ownsToken(this.txToken) ? this.transaction : null;
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

  // Run an idempotent READ op on the pool, retrying ONCE through a transient
  // connection blip. Only pooled reads use this -- writes never auto-retry (a
  // commit's ack can be lost, making a retry a double-apply), and statements on
  // a transaction never retry (a lost connection there dooms the whole
  // transaction, and the caller must roll back and re-run it).
  // `retryRequestTimeout` is true for reads so a slow-then-timed-out read also
  // retries.
  private async withConnRetry<T>(op: () => Promise<T>, retryRequestTimeout: boolean): Promise<T> {
    try {
      return await op();
    } catch (err) {
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

    // Only the transaction's owner runs on it. Everyone else uses the pool.
    const tx = this.ownedTransaction();
    if (tx) {
      const result = await this.runOnTransaction(tx, params, (request) => request.query(sqlQuery));
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
    if (opts?.mutating) return op();
    return this.withConnRetry(op, true);
  }

  async *stream(
    sqlQuery: string,
    params?: unknown[]
  ): AsyncIterable<Record<string, unknown>> {
    if (!this.pool) throw new Error('Not connected');

    // Always stream on a fresh pooled request, even for the transaction's
    // owner. A long generator driven by network backpressure must not sit on
    // the transaction (it would block the owner's other statements for the
    // stream's whole lifetime). Reads see committed data under READ COMMITTED;
    // that's the same isolation the postgres driver's cursor stream uses.
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

    const toResult = (result: sql.IResult<unknown>): ExecuteResult => ({
      rowsAffected: result.rowsAffected.reduce((sum, n) => sum + n, 0),
    });

    const tx = this.ownedTransaction();
    if (tx) return toResult(await this.runOnTransaction(tx, params, (request) => request.query(sqlStatement)));
    // No auto-retry for a write. An autocommit INSERT/UPDATE/DELETE can commit on
    // the server and then have its ack lost (a socket reset arrives after the
    // commit), which is indistinguishable from "never ran" at the driver level -
    // so retrying could double-apply. The caller must decide whether re-running
    // is safe.
    const request = this.pool.request();
    if (params) params.forEach((p, i) => request.input(`p${i}`, p));
    return toResult(await request.query(sqlStatement));
  }

  /**
   * Execute an INSERT statement and return the inserted ID(s)
   * The SQL should include OUTPUT INSERTED.OBJECTID (or similar)
   */
  async executeInsert(sqlStatement: string, params?: unknown[]): Promise<number[]> {
    if (!this.pool) throw new Error('Not connected');

    // Extract OBJECTID from recordset (OUTPUT INSERTED.OBJECTID)
    const toIds = (result: sql.IResult<Record<string, unknown>>): number[] => {
      if (result.recordset && result.recordset.length > 0) {
        return result.recordset.map((row: Record<string, unknown>) => {
          const id = row.OBJECTID ?? row.objectid ?? row.id ?? row.ID;
          return typeof id === 'number' ? id : parseInt(String(id), 10);
        });
      }
      return [];
    };

    const tx = this.ownedTransaction();
    if (tx) return toIds(await this.runOnTransaction(tx, params, (request) => request.query<Record<string, unknown>>(sqlStatement)));
    // No auto-retry for a write (see execute()).
    const request = this.pool.request();
    if (params) params.forEach((p, i) => request.input(`p${i}`, p));
    return toIds(await request.query<Record<string, unknown>>(sqlStatement));
  }

  /**
   * Run `fn` inside a transaction on this connection. Commits when `fn`
   * resolves and rolls back when it rejects; the rejection is passed on and a
   * rollback failure is ignored so it can't hide it.
   *
   * Only `fn`'s call tree owns the transaction (see tx-ownership.ts): its
   * statements run on the transaction, while statements from any other caller
   * on this connection keep using the pool. If the caller already owns an open
   * transaction here, `fn` simply runs inside it (`options` is then ignored).
   * Otherwise this waits until no other transaction is open on this connection.
   */
  async withTransaction<T>(fn: () => Promise<T>, options?: { isolation?: 'serializable' }): Promise<T> {
    if (!this.pool) throw new Error('Not connected');
    if (this.ownedTransaction()) return fn();

    await this.txLock.acquireWrite();
    let tx: sql.Transaction;
    try {
      const isoLevel = options?.isolation === 'serializable'
        ? sql.ISOLATION_LEVEL.SERIALIZABLE
        : undefined;
      tx = await this.beginWithRetry(isoLevel);
    } catch (err) {
      // begin() failed — release the lock so the connection isn't stranded.
      this.txLock.releaseWrite();
      throw err;
    }
    const token = {};
    this.transaction = tx;
    this.txToken = token;
    this.txTail = Promise.resolve();

    let result: T;
    try {
      result = await runAsOwner(token, fn);
    } catch (err) {
      try { await this.endTransaction(tx, 'rollback'); } catch { /* pass on the original error */ }
      throw err;
    }
    await this.endTransaction(tx, 'commit');
    return result;
  }

  // Commit or roll back `tx` once its queued statements settle, then free the
  // slot. The slot is cleared before the lock is released so a waiting
  // transaction never sees the finished one, and both happen even if the
  // driver call throws so a driver error can't freeze the connection.
  private async endTransaction(tx: sql.Transaction, how: 'commit' | 'rollback'): Promise<void> {
    const ending = this.txTail.then(() => (how === 'commit' ? tx.commit() : tx.rollback()));
    this.txTail = ending.then(ignore, ignore);
    try {
      await ending;
    } finally {
      this.transaction = null;
      this.txToken = null;
      this.txLock.releaseWrite();
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
   * True when a transaction is open on this connection AND the caller's call
   * tree owns it (it runs inside that transaction's withTransaction callback).
   * A transaction opened by another concurrent caller reports false.
   */
  inTransaction(): boolean {
    return this.ownedTransaction() !== null;
  }
}
