/**
 * SQL Server connection implementation
 */
import sql from 'mssql';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { SqlServerConfig } from '../types';

export class SqlServerConnection implements IDatabaseConnection {
  private pool: sql.ConnectionPool | null = null;
  private config: sql.config;
  private transaction: sql.Transaction | null = null;

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

    const request = this.transaction
      ? this.transaction.request()
      : this.pool.request();

    // Add parameters
    if (params) {
      params.forEach((param, index) => {
        request.input(`p${index}`, param);
      });
    }

    const result = await request.query(sqlQuery);
    return result.recordset as T[];
  }

  async *stream(
    sqlQuery: string,
    params?: unknown[]
  ): AsyncIterable<Record<string, unknown>> {
    if (!this.pool) throw new Error('Not connected');

    const request = this.transaction
      ? this.transaction.request()
      : this.pool.request();
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
      push({ type: 'error', error: err });
    });

    request.on('done', () => {
      push({ type: 'done' });
    });

    // Start the query
    request.query(sqlQuery);

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

    const request = this.transaction
      ? this.transaction.request()
      : this.pool.request();

    if (params) {
      params.forEach((param, index) => {
        request.input(`p${index}`, param);
      });
    }

    const result = await request.query(sqlStatement);
    return {
      rowsAffected: result.rowsAffected.reduce((sum, n) => sum + n, 0),
    };
  }

  /**
   * Execute an INSERT statement and return the inserted ID(s)
   * The SQL should include OUTPUT INSERTED.OBJECTID (or similar)
   */
  async executeInsert(sqlStatement: string, params?: unknown[]): Promise<number[]> {
    if (!this.pool) throw new Error('Not connected');

    const request = this.transaction
      ? this.transaction.request()
      : this.pool.request();

    if (params) {
      params.forEach((param, index) => {
        request.input(`p${index}`, param);
      });
    }

    const result = await request.query(sqlStatement);

    // Extract OBJECTID from recordset (OUTPUT INSERTED.OBJECTID)
    if (result.recordset && result.recordset.length > 0) {
      return result.recordset.map((row: Record<string, unknown>) => {
        const id = row.OBJECTID ?? row.objectid ?? row.id ?? row.ID;
        return typeof id === 'number' ? id : parseInt(String(id), 10);
      });
    }

    return [];
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(): Promise<void> {
    if (!this.pool) throw new Error('Not connected');
    if (this.transaction) throw new Error('Transaction already in progress');

    this.transaction = new sql.Transaction(this.pool);
    await this.transaction.begin();
  }

  /**
   * Commit the current transaction
   */
  async commitTransaction(): Promise<void> {
    if (!this.transaction) throw new Error('No transaction in progress');

    await this.transaction.commit();
    this.transaction = null;
  }

  /**
   * Rollback the current transaction
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.transaction) throw new Error('No transaction in progress');

    await this.transaction.rollback();
    this.transaction = null;
  }

  /**
   * Check if currently in a transaction
   */
  inTransaction(): boolean {
    return this.transaction !== null;
  }
}
