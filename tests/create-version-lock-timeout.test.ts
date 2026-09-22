/**
 * `createVersion` must fail fast, and identifiably, when something else holds
 * the locks `sde.create_version` needs.
 *
 * The proc itself is quick (tens of milliseconds). When a lock holder makes it
 * wait, the call must give up in seconds with a LockTimeoutError the caller can
 * tell apart from a genuine failure, and the shortened lock wait must never ride
 * the pooled session back out to later work.
 */
import { describe, it, expect } from 'vitest';
import {
  EnterpriseGeodatabase,
  LockTimeoutError,
  isSqlServerLockTimeout,
  isPostgresLockTimeout,
} from '../src/enterprise-geodatabase';
import type { IDatabaseConnection } from '../src/connections/connection';

/** Records every statement it is asked to run, and answers version lookups. */
class FakeConnection implements IDatabaseConnection {
  readonly statements: string[] = [];
  private tx = false;
  constructor(
    readonly driver: 'sqlserver' | 'postgresql',
    /** Thrown by whichever statement calls sde.create_version. */
    private readonly createVersionError?: unknown,
  ) {}

  async query<T>(sql: string): Promise<T[]> {
    this.statements.push(sql);
    if (/create_version/i.test(sql) && this.createVersionError) throw this.createVersionError;
    if (/sde_versions/i.test(sql)) {
      return [{ name: 'my_edits', owner: 'sde', parent_name: 'sde.DEFAULT', state_id: 7 }] as T[];
    }
    return [] as T[];
  }
  async *stream(): AsyncIterable<Record<string, unknown>> { /* unused */ }
  async scalar<T>(): Promise<T | null> { return null; }
  async execute(): Promise<{ rowsAffected: number }> { return { rowsAffected: 0 }; }
  async executeInsert(): Promise<number[]> { return []; }
  async beginTransaction(): Promise<void> { this.tx = true; }
  async commitTransaction(): Promise<void> { this.tx = false; }
  async rollbackTransaction(): Promise<void> { this.tx = false; }
  inTransaction(): boolean { return this.tx; }
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  get isConnected(): boolean { return true; }
}

function makeGdb(conn: IDatabaseConnection): EnterpriseGeodatabase {
  const Ctor = EnterpriseGeodatabase as unknown as new (c: unknown, conn: unknown) => EnterpriseGeodatabase;
  return new Ctor(
    { driver: conn.driver, server: 's', database: 'd', user: 'sde', password: 'p' },
    conn,
  );
}

/** SQL Server error 1222, as the driver surfaces it. */
const lockTimeout1222 = Object.assign(new Error('Lock request time out period exceeded.'), {
  name: 'RequestError',
  code: 'EREQUEST',
  number: 1222,
});

describe('isSqlServerLockTimeout', () => {
  it('recognizes error 1222 by number, by message, and inside a batch error chain', () => {
    expect(isSqlServerLockTimeout(lockTimeout1222)).toBe(true);
    expect(isSqlServerLockTimeout(new Error('Lock request time out period exceeded.'))).toBe(true);
    expect(isSqlServerLockTimeout({ number: 50000, precedingErrors: [lockTimeout1222] })).toBe(true);
  });

  it('does not fire on any other failure', () => {
    expect(isSqlServerLockTimeout({ number: 1205, message: 'deadlock victim' })).toBe(false);
    expect(isSqlServerLockTimeout(new Error('Invalid object name'))).toBe(false);
    expect(isSqlServerLockTimeout(null)).toBe(false);
    expect(isSqlServerLockTimeout(undefined)).toBe(false);
  });
});

describe('isPostgresLockTimeout', () => {
  it('recognizes 55P03 by code and by message', () => {
    expect(isPostgresLockTimeout({ code: '55P03' })).toBe(true);
    expect(isPostgresLockTimeout(new Error('canceling statement due to lock timeout'))).toBe(true);
  });

  it('does not fire on a statement timeout or other failure', () => {
    expect(isPostgresLockTimeout({ code: '57014', message: 'canceling statement due to statement timeout' })).toBe(false);
    expect(isPostgresLockTimeout({ code: '42P01' })).toBe(false);
    expect(isPostgresLockTimeout(null)).toBe(false);
  });
});

