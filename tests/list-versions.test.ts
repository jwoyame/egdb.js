/**
 * Unit tests for EnterpriseGeodatabase.listVersions()'s error handling: it
 * must resolve to an empty list only when the SDE versions table/view itself
 * doesn't exist, and propagate every other error.
 */

import { describe, it, expect } from 'vitest';
import { EnterpriseGeodatabase } from '../src/enterprise-geodatabase';
import type { IDatabaseConnection, ExecuteResult } from '../src/connections/connection';
import type { ConnectionConfig } from '../src/types';

function makeConnection(
  driver: 'sqlserver' | 'postgresql',
  onQuery: () => Promise<unknown[]>
): IDatabaseConnection {
  return {
    driver,
    isConnected: true,
    async connect() {},
    async close() {},
    async query<T>(): Promise<T[]> {
      return (await onQuery()) as T[];
    },
    async *stream() {},
    async scalar() {
      return null;
    },
    async execute(): Promise<ExecuteResult> {
      return { rowsAffected: 0 };
    },
    async executeInsert() {
      return [];
    },
    async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    inTransaction() {
      return false;
    },
  };
}

// EnterpriseGeodatabase's constructor is `private` to TS but callable at
// runtime; connect() is too DB-bound to use here. listVersions() only needs
// config + connection, both of which it reads directly off the instance.
function buildGdb(connection: IDatabaseConnection, config: ConnectionConfig): EnterpriseGeodatabase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = EnterpriseGeodatabase as any;
  return new Ctor(config, connection);
}

const sqlServerConfig: ConnectionConfig = {
  driver: 'sqlserver',
  server: 's',
  database: 'd',
  user: 'u',
  password: 'p',
};

describe('EnterpriseGeodatabase.listVersions()', () => {
  it('returns an empty list when sde.SDE_versions does not exist (SQL Server 208)', async () => {
    const connection = makeConnection('sqlserver', async () => {
      throw { number: 208, message: "Invalid object name 'sde.SDE_versions'." };
    });
    const gdb = buildGdb(connection, sqlServerConfig);
    await expect(gdb.listVersions()).resolves.toEqual([]);
  });

  it('returns an empty list when sde.sde_versions does not exist (PostgreSQL 42P01)', async () => {
    const connection = makeConnection('postgresql', async () => {
      throw { code: '42P01', message: 'relation "sde.sde_versions" does not exist' };
    });
    const gdb = buildGdb(connection, { ...sqlServerConfig, driver: 'postgresql' });
    await expect(gdb.listVersions()).resolves.toEqual([]);
  });

  it('propagates a transaction-ownership collision (EREQINPROG) instead of hiding it', async () => {
    const connection = makeConnection('sqlserver', async () => {
      throw { name: 'TransactionError', code: 'EREQINPROG', message: 'Can\'t acquire request for the connection. There is a request in progress.' };
    });
    const gdb = buildGdb(connection, sqlServerConfig);
    await expect(gdb.listVersions()).rejects.toMatchObject({ code: 'EREQINPROG' });
  });

  it('propagates an unrelated SQL error instead of treating it as "no versioning"', async () => {
    const connection = makeConnection('sqlserver', async () => {
      throw { name: 'RequestError', code: 'EREQUEST', message: 'Login failed for user' };
    });
    const gdb = buildGdb(connection, sqlServerConfig);
    await expect(gdb.listVersions()).rejects.toMatchObject({ code: 'EREQUEST' });
  });
});
