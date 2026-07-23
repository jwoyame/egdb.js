/**
 * End-to-end schema extras: the GDB catalog (`GDB_ITEMS` / `GDB_ITEMTYPES` /
 * `SDE_table_registry`) that `EnterpriseGeodatabase.listTables()` reads, plus a
 * SECOND versioned table (regId 19) so `compress()`'s `options.tables` scoping
 * (N2 — prune/collapse must still run on an excluded table) and multi-table
 * phase order can be exercised through the real public entry point.
 *
 * The base18 table itself is created by db.ts::connectScratch; this only adds the
 * catalog rows and the parallel base19/a19/D19 tables.
 */
import type { IDatabaseConnection } from '../../src/connections/connection';
import type { TableInfo } from '../../src/types';

const FEATURE_CLASS_UUID = 'CA1C6E90-7896-4692-AA21-F8BB7063C4AD';
const TABLE_UUID = '77C1E6B3-9EB4-4A1D-B686-E1CADD1E3ADA';

/** Registered tables the e2e catalog exposes (both versioned). */
export const E2E_TABLES: TableInfo[] = [
  { name: 'base18', physicalName: 'SCRATCH.dbo.base18', schema: 'dbo', isFeatureClass: true, registrationId: 18, isVersioned: true },
  { name: 'base19', physicalName: 'SCRATCH.dbo.base19', schema: 'dbo', isFeatureClass: false, registrationId: 19, isVersioned: true },
];

export async function installE2ESchema(conn: IDatabaseConnection): Promise<void> {
  // Second delta triple (regId 19), same shape as base18.
  await conn.execute(`IF OBJECT_ID('dbo.base19') IS NULL CREATE TABLE dbo.base19 (OBJECTID INT NOT NULL CONSTRAINT base19_pk PRIMARY KEY, VAL NVARCHAR(64) NULL);`);
  await conn.execute(`IF OBJECT_ID('dbo.a19') IS NULL CREATE TABLE dbo.a19 (OBJECTID INT NOT NULL, SDE_STATE_ID BIGINT NOT NULL, VAL NVARCHAR(64) NULL, CONSTRAINT a19_pk PRIMARY KEY (OBJECTID, SDE_STATE_ID));`);
  await conn.execute(`IF OBJECT_ID('dbo.D19') IS NULL CREATE TABLE dbo.D19 (SDE_DELETES_ROW_ID INT NOT NULL, SDE_STATE_ID BIGINT NOT NULL, DELETED_AT BIGINT NOT NULL);`);

  await conn.execute(`
    IF OBJECT_ID('sde.GDB_ITEMTYPES') IS NULL
    CREATE TABLE sde.GDB_ITEMTYPES (UUID NVARCHAR(38) NOT NULL PRIMARY KEY, Name NVARCHAR(64) NOT NULL);`);
  await conn.execute(`
    IF OBJECT_ID('sde.GDB_ITEMS') IS NULL
    CREATE TABLE sde.GDB_ITEMS (
      ObjectID INT NOT NULL PRIMARY KEY, UUID NVARCHAR(38) NOT NULL, Type NVARCHAR(38) NOT NULL,
      Name NVARCHAR(226) NOT NULL, PhysicalName NVARCHAR(226) NULL, Path NVARCHAR(512) NULL,
      DatasetSubtype1 INT NULL, DatasetSubtype2 INT NULL, DatasetInfo1 NVARCHAR(256) NULL, DatasetInfo2 NVARCHAR(256) NULL);`);
  await conn.execute(`
    IF OBJECT_ID('sde.SDE_table_registry') IS NULL
    CREATE TABLE sde.SDE_table_registry (registration_id INT NOT NULL PRIMARY KEY, owner NVARCHAR(32) NOT NULL, table_name NVARCHAR(128) NOT NULL, object_flags INT NOT NULL);`);

  await conn.execute(`DELETE FROM sde.GDB_ITEMTYPES;`);
  await conn.execute(`INSERT INTO sde.GDB_ITEMTYPES (UUID, Name) VALUES (@p0,'Feature Class'),(@p1,'Table');`, [FEATURE_CLASS_UUID, TABLE_UUID]);
  await conn.execute(`DELETE FROM sde.GDB_ITEMS;`);
  await conn.execute(`INSERT INTO sde.GDB_ITEMS (ObjectID, UUID, Type, Name, PhysicalName, Path, DatasetSubtype1, DatasetInfo1) VALUES
    (1, '{A}', @p0, 'base18', 'SCRATCH.dbo.base18', '\\base18', 4, 'SHAPE'),
    (2, '{B}', @p1, 'base19', 'SCRATCH.dbo.base19', '\\base19', NULL, NULL);`, [FEATURE_CLASS_UUID, TABLE_UUID]);
  await conn.execute(`DELETE FROM sde.SDE_table_registry;`);
  await conn.execute(`INSERT INTO sde.SDE_table_registry (registration_id, owner, table_name, object_flags) VALUES (18,'dbo','base18',8),(19,'dbo','base19',8);`);
}

/** Clear the regId-19 delta triple (regId 18 is handled by resetFabric). */
export async function resetTable19(conn: IDatabaseConnection): Promise<void> {
  for (const t of ['dbo.a19', 'dbo.D19', 'dbo.base19']) await conn.execute(`DELETE FROM ${t};`);
}

/** Mirror base18/a18/D18 into base19/a19/D19 so both tables carry the same edits. */
export async function copy18to19(conn: IDatabaseConnection): Promise<void> {
  await resetTable19(conn);
  await conn.execute(`INSERT INTO dbo.base19 (OBJECTID, VAL) SELECT OBJECTID, VAL FROM dbo.base18;`);
  await conn.execute(`INSERT INTO dbo.a19 (OBJECTID, SDE_STATE_ID, VAL) SELECT OBJECTID, SDE_STATE_ID, VAL FROM dbo.a18;`);
  await conn.execute(`INSERT INTO dbo.D19 (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) SELECT SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT FROM dbo.D18;`);
}
