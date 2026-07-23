/**
 * The set-based fast path in applyParentChanges.
 *
 * Reconciling a version that is far behind DEFAULT means tens of thousands of
 * features. The original implementation copied them ONE ROW AT A TIME, each copy
 * preceded by its own INFORMATION_SCHEMA lookup -- minutes of sequential
 * round-trips, which made Submit time out on a real fabric. Non-conflicting
 * changes are now applied with one statement per table per change-type.
 *
 * These tests pin the behaviour that matters:
 *   - non-conflicting work goes through bulk statements, not per-row copies;
 *   - a row the child already edited is NOT clobbered by the parent's version;
 *   - conflicts still take the per-row path (each needs a decision).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { applyParentChanges } from '../src/reconcile/apply-changes';
import { clearColumnCache } from '../src/reconcile/set-copy';
import type { IDatabaseConnection, ExecuteResult } from '../src/connections/connection';
import type { DetailedConflict, TableInfo, VersionChanges } from '../src/types';

const TABLE = 'TestTable';
const CHILD_STATE = 10;

interface SqlCall { sql: string; params?: unknown[] }

/**
 * Mock that answers the two read shapes the fast path issues:
 *   - INFORMATION_SCHEMA column list
 *   - "which OBJECTIDs already have A-rows in the child state"
 */
function makeMockConnection(childAlreadyHas: number[] = []): {
  conn: IDatabaseConnection; calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const conn: IDatabaseConnection = {
    driver: 'sqlserver',
    isConnected: true,
    async connect() {},
    async close() {},
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (/INFORMATION_SCHEMA\.COLUMNS/i.test(sql)) {
        return [
          { COLUMN_NAME: 'OBJECTID', DATA_TYPE: 'int' },
          { COLUMN_NAME: 'Name', DATA_TYPE: 'nvarchar' },
          { COLUMN_NAME: 'SDE_STATE_ID', DATA_TYPE: 'bigint' },
        ] as never;
      }
      if (/SELECT DISTINCT \[OBJECTID\]/i.test(sql)) {
        return childAlreadyHas.map((o) => ({ OBJECTID: o })) as never;
      }
      return [] as never;
    },
    async *stream() {},
    async scalar() { return null; },
    async execute(sql: string, params?: unknown[]): Promise<ExecuteResult> {
      calls.push({ sql, params });
      // Report what the statement would really move, so the "copy must move one
      // row per OBJECTID" assertion is exercised rather than tripped by the mock:
      // count the OBJECTID IN-list for copies, the VALUES tuples for markers.
      const inList = /\[OBJECTID\] IN \(([^)]*)\)/i.exec(sql);
      if (inList) return { rowsAffected: inList[1]!.split(',').length };
      const values = /VALUES ((?:\(\d+\),?)+)/i.exec(sql);
      if (values) return { rowsAffected: values[1]!.split('),').length };
      return { rowsAffected: 1 };
    },
    async executeInsert() { return []; },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    inTransaction() { return false; },
  };
  return { conn, calls };
}

function makeTable(name = TABLE): TableInfo {
  return {
    name, physicalName: name, schema: 'sde',
    isFeatureClass: false, isVersioned: true, registrationId: 42,
  };
}

function changes(partial: Partial<VersionChanges>): VersionChanges {
  return { inserts: [], updates: [], deletes: [], ...partial };
}

const change = (objectId: number, changeType: 'insert' | 'update' | 'delete') => ({
  table: TABLE, registrationId: 42, objectId, stateId: 5, changeType,
});

