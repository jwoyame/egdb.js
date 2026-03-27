/**
 * Result of an execute (INSERT/UPDATE/DELETE) operation
 */
export interface ExecuteResult {
  /** Number of rows affected by the operation */
  rowsAffected: number;
  /** For INSERT with OUTPUT/RETURNING, the inserted row(s) */
  insertedIds?: number[];
}

/**
 * Abstract database connection interface
 */
export interface IDatabaseConnection {
  /** Connect to the database */
  connect(): Promise<void>;

  /** Execute a query and return results */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;

  /** Stream query results */
  stream(
    sql: string,
    params?: unknown[]
  ): AsyncIterable<Record<string, unknown>>;

  /** Get a single value */
  scalar<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Execute a statement (INSERT/UPDATE/DELETE) without returning rows
   * @returns ExecuteResult with rowsAffected count
   */
  execute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /**
   * Execute an INSERT statement and return the inserted ID(s)
   * Uses OUTPUT INSERTED.OBJECTID for SQL Server, RETURNING for PostgreSQL
   */
  executeInsert(sql: string, params?: unknown[]): Promise<number[]>;

  /** Begin a transaction */
  beginTransaction(): Promise<void>;

  /** Commit the current transaction */
  commitTransaction(): Promise<void>;

  /** Rollback the current transaction */
  rollbackTransaction(): Promise<void>;

  /** Check if currently in a transaction */
  inTransaction(): boolean;

  /** Close the connection */
  close(): Promise<void>;

  /** Check if connected */
  readonly isConnected: boolean;

  /** Get the database driver type */
  readonly driver: 'sqlserver' | 'postgresql';
}
