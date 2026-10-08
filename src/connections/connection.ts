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

  /**
   * Execute a query and return results.
   * @param opts.mutating set true when the SQL mutates (e.g. an SDE stored proc
   *   like create_version routed through query()); it then does NOT auto-retry a
   *   connection blip, since re-running a non-idempotent statement could
   *   double-apply. Plain reads (the default) may retry.
   */
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    opts?: { mutating?: boolean }
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

  /**
   * Run `fn` inside a transaction. Commits when `fn` resolves; rolls back and
   * rethrows when it rejects.
   *
   * The connection is shared by concurrent callers, so the transaction belongs
   * to `fn`'s async call tree only: statements made from inside `fn` (including
   * anything it awaits or starts) run on the transaction, and statements from
   * any other caller keep running outside it. There is no separate begin or
   * commit call, so only the code that opened a transaction can end it.
   *
   * If the caller already owns an open transaction on this connection, `fn`
   * runs inside that one and `options` is ignored. Otherwise this waits until
   * no other caller's transaction is open on this connection. So `fn` must not
   * wait for a transaction that a different caller is opening on the same
   * connection: that one cannot start until `fn` ends.
   *
   * @param options.isolation Optional isolation level. 'serializable' maps to
   *   SET TRANSACTION ISOLATION LEVEL SERIALIZABLE (SQL Server) or
   *   BEGIN ISOLATION LEVEL SERIALIZABLE (PostgreSQL). Required by
   *   `graduateTable` so the in-fence subset revalidation and the subsequent
   *   base-table writes form a single critical section against concurrent
   *   `createVersion`.
   */
  withTransaction<T>(fn: () => Promise<T>, options?: { isolation?: 'serializable' }): Promise<T>;

  /**
   * True when the caller is inside a withTransaction callback on this
   * connection whose transaction is still open. A transaction opened by
   * another concurrent caller reports false.
   */
  inTransaction(): boolean;

  /** Close the connection */
  close(): Promise<void>;

  /** Check if connected */
  readonly isConnected: boolean;

  /** Get the database driver type */
  readonly driver: 'sqlserver' | 'postgresql';
}
