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
  it('returns the union of locks, descendants, and ancestors via lineage_name lookup', async () => {
    // Pretend lock is held on state 50; descendants {70, 80} and ancestors {10, 30}.
    const { connection, calls } = makeMock({
      queryResponses: [
        {
          match: /UNION/,
          rows: [
            { state_id: 50 },
            { state_id: 70 },
            { state_id: 80 },
            { state_id: 10 },
            { state_id: 30 },
          ],
        },
      ],
    });
    const result = await readLockedBranches(connection);
    expect(result).toEqual(new Set([50, 70, 80, 10, 30]));
    // Confirm the SQL joins SDE_states (correct lineage_name lookup) and
    // uses lineage_id<=lock for ancestors, state_id>=lock for descendants.
    expect(calls[0]!.sql).toMatch(/SDE_state_locks/);
    expect(calls[0]!.sql).toMatch(/JOIN sde.SDE_states/);
    expect(calls[0]!.sql).toMatch(/sl.lineage_name = sLock.lineage_name/);
  });
});

describe('computeGraduablePrefix', () => {
  it('returns the empty set when no versions exist', async () => {
    const { connection } = makeMock({
      queryResponses: [{ match: /COUNT\(\*\) AS cnt/, rows: [{ cnt: 0 }] }],
    });
    const result = await computeGraduablePrefix(connection);
    expect(result).toEqual(new Set());
  });

  it('groups closure rows and filters by version count, UNIONing each tip into its own closure', async () => {
    const { connection, calls } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 3 }] },
        {
          match: /HAVING COUNT\(DISTINCT tip\)/,
          rows: [{ state_id: 0 }, { state_id: 5 }, { state_id: 10 }],
        },
      ],
    });
    const result = await computeGraduablePrefix(connection);
    expect(result).toEqual(new Set([0, 5, 10]));
    // Confirm the SQL UNIONs each tip into its own closure (no self-row assumed).
    expect(calls[1]!.sql).toMatch(/UNION SELECT state_id AS tip/);
  });
});

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

describe('graduateTable - no winners', () => {
  it('early-returns with no-graduable-rows when both winner queries are empty', async () => {
    // Bulk semantics: an OID only enters the winners map if it has at least
    // one winning A or D row. If neither winner query returns anything, the
    // function early-returns without touching base or delta tables. (Under
    // the previous per-OID loop, phantom-OID cleanup ran an extra DELETE;
    // bulk skips that because there's nothing to delete.)
    const { connection, calls } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 1 }] },
        { match: /HAVING COUNT\(DISTINCT tip\)/, rows: [{ state_id: 5 }] },
        { match: /FROM \[PA\]\.\[a42\] a1/, rows: [] },
        { match: /FROM \[PA\]\.\[D42\] d1/, rows: [] },
      ],
    });

    const result = await graduateTable(connection, FAB_TABLE, new Set([5]));
    expect(result.status).toBe('no-graduable-rows');
    expect(result.upserts).toBe(0);
    expect(result.deletes).toBe(0);
    // No DELETEs at all.
    const deleteSqls = calls.filter(c => c.kind === 'execute' && /^DELETE/.test(c.sql));
    expect(deleteSqls).toHaveLength(0);
  });
});

describe('graduateTable - co-located D+A tie-breaker (UPSERT)', () => {
  it('treats A and D at same state_id as UPDATE → UPSERT-A', async () => {
    const { connection, calls } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 1 }] },
        { match: /HAVING COUNT\(DISTINCT tip\)/, rows: [{ state_id: 5 }] },
        { match: /UNION SELECT/, rows: [{ oid: 99 }] },
        { match: /FROM \[PA\]\.\[a42\] a1/, rows: [{ oid: 99, state_id: 5 }] as Record<string, unknown>[] }, // A at 5
        { match: /FROM \[PA\]\.\[D42\] d1/, rows: [{ oid: 99, state_id: 5, deleted_at: 5 }] as Record<string, unknown>[] }, // D at 5
        // INFORMATION_SCHEMA columns
        {
          match: /INFORMATION_SCHEMA\.COLUMNS/,
          rows: [
            { name: 'OBJECTID' },
            { name: 'SHAPE' },
            { name: 'PIN' },
            { name: 'SDE_STATE_ID' },
          ],
        },
      ],
      executeResponses: [
        { match: /UPDATE base/, result: { rowsAffected: 1 } },
        { match: /INSERT INTO \[PA\]\.\[Parcels\]/, result: { rowsAffected: 0 } },
      ],
    });

    const result = await graduateTable(connection, FAB_TABLE, new Set([5]));
    expect(result.status).toBe('graduated');
    // Bulk semantics: UPDATE runs, then INSERT runs (no-op via NOT EXISTS).
    // upserts = update-rows-affected + insert-rows-affected = 1 + 0.
    expect(result.upserts).toBe(1);
    expect(result.deletes).toBe(0);
    const updates = calls.filter(c => c.kind === 'execute' && /UPDATE base/.test(c.sql));
    expect(updates).toHaveLength(1);
    // SDE_STATE_ID is excluded from the SET clause (FROM clause boundary).
    const setClause = updates[0]!.sql.match(/SET (.+?) FROM/)?.[1] ?? '';
    expect(setClause).not.toMatch(/SDE_STATE_ID/);
  });
});

