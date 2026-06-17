/**
 * PostgreSQL connection implementation
 */
import { Pool, PoolClient, PoolConfig } from 'pg';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { PostgreSQLConfig } from '../types';
import { RwLock } from '../utils/rw-lock';

export class PostgreSQLConnection implements IDatabaseConnection {
  private pool: Pool | null = null;
  private config: PoolConfig;
  private _isConnected = false;
  private transactionClient: PoolClient | null = null;

  // See SqlServerConnection / utils/rw-lock.ts: a transaction holds the single
  // `transactionClient` slot exclusively; plain statements take a shared lock so
  // they can't run on it concurrently. The owner's in-transaction statements
  // bypass it. stream() uses its own dedicated client, so it isn't locked.
  private lock = new RwLock();

  readonly driver = 'postgresql' as const;

  constructor(config: PostgreSQLConfig) {
    this.config = {
      host: config.server,
      port: config.port ?? 5432,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      connectionTimeoutMillis: config.options?.connectionTimeout ?? 30000,
      query_timeout: config.options?.requestTimeout ?? 30000,
      // Headroom for concurrent streaming reads + a write transaction on a
      // shared single-login server (pg pool default max is 10). See sqlserver.ts.
      max: 20,
    };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    this.pool = new Pool(this.config);

    // Test the connection
    const client = await this.pool.connect();
    client.release();
    this._isConnected = true;
  }

  async query<T>(sqlQuery: string, params?: unknown[]): Promise<T[]> {
    if (!this.pool) throw new Error('Not connected');

    // Convert @p0, @p1 parameter syntax to $1, $2 for PostgreSQL
    const pgQuery = sqlQuery.replace(/@p(\d+)/g, (_, num) => `$${parseInt(num, 10) + 1}`);

    if (this.transactionClient) {
      const result = await this.transactionClient.query(pgQuery, params);
      return result.rows as T[];
    }
    return this.lock.read(async () => {
      const result = await this.pool!.query(pgQuery, params);
      return result.rows as T[];
    });
  }

  async *stream(
    sqlQuery: string,
    params?: unknown[]
  ): AsyncIterable<Record<string, unknown>> {
    if (!this.pool) throw new Error('Not connected');

    // Convert parameter syntax
    const pgQuery = sqlQuery.replace(/@p(\d+)/g, (_, num) => `$${parseInt(num, 10) + 1}`);

    // Use cursor for streaming
    const client = await this.pool.connect();

    const cursorName = `egdb_cursor_${Date.now()}`;
    let cursorOpen = false;
    let exhausted = false;
    try {
      await client.query('BEGIN');
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${pgQuery}`, params);
      cursorOpen = true;

      const batchSize = 100;

      while (true) {
        const result = await client.query(`FETCH ${batchSize} FROM ${cursorName}`);

        if (result.rows.length === 0) {
          exhausted = true;
          break;
        }

        for (const row of result.rows) {
          yield row as Record<string, unknown>;
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      cursorOpen = false;
      await client.query('COMMIT');
    } finally {
      // If the consumer broke out early (return/throw mid-stream), the cursor
      // and transaction are still open on this client. Close the cursor and
      // ROLLBACK before release - leaving the client dirty would poison the
      // pool and a follow-up rollback on the outer connection would surface
      // weird state.
      if (!exhausted) {
        try {
          if (cursorOpen) await client.query(`CLOSE ${cursorName}`);
          await client.query('ROLLBACK');
        } catch {
          // Best-effort cleanup; ignore.
        }
      }
      client.release();
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
      await this.pool.end();
      this.pool = null;
      this._isConnected = false;
    }
  }

  /**
   * Execute a statement (INSERT/UPDATE/DELETE) without returning rows
   */
  async execute(sqlStatement: string, params?: unknown[]): Promise<ExecuteResult> {
    if (!this.pool) throw new Error('Not connected');

    // Convert @p0, @p1 parameter syntax to $1, $2 for PostgreSQL
    const pgQuery = sqlStatement.replace(/@p(\d+)/g, (_, num) => `$${parseInt(num, 10) + 1}`);

    if (this.transactionClient) {
      const result = await this.transactionClient.query(pgQuery, params);
      return { rowsAffected: result.rowCount ?? 0 };
    }
    return this.lock.read(async () => {
      const result = await this.pool!.query(pgQuery, params);
      return { rowsAffected: result.rowCount ?? 0 };
    });
  }

  /**
   * Execute an INSERT statement and return the inserted ID(s)
   * The SQL should include RETURNING objectid (or similar)
   */
  async executeInsert(sqlStatement: string, params?: unknown[]): Promise<number[]> {
    if (!this.pool) throw new Error('Not connected');

    // Convert parameter syntax
    const pgQuery = sqlStatement.replace(/@p(\d+)/g, (_, num) => `$${parseInt(num, 10) + 1}`);

    const extract = (rows: Record<string, unknown>[]): number[] => {
      if (rows && rows.length > 0) {
        return rows.map((row) => {
          const id = row.objectid ?? row.OBJECTID ?? row.id ?? row.ID;
          return typeof id === 'number' ? id : parseInt(String(id), 10);
        });
      }
      return [];
    };

    if (this.transactionClient) {
      const result = await this.transactionClient.query(pgQuery, params);
      return extract(result.rows);
    }
    return this.lock.read(async () => {
      const result = await this.pool!.query(pgQuery, params);
      return extract(result.rows);
    });
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(options?: { isolation?: 'serializable' }): Promise<void> {
    if (!this.pool) throw new Error('Not connected');
    // Guard re-entrant begin before taking the (non-reentrant) write lock.
    if (this.transactionClient) throw new Error('Transaction already in progress');

    await this.lock.acquireWrite();
    try {
      const client = await this.pool.connect();
      try {
        if (options?.isolation === 'serializable') {
          await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        } else {
          await client.query('BEGIN');
        }
      } catch (err) {
        client.release();
        throw err;
      }
      this.transactionClient = client;
    } catch (err) {
      this.lock.releaseWrite();
      throw err;
    }
  }

  /**
   * Commit the current transaction
   */
  async commitTransaction(): Promise<void> {
    if (!this.transactionClient) throw new Error('No transaction in progress');
    const client = this.transactionClient;
    try {
      await client.query('COMMIT');
    } finally {
      // Clear the slot before releasing the lock; always release so a driver
      // error can't strand the connection.
      client.release();
      this.transactionClient = null;
      this.lock.releaseWrite();
    }
  }

  /**
   * Rollback the current transaction
   */
  async rollbackTransaction(): Promise<void> {
    if (!this.transactionClient) throw new Error('No transaction in progress');
    const client = this.transactionClient;
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
      this.transactionClient = null;
      this.lock.releaseWrite();
    }
  }

  /**
   * Check if currently in a transaction
   */
  inTransaction(): boolean {
    return this.transactionClient !== null;
  }
}
