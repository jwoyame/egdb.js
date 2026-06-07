/**
 * Tests for EnterpriseTable.readFeatureAtState.
 *
 * Mocks the connection so we can confirm:
 *
 *   - The A-table SQL uses the proper select clause (explicit columns
 *     + geometry as WKB), filters by OBJECTID and the supplied state
 *     list <= ancestorStateId, and orders by SDE_STATE_ID DESC.
 *   - When the A-table query returns rows, the most recent one wins
 *     and rowToFeature parses it into a Feature.
 *   - When the A-table query returns no rows, the lookup falls back
 *     to the base table.
 *   - When the table has no registrationId, the function throws.
 */

import { describe, it, expect } from 'vitest';
import { EnterpriseTable } from '../src/enterprise-table';
import type {
  IDatabaseConnection,
  ExecuteResult,
} from '../src/connections/connection';
import type { FieldDefinition, TableInfo, TableMetadata } from '../src/types';
import { FieldType } from '../src/types';

interface MockState {
  // Per-call results indexed by call index. If a result is missing,
  // returns an empty array (no rows).
  results: Record<string, unknown>[][];
  // Captured query() calls.
  queries: Array<{ sql: string; params?: unknown[] }>;
}

function makeMockConnection(state: MockState): IDatabaseConnection {
  return {
    driver: 'sqlserver',
    isConnected: true,
    async connect() {},
    async close() {},
    async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
      state.queries.push({ sql, params });
      const result = state.results[state.queries.length - 1];
      return (result ?? []) as T[];
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

function field(name: string, type: FieldType, alias?: string): FieldDefinition {
  return { name, type, typeName: 'String', alias: alias ?? name, nullable: true };
}

function makeTable(
  connection: IDatabaseConnection,
  options: { registrationId?: number; shapeField?: string } = {},
): EnterpriseTable {
  const tableInfo: TableInfo = {
    name: 'Parcels',
    physicalName: 'Parcels',
    schema: 'sde',
    isFeatureClass: true,
    isVersioned: true,
    registrationId: options.registrationId ?? 42,
    shapeFieldName: options.shapeField,
  };

  const fields: FieldDefinition[] = [
    field('OBJECTID', FieldType.OID),
    field('Name', FieldType.String),
  ];
  if (options.shapeField) {
    fields.push(field(options.shapeField, FieldType.Geometry));
  }

  const metadata: TableMetadata = {
    name: tableInfo.name,
    physicalName: tableInfo.physicalName,
    schema: tableInfo.schema,
    featureCount: 0,
    fields,
    isFeatureClass: true,
    shapeFieldName: options.shapeField,
  };

  // EnterpriseTable's constructor is private, but accessible at
  // runtime. Reach past it for the test the same way edit-session
  // tests do, then seed the cached metadata.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = EnterpriseTable as any;
  const table = new Ctor(connection, tableInfo) as EnterpriseTable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (table as any)._metadata = metadata;
  return table;
}

describe('EnterpriseTable.readFeatureAtState', () => {
  it('uses the A-table when a matching row exists at or before the ancestor', async () => {
    const state: MockState = {
      queries: [],
      results: [
        // First call: A-table query returns the row.
        [{ OBJECTID: 7, Name: 'Lot 5A' }],
      ],
    };
    const conn = makeMockConnection(state);
    const table = makeTable(conn);

    const feature = await table.readFeatureAtState(7, 50, [10, 30, 50, 70]);

    expect(feature).not.toBeNull();
    expect(feature!.id).toBe(7);
    expect(feature!.attributes).toEqual({ Name: 'Lot 5A' });
    expect(feature!.geometry).toBeNull();

    // Only the A-table query ran; no fallback to the base table.
    expect(state.queries).toHaveLength(1);
    const sql = state.queries[0]!.sql;
    expect(sql).toMatch(/SELECT TOP 1/);
    expect(sql).toMatch(/\[sde\]\.\[a42\]/);
    // State list is filtered to states <= ancestorStateId (50). 70 dropped.
    expect(sql).toMatch(/IN\s*\(10,30,50\)/);
    // Order matters: most recent state wins.
    expect(sql).toMatch(/ORDER BY \[SDE_STATE_ID\] DESC/);
    expect(state.queries[0]!.params).toEqual([7]);
  });

  it('falls back to the base table when no A-table row matches', async () => {
    const state: MockState = {
      queries: [],
      results: [
        // First call: A-table query returns nothing.
        [],
        // Second call: base table returns the row.
        [{ OBJECTID: 9, Name: 'Lot 5B' }],
      ],
    };
    const conn = makeMockConnection(state);
    const table = makeTable(conn);

    const feature = await table.readFeatureAtState(9, 100, [50, 70]);

    expect(feature).not.toBeNull();
    expect(feature!.id).toBe(9);
    expect(feature!.attributes).toEqual({ Name: 'Lot 5B' });

    expect(state.queries).toHaveLength(2);
    // Second query is against the base table, not an a-table.
    expect(state.queries[1]!.sql).toMatch(/\[sde\]\.\[Parcels\]/);
    expect(state.queries[1]!.sql).not.toMatch(/\[a\d+\]/);
  });

  it('returns null when neither the A-table nor the base table has the row', async () => {
    const state: MockState = {
      queries: [],
      results: [[], []],
    };
    const conn = makeMockConnection(state);
    const table = makeTable(conn);

    const feature = await table.readFeatureAtState(13, 50, [10, 30, 50]);

    expect(feature).toBeNull();
    expect(state.queries).toHaveLength(2);
  });

  it('skips the A-table entirely when no states <= ancestorStateId remain', async () => {
    const state: MockState = {
      queries: [],
      results: [
        // No A-table call expected. The base table call is the first one.
        [{ OBJECTID: 1, Name: 'Base' }],
      ],
    };
    const conn = makeMockConnection(state);
    const table = makeTable(conn);

    // All supplied state ids are greater than the ancestor (5), so the
    // A-table filter yields an empty IN list and we should skip
    // straight to the base table.
    const feature = await table.readFeatureAtState(1, 5, [10, 20]);

    expect(feature).not.toBeNull();
    expect(feature!.attributes).toEqual({ Name: 'Base' });
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]!.sql).toMatch(/\[sde\]\.\[Parcels\]/);
  });

  it('throws when the table has no registrationId', async () => {
    const conn = makeMockConnection({ queries: [], results: [] });
    // Build a table without a registrationId by mutating tableInfo.
    const table = makeTable(conn);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (table as any).tableInfo.registrationId = undefined;

    await expect(table.readFeatureAtState(1, 50, [50])).rejects.toThrow(
      /not registered/,
    );
  });
});