describe('graduateTable - D-winner is descendant of A-winner (DELETE)', () => {
  it('graduates to DELETE when delete supersedes the add along the lineage', async () => {
    const { connection } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 1 }] },
        { match: /HAVING COUNT\(DISTINCT tip\)/, rows: [{ state_id: 5 }, { state_id: 7 }] },
        { match: /UNION SELECT/, rows: [{ oid: 99 }] },
        { match: /FROM \[PA\]\.\[a42\] a1/, rows: [{ oid: 99, state_id: 5 }] as Record<string, unknown>[] }, // A at 5
        { match: /FROM \[PA\]\.\[D42\] d1/, rows: [{ oid: 99, state_id: 7, deleted_at: 7 }] as Record<string, unknown>[] }, // D at 7 (descendant)
        {
          // Batched ancestry: pair (5, 7) — 5 IS an ancestor of 7.
          match: /FROM \(VALUES \(5, 7\)\) AS p/,
          rows: [{ anc: 5, desc: 7 }],
        },
      ],
      executeResponses: [
        { match: /DELETE FROM \[PA\]\.\[Parcels\]/, result: { rowsAffected: 1 } },
      ],
    });

    const result = await graduateTable(connection, FAB_TABLE, new Set([5, 7]));
    expect(result.status).toBe('graduated');
    expect(result.deletes).toBe(1);
    expect(result.upserts).toBe(0);
  });
});

describe('graduateTable - A-winner is descendant of D-winner (UPSERT)', () => {
  it('UPSERTs when add supersedes the delete along the lineage', async () => {
    const { connection } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 1 }] },
        { match: /HAVING COUNT\(DISTINCT tip\)/, rows: [{ state_id: 5 }, { state_id: 7 }] },
        { match: /UNION SELECT/, rows: [{ oid: 99 }] },
        { match: /FROM \[PA\]\.\[a42\] a1/, rows: [{ oid: 99, state_id: 7 }] as Record<string, unknown>[] }, // A at 7 (descendant)
        { match: /FROM \[PA\]\.\[D42\] d1/, rows: [{ oid: 99, state_id: 5, deleted_at: 5 }] as Record<string, unknown>[] }, // D at 5
        {
          // Batched ancestry: pair (7, 5) — 7 is NOT an ancestor of 5.
          match: /FROM \(VALUES \(7, 5\)\) AS p/,
          rows: [],
        },
        {
          match: /INFORMATION_SCHEMA\.COLUMNS/,
          rows: [{ name: 'OBJECTID' }, { name: 'SHAPE' }, { name: 'SDE_STATE_ID' }],
        },
      ],
      executeResponses: [
        { match: /UPDATE base/, result: { rowsAffected: 1 } },
        { match: /INSERT INTO \[PA\]\.\[Parcels\]/, result: { rowsAffected: 0 } },
      ],
    });

    const result = await graduateTable(connection, FAB_TABLE, new Set([5, 7]));
    expect(result.status).toBe('graduated');
    expect(result.upserts).toBe(1);
    expect(result.deletes).toBe(0);
  });
});

