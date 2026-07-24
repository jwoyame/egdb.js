/**
 * Unit tests for the three-phase compress implementation. Mock-driven —
 * verifies SQL shape, ordering, and decision logic without a live SDE.
 */

import { describe, it, expect } from 'vitest';
import {
  assertSelfRowInvariant,
  countMissingSelfRows,
  computeGraduablePrefix,
  readLockedBranches,
  graduateTable,
  pruneStates,
  collapseLineages,
} from '../src/reconcile/compress-impl';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';
import type { TableInfo } from '../src/types';

interface QueryResponse {
  match: RegExp;
  rows: Record<string, unknown>[];
}
interface ExecuteResponse {
  match: RegExp;
  result?: ExecuteResult;
  /** Called instead of returning result; useful for stateful mocks */
  fn?: (params?: unknown[]) => ExecuteResult;
}
interface MockCall {
  kind: 'query' | 'execute';
  sql: string;
  params?: unknown[];
}
interface MockOptions {
  driver?: 'sqlserver' | 'postgresql';
  inTransaction?: boolean;
  queryResponses?: QueryResponse[];
  executeResponses?: ExecuteResponse[];
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
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
      calls.push({ kind: 'query', sql: normalizeSql(sql), params });
      const norm = normalizeSql(sql);
      const match = (opts.queryResponses ?? []).find((r) => r.match.test(norm));
      return (match?.rows ?? []) as T[];
    },
    async *stream() {},
    async scalar() {
      return null;
    },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      const norm = normalizeSql(sql);
      calls.push({ kind: 'execute', sql: norm, params });
      const match = (opts.executeResponses ?? []).find((r) => r.match.test(norm));
      if (match?.fn) return match.fn(params);
      return match?.result ?? { rowsAffected: 1 };
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

const FAB_TABLE: TableInfo = {
  name: 'Parcels',
  physicalName: 'Parcels',
  schema: 'PA',
  isFeatureClass: true,
  isVersioned: true,
  registrationId: 42,
};

describe('assertSelfRowInvariant', () => {
  // The original spec called this an invariant; empirical testing showed
  // ArcGIS-authored states do NOT have self-rows. Function is now a no-op.
  it('is a no-op (kept for backwards compatibility)', async () => {
    const { connection, calls } = makeMock();
    await expect(assertSelfRowInvariant(connection)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});

describe('countMissingSelfRows', () => {
  it('returns the COUNT(*) reported by the query', async () => {
    const { connection } = makeMock({
      queryResponses: [{ match: /COUNT\(\*\) AS cnt/, rows: [{ cnt: 161 }] }],
    });
    const result = await countMissingSelfRows(connection);
    expect(result).toBe(161);
  });
});

describe('readLockedBranches', () => {
  it('expands locked states to ancestors + descendants via the parent_state_id walk (root fix)', async () => {
    const { connection, calls } = makeMock({
      queryResponses: [
        { match: /UNION/, rows: [{ state_id: 50 }, { state_id: 70 }, { state_id: 80 }, { state_id: 10 }, { state_id: 30 }] },
      ],
    });
    const result = await readLockedBranches(connection);
    expect(result).toEqual(new Set([50, 70, 80, 10, 30]));
    // Two recursive CTEs over parent_state_id (ancestors UP, descendants DOWN),
    // seeded from SDE_state_locks — NOT the SDE_state_lineages closure.
    expect(calls[0]!.sql).toMatch(/locked AS \(SELECT DISTINCT state_id AS s FROM sde.SDE_state_locks\)/);
    expect(calls[0]!.sql).toMatch(/JOIN anc a ON pp.state_id = a.p/);   // ancestors (up)
    expect(calls[0]!.sql).toMatch(/JOIN dsc dd ON c.parent_state_id = dd.s/); // descendants (down)
    expect(calls[0]!.sql).not.toMatch(/sl.lineage_name = sLock.lineage_name/);
  });
});

// (computeGraduablePrefix + graduateTable winner/tie-break mock tests removed:
//  they encoded the deleted closure/winner machinery. Graduation is now covered
//  by tests/compress/ (reference-model oracle + DB harness). N12.)

describe('graduateTable - subset revalidation', () => {
  it('returns skipped-version-set-changed when the snapshot is no longer a subset', async () => {
    // Recompute returns {0, 5} but snapshot was {0, 5, 10}; 10 has been excluded.
    const { connection } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 1 }] },
        { match: /HAVING COUNT\(DISTINCT/, rows: [{ state_id: 0 }, { state_id: 5 }] },
      ],
    });
    const result = await graduateTable(
      connection,
      FAB_TABLE,
      new Set([0, 5, 10]),
    );
    expect(result.status).toBe('skipped-version-set-changed');
  });

  it('returns no-graduable-rows when the prefix is empty', async () => {
    const { connection } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 0 }] },
      ],
    });
    const result = await graduateTable(connection, FAB_TABLE, new Set());
    expect(result.status).toBe('no-graduable-rows');
  });
});

