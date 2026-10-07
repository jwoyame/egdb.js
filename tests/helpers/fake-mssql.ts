/**
 * A stand-in for the parts of the `mssql` module that SqlServerConnection uses,
 * for tests that drive the real connection code from concurrent call chains.
 *
 * It enforces the driver rule that causes EREQINPROG: a transaction runs one
 * request at a time, and commit/rollback fail while a request is active (see
 * node_modules/mssql/lib/base/transaction.js). Every statement is logged with
 * the transaction it ran on (or null for the pool) and a caller-chosen tag, and
 * every EREQINPROG is counted, so a test can assert both routing and that no
 * overlap ever happened.
 *
 * Use with:
 *   vi.mock('mssql', async () => (await import('./helpers/fake-mssql')).mockModule);
 * then attach a pool with `attachFakePool(conn, db)`.
 */

export interface StatementResult {
  recordset?: unknown[];
  rowsAffected?: number[];
}

/** Decides each statement's result; may await to simulate a slow statement. */
export type StatementHandler = (sqlText: string, ctx: { tx: FakeTransaction | null; request: FakeRequest }) => Promise<StatementResult>;

export interface LogEntry {
  sql: string;
  /** Id of the transaction it ran on, or null for a pooled request. */
  tx: number | null;
}

export class FakeDb {
  readonly log: LogEntry[] = [];
  readonly transactions: FakeTransaction[] = [];
  /** EREQINPROG errors thrown so far (any is a failure of the code under test). */
  overlaps = 0;
  closed = false;
  constructor(public handler: StatementHandler = async () => ({ recordset: [], rowsAffected: [0] })) {}
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function driverError(name: string, code: string, message: string): Error {
  const err = new Error(message) as Error & { code: string };
  err.name = name;
  err.code = code;
  return err;
}

let nextTxId = 1;

export class FakeRequest {
  readonly inputs = new Map<string, unknown>();
  canceled = false;
  // Rejects the in-flight query, the way a real cancel makes mssql reject it.
  private onCancel: (() => void) | null = null;

  constructor(private readonly db: FakeDb, private readonly tx: FakeTransaction | null) {}

  input(name: string, value: unknown): this {
    this.inputs.set(name, value);
    return this;
  }

  cancel(): void {
    this.canceled = true;
    this.onCancel?.();
  }

  /** Run `work` but reject early (ECANCEL) if cancel() is called. */
  cancelable<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.onCancel = () => setTimeout(() => reject(driverError('RequestError', 'ECANCEL', 'Canceled.')), 5);
      work.then(resolve, reject);
    });
  }

  async query(sqlText: string): Promise<StatementResult> {
    if (this.tx) return this.tx.run(sqlText, this);
    this.db.log.push({ sql: sqlText, tx: null });
    await tick();
    return this.db.handler(sqlText, { tx: null, request: this });
  }
}

export class FakeTransaction {
  readonly id = nextTxId++;
  state: 'new' | 'open' | 'committed' | 'rolledback' = 'new';
  isolation: number | undefined;
  private active = false;
  private readonly db: FakeDb;

  constructor(pool: { db: FakeDb }) {
    this.db = pool.db;
    this.db.transactions.push(this);
  }

  async begin(isolation?: number): Promise<void> {
    await tick();
    this.isolation = isolation;
    this.state = 'open';
  }

  request(): FakeRequest {
    return new FakeRequest(this.db, this);
  }

  async run(sqlText: string, request: FakeRequest): Promise<StatementResult> {
    if (this.state !== 'open') throw driverError('TransactionError', 'ENOTBEGUN', 'Transaction has not begun.');
    if (this.active) {
      this.db.overlaps++;
      throw driverError('TransactionError', 'EREQINPROG', "Can't acquire connection for the request. There is another request in progress.");
    }
    this.active = true;
    this.db.log.push({ sql: sqlText, tx: this.id });
    try {
      await tick();
      return await this.db.handler(sqlText, { tx: this, request });
    } finally {
      this.active = false;
    }
  }

  async commit(): Promise<void> {
    await this.end('committed', 'commit');
  }

  async rollback(): Promise<void> {
    await this.end('rolledback', 'rollback');
  }

  private async end(to: 'committed' | 'rolledback', verb: string): Promise<void> {
    if (this.state !== 'open') throw driverError('TransactionError', 'ENOTBEGUN', 'Transaction has not begun.');
    if (this.active) {
      this.db.overlaps++;
      throw driverError('TransactionError', 'EREQINPROG', `Can't ${verb} transaction. There is a request in progress.`);
    }
    await tick();
    this.state = to;
  }
}

/** The mocked `mssql` module (only what sqlserver.ts touches). */
export const mockModule = {
  default: {
    Transaction: FakeTransaction,
    ISOLATION_LEVEL: { READ_COMMITTED: 2, SERIALIZABLE: 4 },
    connect: async () => {
      throw new Error('fake mssql: attach a pool with attachFakePool() instead of connect()');
    },
    ConnectionPool: class {
      constructor() {
        throw new Error('fake mssql: attach a pool with attachFakePool() instead of connect()');
      }
    },
  },
};

/**
 * Give `conn` a fake connected pool backed by `db`. Like a real pool, close()
 * does not finish while a transaction still holds one of its connections.
 */
export function attachFakePool(conn: object, db: FakeDb): void {
  (conn as { pool: unknown }).pool = {
    db,
    connected: true,
    request: () => new FakeRequest(db, null),
    close: async () => {
      while (db.transactions.some((t) => t.state === 'open')) await sleep(5);
      db.closed = true;
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
