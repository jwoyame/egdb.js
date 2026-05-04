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
  cleanupStaleLocks,
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

describe('cleanupStaleLocks', () => {
  // Standard "permission granted" probe responses keyed by driver.
  const sqlServerPermOk = { match: /HAS_PERMS_BY_NAME/, rows: [{ has_perm: 1 }] };
  const postgresPermOk = { match: /pg_has_role|rolsuper/, rows: [{ has_perm: true }] };
  const cutoffOk = { match: /AS cutoff/, rows: [{ cutoff: new Date('2026-01-01T00:00:00Z') }] };

  it('throws InsufficientPrivilegeError when VIEW SERVER STATE is missing on SQL Server', async () => {
    const { connection } = makeMock({
      driver: 'sqlserver',
      queryResponses: [{ match: /HAS_PERMS_BY_NAME/, rows: [{ has_perm: 0 }] }],
    });
    await expect(cleanupStaleLocks(connection)).rejects.toThrow(/VIEW SERVER STATE/);
  });

  it('throws InsufficientPrivilegeError when probe role check fails on Postgres', async () => {
    const { connection } = makeMock({
      driver: 'postgresql',
      queryResponses: [{ match: /pg_has_role|rolsuper/, rows: [{ has_perm: false }] }],
    });
    await expect(cleanupStaleLocks(connection)).rejects.toThrow(/pg_read_all_stats/);
  });

  it('returns zero when SDE_state_locks is empty', async () => {
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        sqlServerPermOk,
        cutoffOk,
        { match: /DISTINCT sde_id/, rows: [] },
      ],
    });
    const result = await cleanupStaleLocks(connection);
    expect(result).toEqual({ staleSdeIds: [], removedLocks: 0 });
    expect(calls.find((c) => /dm_exec_sessions|pg_stat_activity/.test(c.sql))).toBeUndefined();
  });

  it('returns zero when every locking sde_id has a live session', async () => {
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        sqlServerPermOk,
        cutoffOk,
        { match: /DISTINCT sde_id/, rows: [{ sde_id: 51 }, { sde_id: 52 }] },
        { match: /dm_exec_sessions/, rows: [{ sde_id: 51 }, { sde_id: 52 }, { sde_id: 99 }] },
      ],
    });
    const result = await cleanupStaleLocks(connection);
    expect(result).toEqual({ staleSdeIds: [], removedLocks: 0 });
    expect(calls.find((c) => c.kind === 'execute')).toBeUndefined();
  });

  it('deletes locks for sde_ids missing from live sessions', async () => {
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        sqlServerPermOk,
        cutoffOk,
        { match: /DISTINCT sde_id/, rows: [{ sde_id: 51 }, { sde_id: 52 }, { sde_id: 53 }] },
        { match: /dm_exec_sessions/, rows: [{ sde_id: 51 }, { sde_id: 99 }] },
      ],
    });
    const result = await cleanupStaleLocks(connection);
    expect([...result.staleSdeIds].sort((a, b) => a - b)).toEqual([52, 53]);
    expect(result.removedLocks).toBe(1);

    const del = calls.find((c) => c.kind === 'execute' && /SDE_state_locks/.test(c.sql));
    expect(del).toBeDefined();
    expect(del!.sql).toMatch(/IN \((52,53|53,52)\)/);
  });

  it('constrains the DELETE with lock_time <= cutoff to survive sde_id recycling', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        sqlServerPermOk,
        { match: /AS cutoff/, rows: [{ cutoff }] },
        { match: /DISTINCT sde_id/, rows: [{ sde_id: 99 }] },
        { match: /dm_exec_sessions/, rows: [] },
      ],
    });
    await cleanupStaleLocks(connection);

    const del = calls.find((c) => c.kind === 'execute' && /SDE_state_locks/.test(c.sql));
    expect(del).toBeDefined();
    // Strict `<` (not `<=`) avoids same-tick collisions with GETDATE()'s ~3.33ms resolution
    expect(del!.sql).toMatch(/lock_time < @p0/);
    expect(del!.sql).not.toMatch(/lock_time <=/);
    expect(del!.params).toEqual([cutoff]);
  });

  it('also constrains the lock-snapshot SELECT by cutoff (strict <)', async () => {
    const cutoff = new Date('2026-01-01T00:00:00Z');
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        sqlServerPermOk,
        { match: /AS cutoff/, rows: [{ cutoff }] },
        { match: /DISTINCT sde_id/, rows: [] },
      ],
    });
    await cleanupStaleLocks(connection);

    const snapshot = calls.find((c) => /DISTINCT sde_id/.test(c.sql));
    expect(snapshot).toBeDefined();
    expect(snapshot!.sql).toMatch(/lock_time < @p0/);
    expect(snapshot!.sql).not.toMatch(/lock_time <=/);
    expect(snapshot!.params).toEqual([cutoff]);
  });

  it('uses pg_stat_activity on postgres', async () => {
    const { connection, calls } = makeMock({
      driver: 'postgresql',
      queryResponses: [
        postgresPermOk,
        { match: /AS cutoff/, rows: [{ cutoff: new Date() }] },
        { match: /DISTINCT sde_id/, rows: [{ sde_id: 100 }] },
        { match: /pg_stat_activity/, rows: [] },
      ],
    });
    await cleanupStaleLocks(connection);
    expect(calls.find((c) => /pg_stat_activity/.test(c.sql))).toBeDefined();
    expect(calls.find((c) => /dm_exec_sessions/.test(c.sql))).toBeUndefined();
  });
});
