/**
 * createVersion must pass Esri's codes for access and name rule, and must
 * return the version it actually created.
 *
 * Esri's `sde.create_version` takes access 0 = private, 1 = public,
 * 2 = protected, and name_rule 1 = make the name unique, 2 = use the exact
 * name. The proc returns the name it used, which differs from the requested
 * one when it appended a number.
 */
import { describe, it, expect } from 'vitest';
import { EnterpriseGeodatabase, LockTimeoutError } from '../src/enterprise-geodatabase';
import type { IDatabaseConnection } from '../src/connections/connection';

type Row = Record<string, unknown>;

/** Records each call's SQL and parameters and answers from canned rows. */
class FakeConnection implements IDatabaseConnection {
  readonly calls: { sql: string; params?: unknown[] }[] = [];
  private tx = false;
  constructor(
    readonly driver: 'sqlserver' | 'postgresql',
    /** What the create call returns. */
    private readonly createRows: Row[],
    /** What the SDE_versions listing returns. */
    private readonly versionRows: Row[],
  ) {}

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.calls.push({ sql, params });
    if (/create_version/i.test(sql)) return this.createRows as T[];
    if (/sde_versions/i.test(sql)) return this.versionRows as T[];
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

  createParams(): unknown[] {
    return this.calls.find((c) => /create_version/i.test(c.sql))!.params!;
  }
}

function makeGdb(conn: IDatabaseConnection): EnterpriseGeodatabase {
  const Ctor = EnterpriseGeodatabase as unknown as new (c: unknown, conn: unknown) => EnterpriseGeodatabase;
  return new Ctor(
    { driver: conn.driver, server: 's', database: 'd', user: 'sde', password: 'p' },
    conn,
  );
}

const version = (owner: string, name: string, stateId: number): Row => ({
  name, owner, parent_name: 'DEFAULT', state_id: stateId,
});

describe('version constants match sde.create_version', () => {
  it('uses Esri access codes', () => {
    expect(EnterpriseGeodatabase.VersionAccess).toEqual({ PRIVATE: 0, PUBLIC: 1, PROTECTED: 2 });
  });

  it('uses Esri name rule codes', () => {
    expect(EnterpriseGeodatabase.VersionNameRule).toEqual({ UNIQUE: 1, EXACT: 2 });
  });
});

describe('createVersion arguments', () => {
  // sde.create_version(parent, name, name_rule, access, description)
  it('defaults to a private version with the exact name', async () => {
    const conn = new FakeConnection('sqlserver', [], [version('SDE', 'my_edits', 7)]);
    await makeGdb(conn).createVersion('my_edits');
    const [parent, name, nameRule, access] = conn.createParams();
    expect(parent).toBe('sde.DEFAULT');
    expect(name).toBe('my_edits');
    expect(nameRule).toBe(2);
    expect(access).toBe(0);
  });

  it('passes the requested access and name rule through', async () => {
    const conn = new FakeConnection('sqlserver', [], [version('SDE', 'my_edits', 7)]);
    await makeGdb(conn).createVersion('my_edits', {
      access: EnterpriseGeodatabase.VersionAccess.PUBLIC,
      nameRule: EnterpriseGeodatabase.VersionNameRule.UNIQUE,
    });
    const [, , nameRule, access] = conn.createParams();
    expect(nameRule).toBe(1);
    expect(access).toBe(1);
  });

  it('passes the same codes on PostgreSQL', async () => {
    const conn = new FakeConnection('postgresql', [], [version('sde', 'my_edits', 7)]);
    await makeGdb(conn).createVersion('my_edits');
    const [, , nameRule, access] = conn.createParams();
    expect(nameRule).toBe(2);
    expect(access).toBe(0);
  });
});

