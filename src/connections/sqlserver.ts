/**
 * SQL Server connection implementation
 */
import sql from 'mssql';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { SqlServerConfig } from '../types';
import { RwLock } from '../utils/rw-lock';

export class SqlServerConnection implements IDatabaseConnection {
  private pool: sql.ConnectionPool | null = null;
  private config: sql.config;
  private transaction: sql.Transaction | null = null;

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
      pool: { max: 20, min: 0, idleTimeoutMillis: 30000 },
    };
  }

  get isConnected(): boolean {
    return this.pool?.connected ?? false;
  }

  async connect(): Promise<void> {
    this.pool = await sql.connect(this.config);
  }

  async query<T>(sqlQuery: string, params?: unknown[]): Promise<T[]> {
    if (!this.pool) throw new Error('Not connected');

    // Inside our own transaction: run on it directly (we hold the write lock).
    if (this.transaction) {
      const request = this.transaction.request();
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await request.query(sqlQuery);
      return result.recordset as T[];
    }
    // Otherwise take the shared lock so we can't run while a transaction is open.
    return this.lock.read(async () => {
      const request = this.pool!.request();
      if (params) params.forEach((p, i) => request.input(`p${i}`, p));
      const result = await request.query(sqlQuery);
      return result.recordset as T[];
    });
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
      const tx = new sql.Transaction(this.pool);
      const isoLevel = options?.isolation === 'serializable'
        ? sql.ISOLATION_LEVEL.SERIALIZABLE
        : undefined;
      if (isoLevel !== undefined) {
        await tx.begin(isoLevel);
      } else {
        await tx.begin();
      }
      this.transaction = tx;
    } catch (err) {
      // begin() failed — release the lock so the connection isn't stranded.
      this.lock.releaseWrite();
      throw err;
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
