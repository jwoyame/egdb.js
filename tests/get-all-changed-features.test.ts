/**
 * Tests for getAllChangedFeatures.
 *
 * Mocks the connection so getAllChanges can scan the A/D tables and
 * mocks the openTable resolver to confirm:
 *
 *   - We issue at most one stream() per affected table, no matter how
 *     many rows changed.
 *   - The IN clause covers every changed OID for that table (deduped).
 *   - Inserts and updates get their parsed Feature; deletes get null.
 *   - Tables with zero changes do not open a reader at all.
 */

import { describe, it, expect } from 'vitest';
import { getAllChangedFeatures } from '../src/reconcile/get-changes';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';
import type { Feature, TableInfo } from '../src/types';

interface TableState {
  // Rows present in the A table for the queried state IDs, keyed by OID.
  aRows: Map<number, { OBJECTID: number; SDE_STATE_ID: number }>;
  // OIDs marked deleted in the D table for the queried state IDs.
  dRows: Set<number>;
  // Feature rows the openTable stream should return for a given IN list.
  // The test seeds this so we can confirm the right OIDs were queried.
  featureRows: Feature[];
  // The where clauses the stream() was called with. Used to verify the
  // IN-list batching.
  streamWhereCalls: string[];
}

function makeConnection(stateByTable: Map<string, TableState>): IDatabaseConnection {
  return {
    driver: 'sqlserver',
    isConnected: true,
    async connect() {},
    async close() {},
    async query<T>(sql: string): Promise<T[]> {
      // getTableChanges issues two queries per table. We pick them apart
      // by looking for `a{regId}` vs `D{regId}` in the SQL.
      const aMatch = sql.match(/\[a(\d+)\]/);
      const dMatch = sql.match(/\[D(\d+)\]/);

      // The test tables both register as id 42; sub-select by which
      // delta-table the SQL touched.
      if (aMatch) {
        const tableName = pickTableForSql(sql, stateByTable);
        const state = stateByTable.get(tableName);
        if (!state) return [];
        return [...state.aRows.values()] as T[];
      }
      if (dMatch) {
        const tableName = pickTableForSql(sql, stateByTable);
        const state = stateByTable.get(tableName);
        if (!state) return [];
        // The delete SQL aliases SDE_DELETES_ROW_ID as OBJECTID, so
        // the row shape the caller reads has OBJECTID, not the raw
        // physical column.
        return [...state.dRows].map(oid => ({
          OBJECTID: oid,
          SDE_STATE_ID: 100,
        })) as T[];
      }
      return [];
    },
    async *stream() {},
    async scalar() { return null; },
    async execute(): Promise<ExecuteResult> { return { rowsAffected: 0 }; },
    async executeInsert() { return []; },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    inTransaction() { return false; },
  };
}

/**
 * Match the table name from the SQL. The test seeds two tables with
 * distinct registration ids so we can map back from the a/d table name.
 */
function pickTableForSql(sql: string, stateByTable: Map<string, TableState>): string {
  const aMatch = sql.match(/\[a(\d+)\]/);
  const dMatch = sql.match(/\[D(\d+)\]/);
  const regId = aMatch?.[1] ?? dMatch?.[1];
  if (regId === '42') return 'Parcels';
  if (regId === '43') return 'Lines';
  // Default to whichever table matches by name in the SQL.
  for (const name of stateByTable.keys()) {
    if (sql.includes(name)) return name;
  }
  return 'Unknown';
}

function makeTable(name: string, registrationId: number): TableInfo {
  return {
    name,
    physicalName: name,
    schema: 'sde',
    isFeatureClass: true,
    isVersioned: true,
    registrationId,
  };
}

describe('getAllChangedFeatures', () => {
  it('one stream() per affected table; deletes have null feature', async () => {
    const parcelsState: TableState = {
      aRows: new Map([
        [1, { OBJECTID: 1, SDE_STATE_ID: 100 }],
        [2, { OBJECTID: 2, SDE_STATE_ID: 100 }],
        [3, { OBJECTID: 3, SDE_STATE_ID: 100 }],
      ]),
      dRows: new Set([2, 4]),
      featureRows: [
        { id: 1, attributes: { Name: 'P1' }, geometry: null },
        { id: 2, attributes: { Name: 'P2' }, geometry: null },
        { id: 3, attributes: { Name: 'P3' }, geometry: null },
      ],
      streamWhereCalls: [],
    };
    const linesState: TableState = {
      aRows: new Map(),
      dRows: new Set(),
      featureRows: [],
      streamWhereCalls: [],
    };

    const stateByTable = new Map<string, TableState>([
      ['Parcels', parcelsState],
      ['Lines', linesState],
    ]);
    const conn = makeConnection(stateByTable);

    const openTable = async (name: string) => {
      const state = stateByTable.get(name)!;
      return {
        async *stream(options: { version?: string; where?: string }) {
          state.streamWhereCalls.push(options.where ?? '');
          for (const f of state.featureRows) {
            // Filter to the IN list the helper supplied, mirroring
            // what a real WHERE OBJECTID IN (...) would do.
            const oidList = parseInList(options.where ?? '');
            if (oidList && !oidList.includes(f.id)) continue;
            yield f;
          }
        },
      };
    };

    const tables = [makeTable('Parcels', 42), makeTable('Lines', 43)];
    const result = await getAllChangedFeatures(conn, openTable, 'pa.test', tables, [100]);

    // a/D row diff: OID 1 only in A -> insert; OID 2 in both -> update;
    // OID 3 only in A -> insert (it has no delete entry); OID 4 only in D
    // -> delete.
    expect(result.inserts).toHaveLength(2);
    expect(result.updates).toHaveLength(1);
    expect(result.deletes).toHaveLength(1);

    // Parcels stream() called exactly once with an IN list of all
    // inserted/updated OIDs.
    expect(parcelsState.streamWhereCalls).toHaveLength(1);
    const inList = parseInList(parcelsState.streamWhereCalls[0]!);
    expect(inList?.sort()).toEqual([1, 2, 3]);

    // Lines has no changes, so we should never open a reader for it.
    expect(linesState.streamWhereCalls).toHaveLength(0);

    // Inserts and updates carry the parsed Feature; deletes do not.
    for (const r of [...result.inserts, ...result.updates]) {
      expect(r.feature).not.toBeNull();
      expect(r.feature?.id).toBe(r.objectId);
    }
    expect(result.deletes[0]!.feature).toBeNull();
  });

  it('returns empty result when nothing changed', async () => {
    const stateByTable = new Map<string, TableState>([
      ['Parcels', { aRows: new Map(), dRows: new Set(), featureRows: [], streamWhereCalls: [] }],
    ]);
    const conn = makeConnection(stateByTable);
    const openTable = async () => ({ async *stream() {} });

    const result = await getAllChangedFeatures(
      conn,
      openTable,
      'pa.test',
      [makeTable('Parcels', 42)],
      [100],
    );

    expect(result.inserts).toHaveLength(0);
    expect(result.updates).toHaveLength(0);
    expect(result.deletes).toHaveLength(0);
  });
});

function parseInList(where: string): number[] | null {
  const match = where.match(/IN\s*\(([^)]+)\)/i);
  if (!match) return null;
  return match[1]!
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n));
}
