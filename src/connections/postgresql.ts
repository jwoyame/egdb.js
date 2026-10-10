/**
 * PostgreSQL connection implementation
 */
import { Pool, PoolClient, PoolConfig } from 'pg';
import type { IDatabaseConnection, ExecuteResult } from './connection';
import type { PostgreSQLConfig } from '../types';
import { RwLock } from '../utils/rw-lock';
import { ownsToken, runAsOwner } from './tx-ownership';

export class PostgreSQLConnection implements IDatabaseConnection {
  private pool: Pool | null = null;
  private config: PoolConfig;
  private _isConnected = false;
  // The open transaction's client, if any, and the token of the call tree that
  // owns it (see tx-ownership.ts). Both are set together and cleared together.
  private transactionClient: PoolClient | null = null;
  private txToken: object | null = null;

  // Allows one transaction at a time on this connection (write mode only). See
  // SqlServerConnection.txLock: callers that don't own the transaction use the
  // pool and never wait on it. pg queues a client's queries itself, so the
  // owner's concurrent statements need no extra queue here.
  private txLock = new RwLock();

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

  // opts is accepted for interface parity with the SQL Server driver (its
  // mutating opt-out gates connection-blip retry). This driver does not auto-retry,
  // so opts has no effect here.
  async query<T>(sqlQuery: string, params?: unknown[], _opts?: { mutating?: boolean }): Promise<T[]> {
    if (!this.pool) throw new Error('Not connected');

    // Convert @p0, @p1 parameter syntax to $1, $2 for PostgreSQL
    const pgQuery = sqlQuery.replace(/@p(\d+)/g, (_, num) => `$${parseInt(num, 10) + 1}`);

    // Only the transaction's owner runs on it. Everyone else uses the pool.
    const result = await (this.ownedClient() ?? this.pool).query(pgQuery, params);
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

    const result = await (this.ownedClient() ?? this.pool).query(pgQuery, params);
    return { rowsAffected: result.rowCount ?? 0 };
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

    const result = await (this.ownedClient() ?? this.pool).query(pgQuery, params);
    return extract(result.rows);
  }

  // The open transaction's client if the caller owns it, else null.
  private ownedClient(): PoolClient | null {
    return this.transactionClient !== null && ownsToken(this.txToken) ? this.transactionClient : null;
  }

  /**
   * Run `fn` inside a transaction on this connection. Same contract as
   * SqlServerConnection.withTransaction: commit on resolve, rollback on reject
   * (a failed rollback is logged, and the original error is passed on),
   * only `fn`'s call tree owns the transaction, and a caller that already owns
   * one here just runs `fn` inside it.
   */
  async withTransaction<T>(fn: () => Promise<T>, options?: { isolation?: 'serializable' }): Promise<T> {
    if (!this.pool) throw new Error('Not connected');
    if (this.ownedClient()) return fn();

    await this.txLock.acquireWrite();
    let client: PoolClient;
    try {
      client = await this.pool.connect();
      try {
        await client.query(options?.isolation === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
      } catch (err) {
        client.release();
        throw err;
      }
    } catch (err) {
      this.txLock.releaseWrite();
      throw err;
    }
    const token = {};
    this.transactionClient = client;
    this.txToken = token;

    let result: T;
    try {
      result = await runAsOwner(token, fn);
    } catch (err) {
      try {
        await this.endTransaction(client, 'ROLLBACK');
      } catch (rollbackError) {
        // The client is destroyed either way (see endTransaction), but report
        // the failure without hiding `err`.
        console.error('[egdb] rollback failed while handling an error:', rollbackError);
      }
      throw err;
    }
    await this.endTransaction(client, 'COMMIT');
    return result;
  }

  // Run COMMIT or ROLLBACK, then free the slot. The slot is cleared before the
  // lock is released, and both happen even if the statement throws.
  private async endTransaction(client: PoolClient, how: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    let failed = false;
    try {
      await client.query(how);
    } catch (err) {
      failed = true;
      throw err;
    } finally {
      // A client whose COMMIT/ROLLBACK failed may still be inside a transaction;
      // destroy it instead of returning it to the pool.
      client.release(failed);
      this.transactionClient = null;
      this.txToken = null;
      this.txLock.releaseWrite();
    }
  }

  /**
   * True when a transaction is open on this connection AND the caller's call
   * tree owns it. A transaction opened by another concurrent caller reports
   * false.
   */
  inTransaction(): boolean {
    return this.ownedClient() !== null;
  }
}
