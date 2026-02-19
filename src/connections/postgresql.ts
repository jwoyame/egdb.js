/**
 * PostgreSQL connection implementation
 */
import { Pool, PoolConfig } from 'pg';
import type { IDatabaseConnection } from './connection';
import type { PostgreSQLConfig } from '../types';

export class PostgreSQLConnection implements IDatabaseConnection {
  private pool: Pool | null = null;
  private config: PoolConfig;
  private _isConnected = false;

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

    const result = await this.pool.query(pgQuery, params);
    return result.rows as T[];
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

    try {
      // Use a cursor name based on timestamp to avoid conflicts
      const cursorName = `egdb_cursor_${Date.now()}`;

      await client.query('BEGIN');
      await client.query(`DECLARE ${cursorName} CURSOR FOR ${pgQuery}`, params);

      const batchSize = 100;

      while (true) {
        const result = await client.query(`FETCH ${batchSize} FROM ${cursorName}`);

        if (result.rows.length === 0) {
          break;
        }

        for (const row of result.rows) {
          yield row as Record<string, unknown>;
        }
      }

      await client.query(`CLOSE ${cursorName}`);
      await client.query('COMMIT');
    } finally {
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
}
