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
  it('does nothing when no candidates exist', async () => {
    const { connection } = makeMock({
      queryResponses: [
        { match: /SELECT state_id AS state_id FROM sde.SDE_state_locks UNION/, rows: [] },
        { match: /FROM sde.SDE_states s WHERE/, rows: [] }, // no candidates
      ],
    });
    const result = await pruneStates(connection, []);
    expect(result.statesRemoved).toBe(0);
    expect(result.deltaRowsRemoved).toBe(0);
  });

  it('decides prune candidates by the parent_state_id walk, not the closure (root fix)', async () => {
    // COMPRESS_HARDENING_PLAN.md §5.1: prune candidacy is judged by the
    // authoritative parent_state_id walk (a `reachable` recursive CTE), never by
    // the SDE_state_lineages closure (which has diverged on the live fabric).
    // Candidates must also be leaves (no child) and exclude the base state 0.
    let candidateSqls: string[] = [];
    const { connection } = makeMock({
      queryResponses: [
        { match: /UNION/, rows: [] }, // no locks
        { match: /FROM sde.SDE_states s\b/, rows: [] }, // no candidates
      ],
    });
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const norm = sql.replace(/\s+/g, ' ');
      if (/reachable AS/.test(norm) && /FROM sde.SDE_states s\b/.test(norm)) candidateSqls.push(norm);
      return origQuery<T>(sql, params);
    };
    await pruneStates(connection, []);
    expect(candidateSqls.length).toBeGreaterThan(0);
    const sql = candidateSqls[0]!;
    expect(sql).toMatch(/reachable AS \( SELECT/);
    expect(sql).toMatch(/JOIN reachable r ON st.state_id = r.rp/);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM sde.SDE_states c WHERE c.parent_state_id = s.state_id\)/);
    expect(sql).toMatch(/s.state_id <> 0/);
    expect(sql).not.toMatch(/JOIN sde.SDE_states vs ON vs.lineage_name = sl.lineage_name/);
  });

  it('binds two params per stateId for the OR-on-two-cols DELETEs', async () => {
    // Regression for the @p0/@p0 vs [stateId, stateId] mismatch. The DELETE
    // on the D-table references SDE_STATE_ID and DELETED_AT; the metadata
    // DELETE on SDE_state_lineages references lineage_id and lineage_name.
    // Both must use TWO distinct param refs (@p0/@p1 or $1/$2) so the
    // param-binding count matches what's in the SQL string.
    let candidatesReturned = false;
    const { connection, calls } = makeMock({
      driver: 'sqlserver',
      executeResponses: [{ match: /./, result: { rowsAffected: 0 } }],
    });
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const norm = sql.replace(/\s+/g, ' ');
      if (/UNION/.test(norm) && /SDE_state_locks/.test(norm)) {
        return [] as T[];
      }
      if (/FROM sde.SDE_states s WHERE/.test(norm)) {
        if (!candidatesReturned) {
          candidatesReturned = true;
          return [{ state_id: 100 }] as T[];
        }
        // In-fence recheck — still eligible.
        return [{ state_id: 100 }] as T[];
      }
      return origQuery<T>(sql, params);
    };
    await pruneStates(connection, [FAB_TABLE]);

    const dDelete = calls.find(
      (c) => c.kind === 'execute' && /DELETE FROM \[PA\]\.\[D42\]/.test(c.sql) && /DELETED_AT/.test(c.sql),
    );
    expect(dDelete).toBeDefined();
    expect(dDelete!.sql).toMatch(/SDE_STATE_ID = @p0 OR DELETED_AT = @p1/);
    expect(dDelete!.params).toEqual([100, 100]);

    const lineageDelete = calls.find(
      (c) => c.kind === 'execute' && /DELETE FROM sde.SDE_state_lineages/.test(c.sql),
    );
    expect(lineageDelete).toBeDefined();
    expect(lineageDelete!.sql).toMatch(/lineage_id = @p0 OR lineage_name = @p1/);
    expect(lineageDelete!.params).toEqual([100, 100]);
  });

  it('skips a candidate when the in-fence recheck removes it', async () => {
    let candidatesCallCount = 0;
    const { connection } = makeMock({
      queryResponses: [
        { match: /UNION/, rows: [] }, // no locks initially
        {
          match: /FROM sde.SDE_states s WHERE/,
          // first call returns [100], second call (in-fence recheck) returns []
          rows: [],
        },
      ],
    });
    // Override query for SDE_states to count calls
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      if (/FROM sde.SDE_states s WHERE/.test(sql.replace(/\s+/g, ' '))) {
        candidatesCallCount += 1;
        if (candidatesCallCount === 1) {
          return [{ state_id: 100 }] as T[];
        }
        return [] as T[];
      }
      return origQuery<T>(sql, params);
    };

    const result = await pruneStates(connection, []);
    expect(result.statesRemoved).toBe(0);
    expect(result.statesSkipped).toBe(1);
  });
});

describe('collapseLineages', () => {
  it('runs independent SDE_STATE_ID and DELETED_AT updates per collapse', async () => {
    let pairsCallCount = 0;
    const { connection, calls } = makeMock({
      executeResponses: [{ match: /./, result: { rowsAffected: 1 } }],
    });
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const norm = sql.replace(/\s+/g, ' ');
      if (/UNION/.test(norm) && /SDE_state_locks/.test(norm)) {
        return [] as T[]; // no locks
      }
      if (/INNER JOIN .* p ON p\..*= c\./.test(norm)) {
        pairsCallCount += 1;
        if (pairsCallCount === 1) {
          return [{ parent: 100, child: 101 }] as T[];
        }
        return [] as T[]; // second iter, no more pairs
      }
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