describe('createVersion returns the version it created', () => {
  it('SQL Server: reads the name and the return code back from the proc', async () => {
    const conn = new FakeConnection('sqlserver', [], []);
    await makeGdb(conn).createVersion('x').catch(() => undefined);
    const batch = conn.calls.find((c) => /create_version/i.test(c.sql))!.sql;
    expect(batch).toMatch(/EXEC @rc = sde\.create_version @p0, @createdName OUTPUT, @p2, @p3, @p4/);
    expect(batch).toMatch(/SELECT @rc AS return_code, @createdName AS name, USER_NAME\(\) AS owner/);
  });

  it('returns the numbered version, not the older one it was named after', async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ name: 'april_0917261', owner: 'SDE' }],
      [version('SDE', 'april_091726', 10), version('SDE', 'april_0917261', 11)],
    );
    const created = await makeGdb(conn).createVersion('april_091726', {
      nameRule: EnterpriseGeodatabase.VersionNameRule.UNIQUE,
    });
    expect(created.name).toBe('april_0917261');
    expect(created.stateId).toBe(11);
  });

  it("does not return another owner's version with the same name", async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ name: 'my_edits', owner: 'SDE' }],
      // Listed by name, so the other owner's row comes first.
      [version('APRIL', 'my_edits', 3), version('SDE', 'my_edits', 9)],
    );
    const created = await makeGdb(conn).createVersion('my_edits');
    expect(created.owner).toBe('SDE');
    expect(created.stateId).toBe(9);
  });

  it('matches the owner regardless of case or quoting', async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ name: 'my_edits', owner: '"SDE"' }],
      [version('sde', 'my_edits', 9)],
    );
    const created = await makeGdb(conn).createVersion('my_edits');
    expect(created.stateId).toBe(9);
  });

  it('falls back to the requested name, without an owner prefix, when nothing is reported', async () => {
    const conn = new FakeConnection('sqlserver', [], [version('SDE', 'my_edits', 9)]);
    const created = await makeGdb(conn).createVersion('SDE.my_edits');
    expect(created.stateId).toBe(9);
  });

  it('fails loudly when the created version cannot be found', async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ name: 'my_edits', owner: 'SDE' }],
      [version('APRIL', 'my_edits', 3)],
    );
    await expect(makeGdb(conn).createVersion('my_edits')).rejects.toThrow(/created but not found/);
  });
});

describe('createVersion checks the return code the proc gives back', () => {
  /**
   * The proc reports a lock conflict on the parent version's state with code
   * 50049 and raises nothing, leaving the requested name in its OUTPUT
   * argument. Nothing was created, so the call must fail rather than hand back
   * the version that already had that name.
   */
  it('reports a silent lock conflict as a LockTimeoutError', async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ return_code: 50049, name: 'april_091726', owner: 'SDE' }],
      [version('SDE', 'april_091726', 10)],
    );
    const err = await makeGdb(conn).createVersion('april_091726').catch((e) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as Error).message).toMatch(/nothing was changed/i);
    // No version was looked up, so no version can be returned by mistake.
    expect(conn.calls.some((c) => /sde_versions/i.test(c.sql))).toBe(false);
  });

  it('reports any other non-zero code as a failure that created nothing', async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ return_code: 50177, name: 'my_edits', owner: 'SDE' }],
      [version('SDE', 'my_edits', 10)],
    );
    const err = await makeGdb(conn).createVersion('my_edits').catch((e) => e);
    expect(err).not.toBeInstanceOf(LockTimeoutError);
    expect((err as Error).message).toMatch(/50177/);
    expect((err as Error).message).toMatch(/already exists/i);
    expect((err as Error).message).toMatch(/no version was created/i);
  });

  it('accepts code 0', async () => {
    const conn = new FakeConnection(
      'sqlserver',
      [{ return_code: 0, name: 'my_edits', owner: 'SDE' }],
      [version('SDE', 'my_edits', 10)],
    );
    const created = await makeGdb(conn).createVersion('my_edits');
    expect(created.stateId).toBe(10);
  });
});

describe('createVersion on PostgreSQL', () => {
  it('refuses the UNIQUE name rule, which it cannot report back reliably', async () => {
    const conn = new FakeConnection('postgresql', [], [version('sde', 'my_edits', 4)]);
    await expect(
      makeGdb(conn).createVersion('my_edits', {
        nameRule: EnterpriseGeodatabase.VersionNameRule.UNIQUE,
      }),
    ).rejects.toThrow(/not supported on PostgreSQL/);
    expect(conn.calls).toEqual([]);
  });
});