describe('graduateTable - multi-winner OID across non-comparable lineages', () => {
  it('emits a warning and skips an OID when its A-winners are mutually incomparable', async () => {
    // Two A-rows for OID 99: one at state 5, one at state 7. Neither is an
    // ancestor of the other (different lineage_name trees, concurrent posts).
    // Previously, `winners.set(oid, w)` silently overwrote one with the
    // other, and the cleanup DELETE wiped both delta rows — losing one
    // version's edits without ever writing them to base. The new code
    // detects this case, warns, and refuses to graduate the OID.
    const { connection, calls } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 2 }] },
        { match: /HAVING COUNT\(DISTINCT tip\)/, rows: [{ state_id: 5 }, { state_id: 7 }] },
        { match: /UNION SELECT/, rows: [{ oid: 99 }] },
        {
          match: /FROM \[PA\]\.\[a42\] a1/,
          rows: [
            { oid: 99, state_id: 5 },
            { oid: 99, state_id: 7 },
          ] as Record<string, unknown>[],
        },
        { match: /FROM \[PA\]\.\[D42\] d1/, rows: [] },
        // Batched ancestry probes: neither pairwise relation holds.
        { match: /FROM \(VALUES /, rows: [] },
      ],
    });

    const result = await graduateTable(connection, FAB_TABLE, new Set([5, 7]));
    expect(result.status).toBe('no-graduable-rows');
    expect(result.upserts).toBe(0);
    expect(result.deletes).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/concurrent graduable A-rows/);
    // Should not have issued any DELETE against the A or D tables.
    const dels = calls.filter(c => c.kind === 'execute' && /DELETE FROM \[PA\]\./.test(c.sql));
    expect(dels).toHaveLength(0);
  });
});

describe('graduateTable - INSERT when UPDATE affects 0 rows', () => {
  it('falls through to INSERT when the base row does not yet exist', async () => {
    const { connection, calls } = makeMock({
      queryResponses: [
        { match: /COUNT\(DISTINCT state_id\) AS cnt FROM sde.SDE_versions/, rows: [{ cnt: 1 }] },
        { match: /HAVING COUNT\(DISTINCT tip\)/, rows: [{ state_id: 5 }] },
        { match: /UNION SELECT/, rows: [{ oid: 99 }] },
        { match: /FROM \[PA\]\.\[a42\] a1/, rows: [{ oid: 99, state_id: 5 }] as Record<string, unknown>[] },
        { match: /FROM \[PA\]\.\[D42\] d1/, rows: [] },
        {
          match: /INFORMATION_SCHEMA\.COLUMNS/,
          rows: [{ name: 'OBJECTID' }, { name: 'SHAPE' }, { name: 'SDE_STATE_ID' }],
        },
      ],
      executeResponses: [
        { match: /UPDATE base/, result: { rowsAffected: 0 } }, // base row missing
        { match: /INSERT INTO \[PA\]\.\[Parcels\]/, result: { rowsAffected: 1 } },
      ],
    });
    const result = await graduateTable(connection, FAB_TABLE, new Set([5]));
    expect(result.upserts).toBe(1);
    const sqls = calls.filter(c => c.kind === 'execute').map(c => c.sql);
    expect(sqls.some(s => /UPDATE base/.test(s))).toBe(true);
    expect(sqls.some(s => /INSERT INTO \[PA\]\.\[Parcels\]/.test(s))).toBe(true);
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

  it('uses the JOIN-on-lineage_name idiom for the closure subquery (not lineage_name = state_id)', async () => {
    // Regression: the previous shape `WHERE lineage_name IN (SELECT state_id
    // FROM SDE_versions)` treated each tip's state_id as if it were a
    // lineage_name. On any DB where a tip's lineage_name differs from its
    // state_id (the common case), that returned zero closure rows and made
    // every linear ancestor a prune candidate.
    let candidateSqls: string[] = [];
    const { connection } = makeMock({
      queryResponses: [
        { match: /UNION/, rows: [] }, // no locks
        { match: /FROM sde.SDE_states s WHERE/, rows: [] }, // no candidates
      ],
    });
    const origQuery = connection.query.bind(connection);
    connection.query = async <T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const norm = sql.replace(/\s+/g, ' ');
      if (/FROM sde.SDE_states s WHERE/.test(norm)) {
        candidateSqls.push(norm);
      }
      return origQuery<T>(sql, params);
    };
    await pruneStates(connection, []);
    expect(candidateSqls.length).toBeGreaterThan(0);
    const sql = candidateSqls[0]!;
    // Must JOIN SDE_states with SDE_state_lineages by lineage_name and
    // filter by lineage_id <= tip; must NOT have the broken IN subquery.
    expect(sql).toMatch(/JOIN sde.SDE_states vs ON vs.lineage_name = sl.lineage_name/);
    expect(sql).toMatch(/sl.lineage_id <= vs.state_id/);
    expect(sql).not.toMatch(/lineage_name IN \(SELECT state_id FROM sde.SDE_versions/);
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