describe('pruneStates', () => {
  it('does nothing when there are no unreachable states', async () => {
    const { connection } = makeMock({
      queryResponses: [
        { match: /SDE_mvtables_modified/, rows: [] },  // hasMvtablesModified → false
        { match: /SDE_state_locks/, rows: [] },        // readLockedBranches → no locks
        { match: /reachable AS/, rows: [] },           // findUnreachableStates → none
      ],
    });
    const result = await pruneStates(connection, []);
    expect(result.statesRemoved).toBe(0);
    expect(result.deltaRowsRemoved).toBe(0);
  });

  it('decides prunable states by the parent_state_id walk, not the closure (root fix)', async () => {
    // COMPRESS_HARDENING_PLAN.md §5.1: prunable = unreachable-from-any-tip via the
    // authoritative `reachable` recursive CTE, never the SDE_state_lineages
    // closure. The whole unreachable set is removed at once (no leaves-only filter).
    const seen: string[] = [];
    const { connection } = makeMock({
      queryResponses: [
        { match: /SDE_mvtables_modified/, rows: [] },
        { match: /SDE_state_locks/, rows: [] },
        { match: /reachable AS/, rows: [] },
      ],
    });
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const norm = sql.replace(/\s+/g, ' ');
      if (/reachable AS/.test(norm) && /FROM sde.SDE_states s\b/.test(norm)) seen.push(norm);
      return origQuery<T>(sql, params);
    };
    await pruneStates(connection, []);
    expect(seen.length).toBeGreaterThan(0);
    const sql = seen[0]!;
    expect(sql).toMatch(/reachable AS \( SELECT/);
    expect(sql).toMatch(/JOIN reachable r ON st.state_id = r.rp/);
    expect(sql).toMatch(/s.state_id <> 0 AND s.state_id NOT IN \(SELECT rs FROM reachable\)/);
    expect(sql).not.toMatch(/lineage_name/); // never the closure
  });

  it('deletes the whole unreachable set with batched IN-list DELETEs', async () => {
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        { match: /SDE_mvtables_modified/, rows: [] },   // mvExists false
        { match: /SDE_state_locks/, rows: [] },         // no locks
        { match: /reachable AS/, rows: [{ state_id: 100 }, { state_id: 101 }] }, // unreachable
      ],
      executeResponses: [
        { match: /DELETE FROM sde.SDE_states WHERE state_id IN/, result: { rowsAffected: 2 } },
        { match: /./, result: { rowsAffected: 0 } },
      ],
    });
    const result = await pruneStates(connection, [FAB_TABLE]);
    expect(result.statesRemoved).toBe(2);

    expect(calls.some(c => c.kind === 'execute' && /DELETE FROM \[PA\]\.\[a42\] WHERE SDE_STATE_ID IN \(100,101\)/.test(c.sql))).toBe(true);
    expect(calls.some(c => c.kind === 'execute' && /DELETE FROM \[PA\]\.\[D42\] WHERE SDE_STATE_ID IN \(100,101\) OR DELETED_AT IN \(100,101\)/.test(c.sql))).toBe(true);
    // Closure delete is keyed on lineage_id ONLY, never lineage_name (N6).
    expect(calls.some(c => c.kind === 'execute' && /DELETE FROM sde.SDE_state_lineages WHERE lineage_id IN \(100,101\)$/.test(c.sql.trim()))).toBe(true);
    expect(calls.some(c => c.kind === 'execute' && /SDE_state_lineages.*lineage_name/.test(c.sql))).toBe(false);
    expect(calls.some(c => c.kind === 'execute' && /DELETE FROM sde.SDE_states WHERE state_id IN \(100,101\)/.test(c.sql))).toBe(true);
  });

  it('subtracts locked branches from the prunable set', async () => {
    // readLockedBranches returns {100}; unreachable {100,101} → only 101 is pruned,
    // and 100 must never appear in any DELETE IN-list.
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      queryResponses: [
        { match: /SDE_mvtables_modified/, rows: [] },
        { match: /SDE_state_locks/, rows: [{ state_id: 100 }] }, // lock (expanded) covers 100
        { match: /reachable AS/, rows: [{ state_id: 100 }, { state_id: 101 }] },
      ],
      executeResponses: [
        { match: /DELETE FROM sde.SDE_states WHERE state_id IN/, result: { rowsAffected: 1 } },
        { match: /./, result: { rowsAffected: 0 } },
      ],
    });
    const result = await pruneStates(connection, [FAB_TABLE]);
    expect(result.statesRemoved).toBe(1);
    expect(calls.some(c => c.kind === 'execute' && /DELETE FROM sde.SDE_states WHERE state_id IN \(101\)/.test(c.sql))).toBe(true);
    // The locked state 100 is never touched by any delete.
    expect(calls.some(c => c.kind === 'execute' && /100/.test(c.sql))).toBe(false);
  });
});

describe('collapseLineages', () => {
  it('runs independent SDE_STATE_ID and DELETED_AT updates per collapse', async () => {
    const { connection, calls } = makeMock({
      executeResponses: [{ match: /./, result: { rowsAffected: 1 } }],
    });
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const norm = sql.replace(/\s+/g, ' ');
      if (/SDE_state_locks/.test(norm)) return [] as T[]; // readLockedBranches: no locks
      // computeCollapsePlan returns the whole (anchor, child) plan up front.
      if (/surv AS/.test(norm) && /st AS child, anchor/.test(norm)) return [{ child: 101, anchor: 100 }] as T[];
      return origQuery<T>(sql, params);
    };

    const result = await collapseLineages(connection, [FAB_TABLE]);
    expect(result.collapses).toBe(1);
    const updates = calls.filter(c => c.kind === 'execute' && /^UPDATE/.test(c.sql));
    // Should have TWO independent UPDATEs on the D-table (SDE_STATE_ID and DELETED_AT)
    const dUpdates = updates.filter(c => /\[PA\]\.\[D42\]/.test(c.sql));
    const updatesSidCol = dUpdates.filter(c => /SET SDE_STATE_ID = @p0/.test(c.sql));
    const updatesDelCol = dUpdates.filter(c => /SET DELETED_AT = @p0/.test(c.sql));
    expect(updatesSidCol).toHaveLength(1);
    expect(updatesDelCol).toHaveLength(1);
  });
});
