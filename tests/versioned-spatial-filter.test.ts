/**
 * Regression test for the versioned spatial-filter bug.
 *
 * EnterpriseTable.stream() used to apply the spatial (envelope/intersects)
 * predicate ONLY on the non-versioned path. A versioned bbox query silently
 * dropped the spatial filter and returned unfiltered rows up to the limit.
 * In OpenParcels this made snapping in a named version return parcels from
 * all over the county instead of the ones under the cursor.
 *
 * These tests capture the SQL stream() issues and assert the spatial
 * predicate (STIntersects) is present on the versioned paths too.
 */

import { describe, it, expect } from 'vitest';
import { EnterpriseTable } from '../src/enterprise-table';
import type { IDatabaseConnection, ExecuteResult } from '../src/connections/connection';
import type { FieldDefinition, TableInfo, TableMetadata } from '../src/types';
import { FieldType } from '../src/types';

function makeMockConnection(captured: string[]): IDatabaseConnection {
  return {
    driver: 'sqlserver',
    isConnected: true,
    async connect() {},
    async close() {},
    async query<T>(): Promise<T[]> { return [] as T[]; },
    async *stream(sql: string) { captured.push(sql); /* yield nothing */ },
    async scalar() { return null; },
    async execute(): Promise<ExecuteResult> { return { rowsAffected: 0 }; },
    async executeInsert() { return []; },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    inTransaction() { return false; },
  };
}

function field(name: string, type: FieldType): FieldDefinition {
  return { name, type, typeName: 'String', alias: name, nullable: true };
}

function makeTable(
  connection: IDatabaseConnection,
  opts: { evwViewName?: string } = {},
): EnterpriseTable {
  const tableInfo: TableInfo = {
    name: 'Parcels',
    physicalName: 'Parcels',
    schema: 'sde',
    isFeatureClass: true,
    isVersioned: true,
    registrationId: 42,
    shapeFieldName: 'Shape',
    evwViewName: opts.evwViewName,
  };
  const fields: FieldDefinition[] = [
    field('OBJECTID', FieldType.OID),
    field('Name', FieldType.String),
    field('Shape', FieldType.Geometry),
  ];
  const metadata: TableMetadata = {
    name: tableInfo.name,
    physicalName: tableInfo.physicalName,
    schema: tableInfo.schema,
    featureCount: 0,
    fields,
    isFeatureClass: true,
    shapeFieldName: 'Shape',
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = EnterpriseTable as any;
  const getStateLineage = async () => [1, 2, 3];
  const setVersionContext = async () => {};
  const table = new Ctor(connection, tableInfo, getStateLineage, setVersionContext) as EnterpriseTable;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (table as any)._metadata = metadata;
  return table;
}

const ENVELOPE = {
  version: 'sde.SOMEVERSION',
  geometry: { envelope: [0, 0, 10, 10] as [number, number, number, number], srid: 2236 },
  spatialRelationship: 'intersects' as const,
  limit: 1000,
};

async function drain(table: EnterpriseTable, opts: Parameters<EnterpriseTable['stream']>[0]) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of table.stream(opts)) { /* drain */ }
}

describe('EnterpriseTable.stream versioned spatial filter', () => {
  it('applies the spatial predicate on the A/D UNION versioned path', async () => {
    const captured: string[] = [];
    const table = makeTable(makeMockConnection(captured)); // no evw -> UNION path
    await drain(table, ENVELOPE);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('STIntersects');
    // The predicate must be in BOTH halves of the UNION (base + adds).
    expect(captured[0]!.match(/STIntersects/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('applies the spatial predicate on the evw versioned path', async () => {
    const captured: string[] = [];
    const table = makeTable(makeMockConnection(captured), { evwViewName: 'sde.Parcels_evw' });
    await drain(table, ENVELOPE);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('Parcels_evw');
    expect(captured[0]).toContain('STIntersects');
  });

  it('still applies the spatial predicate on the non-versioned path', async () => {
    const captured: string[] = [];
    const table = makeTable(makeMockConnection(captured));
    const { version: _v, ...nonVersioned } = ENVELOPE;
    await drain(table, nonVersioned);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('STIntersects');
  });
});
