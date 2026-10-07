/**
 * A connection proxy that simulates a process crash mid-compress by counting
 * mutating statements and throwing right AFTER the Nth one completes
 * (COMPRESS_HARDENING_PLAN.md §6 Layer 2 "deterministic crash injection").
 *
 * Throwing *after* the underlying call returns is the nasty case: if the Nth
 * step is a commit, the DB has durably committed but the process dies before
 * recording progress — a re-run must resume safely. If it is an `execute` inside
 * an open transaction, the throw propagates out of the withTransaction callback,
 * which rolls the transaction back (modelling the DB aborting an in-flight
 * transaction when its client disconnects).
 *
 * Only mutating / transaction-boundary calls are counted (execute, executeInsert,
 * and the commit at the end of a withTransaction that opened a transaction) —
 * read-only queries can't leave partial state, and counting them would explode
 * the injection space without adding coverage.
 */
import type { IDatabaseConnection, ExecuteResult } from '../../src/connections/connection';

export class CrashInjected extends Error {
  constructor(public readonly step: number, public readonly kind: string) {
    super(`injected crash after step ${step} (${kind})`);
    this.name = 'CrashInjected';
  }
}

export class CrashConnection implements IDatabaseConnection {
  private step = 0;
  /** kind of each counted step, for reporting which points were commits. */
  readonly trace: string[] = [];

  /** @param target throw after this many mutating steps; Infinity = never. */
  constructor(private readonly inner: IDatabaseConnection, private readonly target = Infinity) {}

  get stepsExecuted(): number { return this.step; }

  private tick(kind: string): void {
    this.step++;
    this.trace.push(kind);
    if (this.step === this.target) throw new CrashInjected(this.step, kind);
  }

  async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
    const r = await this.inner.execute(sql, params);
    this.tick('execute');
    return r;
  }
  async executeInsert(sql: string, params?: unknown[]): Promise<number[]> {
    const r = await this.inner.executeInsert(sql, params);
    this.tick('executeInsert');
    return r;
  }
  async withTransaction<T>(fn: () => Promise<T>, options?: { isolation?: 'serializable' }): Promise<T> {
    // A call that joins the caller's transaction doesn't commit anything.
    const opensTransaction = !this.inner.inTransaction();
    const result = await this.inner.withTransaction(fn, options);
    if (opensTransaction) this.tick('commit');
    return result;
  }

  // --- pass-throughs (not counted) ------------------------------------------
  connect(): Promise<void> { return this.inner.connect(); }
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> { return this.inner.query<T>(sql, params); }
  stream(sql: string, params?: unknown[]): AsyncIterable<Record<string, unknown>> { return this.inner.stream(sql, params); }
  scalar<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> { return this.inner.scalar<T>(sql, params); }
  inTransaction(): boolean { return this.inner.inTransaction(); }
  close(): Promise<void> { return this.inner.close(); }
  get isConnected(): boolean { return this.inner.isConnected; }
  get driver(): 'sqlserver' | 'postgresql' { return this.inner.driver; }
}