describe('applyParentChanges - set-based fast path', () => {
  beforeEach(() => clearColumnCache());

  it('applies many non-conflicting inserts with bulk statements, not one copy per row', async () => {
    const { conn, calls } = makeMockConnection();
    const inserts = Array.from({ length: 500 }, (_, i) => change(1000 + i, 'insert'));

    const res = await applyParentChanges(
      conn, [makeTable()], changes({ inserts }), [], CHILD_STATE, {},
    );

    expect(res.appliedCount).toBe(500);
    const inserted = calls.filter((c) => /INSERT INTO/i.test(c.sql));
    // One bulk statement for the whole batch - emphatically not 500.
    expect(inserted.length).toBe(1);
    expect(inserted[0]!.sql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY \[OBJECTID\]/i);
    // And the column metadata is read once, not per row.
    expect(calls.filter((c) => /INFORMATION_SCHEMA/i.test(c.sql)).length).toBe(1);
  });

  it('does NOT clobber a row the child already edited', async () => {
    // Child already has its own A-row for 200; the parent also updated it.
    const { conn, calls } = makeMockConnection([200]);
    const updates = [change(200, 'update'), change(201, 'update')];

    await applyParentChanges(conn, [makeTable()], changes({ updates }), [], CHILD_STATE, {});

    const writes = calls.filter((c) => /INSERT INTO/i.test(c.sql));
    const params = writes.flatMap((c) => JSON.stringify(c.sql));
    // 201 is applied; 200 must be excluded from both the marker and the copy.
    const all = writes.map((w) => w.sql).join(' ');
    expect(all).toContain('201');
    expect(all).not.toContain('200');
    void params;
  });

  it('routes conflicting changes through the per-row path (favor_edit skips the parent row)', async () => {
    const { conn, calls } = makeMockConnection();
    const conflict: DetailedConflict = {
      table: TABLE, registrationId: 42, objectId: 100,
      childChangeType: 'update', parentChangeType: 'update',
      childStateId: CHILD_STATE, parentStateId: 5,
      fieldConflicts: [{ field: 'Name', childValue: 'A', parentValue: 'B', baseValue: 'X' }],
      childOnlyChanges: [], parentOnlyChanges: [], autoMergeable: false,
    } as DetailedConflict;

    await applyParentChanges(
      conn, [makeTable()], changes({ updates: [change(100, 'update')] }), [conflict],
      CHILD_STATE, { conflictResolution: 'favor_edit' },
    );

    // favor_edit keeps the child's row: nothing is written for it at all.
    expect(calls.filter((c) => /INSERT INTO/i.test(c.sql)).length).toBe(0);
  });

  it('throws rather than leaving delete markers with no A-rows when a copy comes up short', async () => {
    // A short copy (source state collapsed by a concurrent compress, a row that
    // moved) would otherwise commit markers with nothing behind them, silently
    // vanishing features while still reporting success.
    const { conn } = makeMockConnection();
    const short = {
      ...conn,
      async execute() { return { rowsAffected: 1 }; }, // claims 1 row for a 3-row copy
    } as unknown as IDatabaseConnection;

    await expect(
      applyParentChanges(
        short, [makeTable()],
        changes({ inserts: [change(1, 'insert'), change(2, 'insert'), change(3, 'insert')] }),
        [], CHILD_STATE, {},
      ),
    ).rejects.toThrow(/moved 1 of 3/);
  });

  it('mixes bulk and per-row correctly when only some rows conflict', async () => {
    const { conn, calls } = makeMockConnection();
    const conflict = {
      table: TABLE, registrationId: 42, objectId: 100,
      childChangeType: 'update', parentChangeType: 'update',
      childStateId: CHILD_STATE, parentStateId: 5,
      fieldConflicts: [{ field: 'Name', childValue: 'A', parentValue: 'B', baseValue: 'X' }],
      childOnlyChanges: [], parentOnlyChanges: [], autoMergeable: false,
    } as DetailedConflict;

    const res = await applyParentChanges(
      conn, [makeTable()],
      changes({ inserts: [change(101, 'insert'), change(102, 'insert')], updates: [change(100, 'update')] }),
      [conflict], CHILD_STATE, { conflictResolution: 'favor_edit' },
    );

    // The two clean inserts go bulk; the conflicted row is skipped by favor_edit.
    const inserted = calls.filter((c) => /INSERT INTO/i.test(c.sql));
    expect(inserted.length).toBe(1);
    expect(inserted[0]!.sql).toMatch(/ROW_NUMBER/i);
    expect(res.appliedCount).toBe(2);
  });
});
