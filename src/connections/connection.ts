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

  /** Close the connection */
  close(): Promise<void>;

  /** Check if connected */
  readonly isConnected: boolean;

  /** Get the database driver type */
  readonly driver: 'sqlserver' | 'postgresql';
}
