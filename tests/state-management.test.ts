/**
 * Unit tests for state-management.
 *
 * These tests use a mock IDatabaseConnection because the real implementation
 * requires a live ArcGIS SDE schema. They verify the contracts that don't
 * depend on actual SQL execution semantics: invariants, ordering, error paths.
 */

import { describe, it, expect } from 'vitest';
import {
  createChildState,
  deleteChildState,
  acquireStateLock,
  releaseStateLock,
  getLockedStateIds,
} from '../src/reconcile/state-management';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';

interface MockCall {
  kind: 'query' | 'execute';
  sql: string;
  params?: unknown[];
}

interface MockOptions {
  driver?: 'sqlserver' | 'postgresql';
  inTransaction?: boolean;
  /** Map of (substring of sql) -> rows to return for query() */
  queryResponses?: Array<{ match: RegExp; rows: Record<string, unknown>[] }>;
}

function makeMock(opts: MockOptions = {}): {
  connection: IDatabaseConnection;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const driver = opts.driver ?? 'sqlserver';
  let _inTransaction = opts.inTransaction ?? false;

  const connection: IDatabaseConnection = {
    driver,
    isConnected: true,
    async connect() {},
    async close() {},
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      calls.push({ kind: 'query', sql, params });
      const match = (opts.queryResponses ?? []).find((r) => r.match.test(sql));
      return (match?.rows ?? []) as T[];
    },
    async *stream() {
      // not used
    },
    async scalar() {
      return null;
    },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      calls.push({ kind: 'execute', sql, params });
      return { rowsAffected: 1 };
    },
    async executeInsert() {
      return [];
    },
    async beginTransaction() {
      _inTransaction = true;
    },
    async commitTransaction() {
      _inTransaction = false;
    },
    async rollbackTransaction() {
      _inTransaction = false;
    },
    inTransaction() {
      return _inTransaction;
    },
  };

  return { connection, calls };
}

describe('createChildState', () => {
  it('refuses to run outside a transaction', async () => {
    const { connection } = makeMock({ inTransaction: false });
    await expect(createChildState(connection, 100)).rejects.toThrow(
      /must be called inside a transaction/
    );
  });

  it('threads the parent state into the lineage copy', async () => {
    const { connection, calls } = makeMock({
      inTransaction: true,
      driver: 'sqlserver',
      queryResponses: [
        { match: /SDE_state_id_generator/, rows: [{ id_value: 999 }] },
      ],
    });

    const newId = await createChildState(connection, 100);
    expect(newId).toBe(999);

    // Order: id allocation, state insert, lineage copy
    expect(calls.map((c) => c.sql.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringMatching(/SDE_state_id_generator/),
      expect.stringMatching(/INSERT INTO sde\.SDE_states/),
      expect.stringMatching(/INSERT INTO sde\.SDE_state_lineages/),
    ]);

    // State insert uses the new id and parent id
    expect(calls[1]!.params).toEqual([999, 100]);
    // Lineage copy uses the new id and parent id
    expect(calls[2]!.params).toEqual([999, 100]);
  });

  it('throws when the id generator returns nothing', async () => {
    const { connection } = makeMock({
      inTransaction: true,
      queryResponses: [{ match: /SDE_state_id_generator/, rows: [] }],
    });
    await expect(createChildState(connection, 100)).rejects.toThrow(
      /Failed to allocate state ID/
    );
  });
});

describe('deleteChildState', () => {
  it('deletes locks before lineages before state row (FK order)', async () => {
    const { connection, calls } = makeMock({ driver: 'sqlserver' });
    await deleteChildState(connection, 555, []);

    // With no registered tables, only the three system-table deletes run
    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls).toHaveLength(3);
    expect(sqls[0]).toMatch(/DELETE FROM sde\.SDE_state_locks/);
    expect(sqls[1]).toMatch(/DELETE FROM sde\.SDE_state_lineages/);
    expect(sqls[2]).toMatch(/DELETE FROM sde\.SDE_states/);
  });

  it('cleans A/D rows for each registered table before touching system tables', async () => {
    const { connection, calls } = makeMock({ driver: 'sqlserver' });
    await deleteChildState(connection, 555, [
      { schema: 'PA', registrationId: 42 },
    ]);

    const sqls = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
    expect(sqls[0]).toMatch(/DELETE FROM \[PA\]\.\[a42\]/);
    expect(sqls[1]).toMatch(/DELETE FROM \[PA\]\.\[D42\]/);
    expect(sqls[2]).toMatch(/SDE_state_locks/);
    expect(sqls[3]).toMatch(/SDE_state_lineages/);
    expect(sqls[4]).toMatch(/SDE_states/);
  });
});

describe('acquireStateLock / getConnectionSdeId', () => {
  it('throws when the driver returns no sde_id', async () => {
    const { connection } = makeMock({
      queryResponses: [{ match: /@@SPID|pg_backend_pid/, rows: [] }],
    });
    await expect(acquireStateLock(connection, 5)).rejects.toThrow(
      /Failed to obtain connection SDE id/
    );
  });

  it('throws when the driver returns 0', async () => {
    const { connection } = makeMock({
      queryResponses: [{ match: /@@SPID|pg_backend_pid/, rows: [{ sde_id: 0 }] }],
    });
    await expect(acquireStateLock(connection, 5)).rejects.toThrow(
      /refusing to use 0 fallback/
    );
  });

  it('throws when the driver returns a negative sde_id', async () => {
    const { connection } = makeMock({
      queryResponses: [{ match: /@@SPID|pg_backend_pid/, rows: [{ sde_id: -1 }] }],
    });
    await expect(acquireStateLock(connection, 5)).rejects.toThrow(
      /Failed to obtain connection SDE id/
    );
  });

  it('returns the sde_id and inserts an exclusive lock row', async () => {
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [{ match: /@@SPID/, rows: [{ sde_id: 73 }] }],
    });
    const sdeId = await acquireStateLock(connection, 999);
    expect(sdeId).toBe(73);

    const insert = calls.find(
      (c) => c.kind === 'execute' && /SDE_state_locks/.test(c.sql)
    );
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/'E'/); // exclusive lock type
    expect(insert!.params).toEqual([73, 999]);
  });
});

describe('releaseStateLock', () => {
  it('targets only the matching (sde_id, state_id) pair', async () => {
    const { connection, calls } = makeMock({ driver: 'postgresql' });
    await releaseStateLock(connection, 999, 73);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/sde_id = \$1 AND state_id = \$2/);
    expect(calls[0]!.params).toEqual([73, 999]);
  });
});

describe('getLockedStateIds', () => {
  it('returns a Set of distinct state ids', async () => {
    const { connection } = makeMock({
      queryResponses: [
        {
          match: /SDE_state_locks|sde_state_locks/,
          rows: [{ state_id: 1 }, { state_id: 2 }, { state_id: 3 }],
        },
      ],
    });
    const ids = await getLockedStateIds(connection);
    expect(ids).toBeInstanceOf(Set);
    expect([...ids].sort()).toEqual([1, 2, 3]);
  });

  it('returns empty set when no locks exist', async () => {
    const { connection } = makeMock({
      queryResponses: [{ match: /SDE_state_locks/, rows: [] }],
    });
    const ids = await getLockedStateIds(connection);
    expect(ids.size).toBe(0);
  });
});
