/**
 * A spatial predicate only matches geometries stored with the same SRID as
 * the query geometry, and SQL Server returns NULL (no rows, no error) when
 * they differ. These tests check that the query geometry always carries the
 * table's SRID, and that an unknown or wrong SRID is an error.
 */

import { describe, it, expect } from 'vitest';
import { EnterpriseTable } from '../src/enterprise-table';
import type { IDatabaseConnection, ExecuteResult } from '../src/connections/connection';
import type { TableInfo } from '../src/types';

type Driver = 'sqlserver' | 'postgres';

interface MockOptions {
  driver?: Driver;
  /** Rows returned for the catalog SRID lookup */
  catalogRows?: Array<{ srid: number | null }>;
  /** Make the catalog lookup fail, as on a database without that catalog */
  catalogFails?: boolean;
  /** Rows returned for the stored-shape SRID lookup */
  sampleRows?: Array<{ srid: number | null }>;
}

function makeMockConnection(streamed: string[], opts: MockOptions = {}): IDatabaseConnection {
  return {
    driver: opts.driver ?? 'sqlserver',
    isConnected: true,
    async connect() {},
    async close() {},
    async query<T>(sql: string): Promise<T[]> {
      if (/geometry_columns/i.test(sql)) {
        if (opts.catalogFails) throw new Error('Invalid object name');
        return (opts.catalogRows ?? []) as unknown as T[];
      }
      if (/STSrid|ST_SRID/i.test(sql)) return (opts.sampleRows ?? []) as unknown as T[];
      if (/COUNT\(\*\)/i.test(sql)) return [{ cnt: 0 }] as unknown as T[];
      return [] as T[];
    },
    async *stream(sql: string) { streamed.push(sql); },
    async scalar() { return null; },
    async execute(): Promise<ExecuteResult> { return { rowsAffected: 0 }; },
    async executeInsert() { return []; },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    inTransaction() { return false; },
  };
}

async function openTable(connection: IDatabaseConnection): Promise<EnterpriseTable> {
  const tableInfo: TableInfo = {
    name: 'Parcels',
    physicalName: 'Parcels',
    schema: 'sde',
    isFeatureClass: true,
    shapeFieldName: 'Shape',
  };
  return EnterpriseTable.open(connection, tableInfo);
}

async function drain(table: EnterpriseTable, opts: Parameters<EnterpriseTable['stream']>[0]) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of table.stream(opts)) { /* drain */ }
}

const BOX: [number, number, number, number] = [0, 0, 10, 10];

describe('spatial query SRID', () => {
  it('reads the table SRID from the SDE catalog into metadata', async () => {
    const table = await openTable(makeMockConnection([], { catalogRows: [{ srid: 2236 }] }));
    expect(table.metadata.spatialReference?.srid).toBe(2236);
  });

  it('reads the SRID from a stored shape when the catalog has no row', async () => {
    const table = await openTable(makeMockConnection([], { catalogFails: true, sampleRows: [{ srid: 2236 }] }));
    expect(table.metadata.spatialReference?.srid).toBe(2236);
  });

  it('uses the table SRID when the query geometry has none', async () => {
    const streamed: string[] = [];
    const table = await openTable(makeMockConnection(streamed, { catalogRows: [{ srid: 2236 }] }));
    await drain(table, { geometry: { envelope: BOX } });
    expect(streamed[0]).toContain(', 2236)');
    expect(streamed[0]).not.toContain(', 0)');
  });

  it.each([
    ['wkt', { wkt: 'POINT(1 1)' }],
    ['wkb', { wkb: Buffer.from('0101000000000000000000f03f000000000000f03f', 'hex') }],
    ['geojson', { type: 'Point' as const, coordinates: [1, 1] }],
  ])('stamps the table SRID on %s query geometry', async (_name, geometry) => {
    const streamed: string[] = [];
    const table = await openTable(makeMockConnection(streamed, { catalogRows: [{ srid: 2236 }] }));
    await drain(table, { geometry });
    expect(streamed[0]).toMatch(/, 2236\)/);
    expect(streamed[0]).not.toMatch(/, 0\)/);
  });

  it('stamps the table SRID on PostGIS queries', async () => {
    const streamed: string[] = [];
    const table = await openTable(makeMockConnection(streamed, { driver: 'postgres', catalogRows: [{ srid: 2236 }] }));
    await drain(table, { geometry: { envelope: BOX } });
    expect(streamed[0]).toContain('ST_GeomFromText(');
    expect(streamed[0]).toContain(', 2236)');
  });

  it('keeps an explicit SRID that matches the table', async () => {
    const streamed: string[] = [];
    const table = await openTable(makeMockConnection(streamed, { catalogRows: [{ srid: 2236 }] }));
    await drain(table, { geometry: { envelope: BOX, srid: 2236 } });
    expect(streamed[0]).toContain(', 2236)');
  });

  it('throws when the query SRID differs from the table SRID', async () => {
    const table = await openTable(makeMockConnection([], { catalogRows: [{ srid: 2236 }] }));
    await expect(drain(table, { geometry: { envelope: BOX, srid: 4326 } })).rejects.toThrow(/does not match/);
  });

  it('throws when the query SRID is 0', async () => {
    const table = await openTable(makeMockConnection([], { catalogRows: [{ srid: 2236 }] }));
    await expect(drain(table, { geometry: { envelope: BOX, srid: 0 } })).rejects.toThrow(/invalid srid 0/);
  });

  it('throws when neither the table nor the query gives an SRID', async () => {
    const table = await openTable(makeMockConnection([]));
    await expect(drain(table, { geometry: { envelope: BOX } })).rejects.toThrow(/could not be determined/);
  });

  it('accepts an explicit SRID when the table SRID is unknown', async () => {
    const streamed: string[] = [];
    const table = await openTable(makeMockConnection(streamed));
    await drain(table, { geometry: { envelope: BOX, srid: 2236 } });
    expect(streamed[0]).toContain(', 2236)');
  });

  it('does not need an SRID when there is no spatial filter', async () => {
    const streamed: string[] = [];
    const table = await openTable(makeMockConnection(streamed));
    await drain(table, { where: '1=1' });
    expect(streamed).toHaveLength(1);
  });
});