describe('createVersion on SQL Server', () => {
  it('bounds the lock wait in the same batch as the EXEC', async () => {
    const conn = new FakeConnection('sqlserver');
    await makeGdb(conn).createVersion('my_edits');
    const batch = conn.statements.find((s) => /create_version/i.test(s))!;
    // One batch: a pooled session does not carry SET LOCK_TIMEOUT between calls.
    expect(batch).toMatch(/SET LOCK_TIMEOUT \d+/);
    expect(batch).toMatch(/EXEC sde\.create_version/);
    expect(conn.statements.filter((s) => /SET LOCK_TIMEOUT/i.test(s))).toHaveLength(1);
  });

  it('resets the lock wait on the failure path as well as the success path', async () => {
    const conn = new FakeConnection('sqlserver');
    await makeGdb(conn).createVersion('my_edits');
    const batch = conn.statements.find((s) => /create_version/i.test(s))!;
    // Once in TRY, once in CATCH: a session that keeps the shortened wait would
    // poison every later statement that runs on it.
    expect(batch.match(/SET LOCK_TIMEOUT -1/g)).toHaveLength(2);
    // The original error still propagates.
    expect(batch).toMatch(/THROW/);
  });

  it('rolls back a transaction the proc left open, and only one this batch opened', async () => {
    const conn = new FakeConnection('sqlserver');
    await makeGdb(conn).createVersion('my_edits');
    const batch = conn.statements.find((s) => /create_version/i.test(s))!;
    expect(batch).toMatch(/@entryTranCount int = @@TRANCOUNT/);
    expect(batch).toMatch(/IF @entryTranCount = 0 AND @@TRANCOUNT > 0 ROLLBACK TRANSACTION/);
  });

  it('makes a client cancel roll back the proc, and restores XACT_ABORT on both paths', async () => {
    const conn = new FakeConnection('sqlserver');
    await makeGdb(conn).createVersion('my_edits');
    const batch = conn.statements.find((s) => /create_version/i.test(s))!;
    // ON before the EXEC: a cancel mid-proc must not leave the proc's own
    // transaction open on the pooled session.
    expect(batch.indexOf('SET XACT_ABORT ON')).toBeGreaterThan(-1);
    expect(batch.indexOf('SET XACT_ABORT ON')).toBeLessThan(batch.indexOf('EXEC sde.create_version'));
    // Put back to whatever the session had, in TRY and in CATCH.
    expect(batch).toMatch(/@entryXactAbort bit = CASE WHEN \(@@OPTIONS & 16384\) = 16384/);
    expect(batch.match(/IF @entryXactAbort = 0 SET XACT_ABORT OFF/g)).toHaveLength(2);
  });

  it('refuses to run inside an open transaction, before sending anything', async () => {
    // The proc commits every open transaction on the connection, which on a
    // shared connection can be another user's half-finished edit.
    const conn = new FakeConnection('sqlserver');
    await conn.beginTransaction();

    const err = await makeGdb(conn).createVersion('my_edits').catch((e) => e);

    expect(err).toBeInstanceOf(LockTimeoutError);
    // Callers match on the name, so it must stay LockTimeoutError.
    expect((err as Error).name).toBe('LockTimeoutError');
    expect((err as Error).message).toMatch(/another edit is in progress/i);
    expect((err as Error).message).toMatch(/nothing was changed/i);
    expect(conn.statements).toEqual([]);
    expect(conn.inTransaction()).toBe(true); // the other transaction is untouched
  });

  it('reports a blocked create as a LockTimeoutError', async () => {
    const conn = new FakeConnection('sqlserver', lockTimeout1222);
    await expect(makeGdb(conn).createVersion('my_edits')).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('passes a genuine failure through untouched', async () => {
    const real = Object.assign(new Error('Version name already exists'), { number: 50000 });
    const conn = new FakeConnection('sqlserver', real);
    await expect(makeGdb(conn).createVersion('my_edits')).rejects.toThrow('Version name already exists');
    await expect(makeGdb(conn).createVersion('my_edits')).rejects.not.toBeInstanceOf(LockTimeoutError);
  });
});

describe('createVersion on PostgreSQL', () => {
  it('bounds the lock wait inside a transaction, then clears it', async () => {
    const conn = new FakeConnection('postgresql');
    await makeGdb(conn).createVersion('my_edits');
    const sets = conn.statements.filter((s) => /lock_timeout/i.test(s));
    expect(sets[0]).toMatch(/SET LOCAL lock_timeout = \d+/);
    expect(sets[1]).toMatch(/SET LOCAL lock_timeout = 0/);
    expect(conn.inTransaction()).toBe(false);
  });

  it('reports a blocked create as a LockTimeoutError and leaves no transaction open', async () => {
    const conn = new FakeConnection('postgresql', { code: '55P03', message: 'canceling statement due to lock timeout' });
    await expect(makeGdb(conn).createVersion('my_edits')).rejects.toBeInstanceOf(LockTimeoutError);
    expect(conn.inTransaction()).toBe(false);
  });

  it('passes a genuine failure through untouched', async () => {
    const conn = new FakeConnection('postgresql', new Error('duplicate version name'));
    await expect(makeGdb(conn).createVersion('my_edits')).rejects.toThrow('duplicate version name');
    expect(conn.inTransaction()).toBe(false);
  });
});
