/**
 * Tier-1 harness DB layer: a local SQL Server (docker/sqlserver) scratch database
 * with a synthetic, ArcSDE-SHAPED schema faithful enough to exercise compress.
 *
 * Compress calls no Esri stored procs — only raw SQL against the SDE system
 * tables and the a<reg>/D<reg>/base delta tables — so a hand-built schema is
 * viable HERE (it would not be for editing). Fidelity that matters is encoded:
 *   - states_cuk UNIQUE(parent_state_id, lineage_name)  → C3 detectable
 *   - the state_id = 0 row and the (0,0) lineage row     → N5 detectable
 *   - SDE_state_lineages PK, SDE_mvtables_modified PK     → dedupe paths live
 *   - SDE_state_locks FK → SDE_states                     → lock-order bugs surface
 *   - a<reg> PK(OBJECTID, SDE_STATE_ID)                   → "two rows same key" impossible
 *
 * NEVER point this at the production RDS — compress hard-codes the `sde.` schema.
 * Gated on EGDB_COMPRESS_DB so a CI box without SQL Server skips loudly, not fails.
 *
 * See openparcels/handoff/COMPRESS_HARDENING_PLAN.md §6.
 */
import { SqlServerConnection } from '../../src/connections/sqlserver';
import type { IDatabaseConnection } from '../../src/connections/connection';
import type { TableInfo } from '../../src/types';

export const HAVE_DB = !!process.env.EGDB_COMPRESS_DB;

const CFG = {
  driver: 'sqlserver' as const,
  server: process.env.EGDB_COMPRESS_HOST ?? '127.0.0.1',
  port: Number(process.env.EGDB_COMPRESS_PORT ?? 11433),
  user: process.env.EGDB_COMPRESS_USER ?? 'sa',
  password: process.env.EGDB_COMPRESS_PASSWORD ?? 'YourStrong@Passw0rd',
  options: { trustServerCertificate: true },
};
export const REG_ID = 18;

/** The single registered table the harness uses. Base = `base18`, deltas a18/D18. */
export const PARCELS: TableInfo = {
  name: 'base18',
  physicalName: `dbo.base18`,
  schema: 'dbo',
  isFeatureClass: true,
  registrationId: REG_ID,
  isVersioned: true,
};

async function connectTo(database: string): Promise<SqlServerConnection> {
  const c = new SqlServerConnection({ ...CFG, database });
  await c.connect();
  return c;
}

/**
 * Ensure a scratch database + synthetic schema exist; return a connection to it.
 * Pass a UNIQUE `dbName` per test file — vitest runs files in parallel, and a
 * shared scratch DB would let one file's beforeEach reset clobber another's run.
 */
export async function connectScratch(dbName = 'egdb_compress_test'): Promise<SqlServerConnection> {
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`bad scratch db name: ${dbName}`);
  const master = await connectTo('master');
  try {
    await master.execute(`IF DB_ID('${dbName}') IS NULL CREATE DATABASE ${dbName};`);
  } finally {
    await master.close();
  }
  const conn = await connectTo(dbName);
  await createSchema(conn);
  return conn;
}

async function createSchema(conn: IDatabaseConnection): Promise<void> {
  await conn.execute(`IF SCHEMA_ID('sde') IS NULL EXEC('CREATE SCHEMA sde');`);
  await conn.execute(`
    IF OBJECT_ID('sde.SDE_states') IS NULL
    CREATE TABLE sde.SDE_states (
      state_id        BIGINT       NOT NULL,
      owner           NVARCHAR(32) NOT NULL CONSTRAINT DF_states_owner DEFAULT 'sde',
      creation_time   DATETIME     NOT NULL CONSTRAINT DF_states_ct DEFAULT GETDATE(),
      closing_time    DATETIME         NULL,
      lineage_name    BIGINT       NOT NULL,
      parent_state_id BIGINT       NOT NULL,
      CONSTRAINT states_pk  PRIMARY KEY (state_id),
      CONSTRAINT states_cuk UNIQUE (parent_state_id, lineage_name)
    );`);
  await conn.execute(`
    IF OBJECT_ID('sde.SDE_state_lineages') IS NULL
    CREATE TABLE sde.SDE_state_lineages (
      lineage_name BIGINT NOT NULL,
      lineage_id   BIGINT NOT NULL,
      CONSTRAINT lineages_pk PRIMARY KEY (lineage_name, lineage_id)
    );`);
  await conn.execute(`
    IF OBJECT_ID('sde.SDE_versions') IS NULL
    CREATE TABLE sde.SDE_versions (
      name        NVARCHAR(64) NOT NULL,
      owner       NVARCHAR(32) NOT NULL,
      state_id    BIGINT           NULL,
      description NVARCHAR(64)     NULL,
      parent_name NVARCHAR(64)     NULL,
      CONSTRAINT versions_pk PRIMARY KEY (owner, name)
    );`);
  await conn.execute(`
    IF OBJECT_ID('sde.SDE_state_locks') IS NULL
    CREATE TABLE sde.SDE_state_locks (
      sde_id    INT          NOT NULL,
      state_id  BIGINT       NOT NULL,
      lock_type CHAR(1)      NOT NULL CONSTRAINT DF_locks_lt DEFAULT 'E',
      autolock  CHAR(1)      NOT NULL CONSTRAINT DF_locks_al DEFAULT 'N',
      lock_time DATETIME     NOT NULL CONSTRAINT DF_locks_time DEFAULT GETDATE(),
      CONSTRAINT locks_fk FOREIGN KEY (state_id) REFERENCES sde.SDE_states(state_id)
    );`);
  await conn.execute(`
    IF OBJECT_ID('sde.SDE_mvtables_modified') IS NULL
    CREATE TABLE sde.SDE_mvtables_modified (
      state_id        BIGINT NOT NULL,
      registration_id INT    NOT NULL,
      CONSTRAINT mvtables_pk PRIMARY KEY (state_id, registration_id)
    );`);
  // data tables (base + a/D). base and a share columns (minus SDE_STATE_ID).
  await conn.execute(`
    IF OBJECT_ID('dbo.base${REG_ID}') IS NULL
    CREATE TABLE dbo.base${REG_ID} (
      OBJECTID INT NOT NULL CONSTRAINT base_pk PRIMARY KEY,
      VAL      NVARCHAR(64) NULL
    );`);
  await conn.execute(`
    IF OBJECT_ID('dbo.a${REG_ID}') IS NULL
    CREATE TABLE dbo.a${REG_ID} (
      OBJECTID     INT    NOT NULL,
      SDE_STATE_ID BIGINT NOT NULL,
      VAL          NVARCHAR(64) NULL,
      CONSTRAINT a_pk PRIMARY KEY (OBJECTID, SDE_STATE_ID)
    );`);
  await conn.execute(`
    IF OBJECT_ID('dbo.D${REG_ID}') IS NULL
    CREATE TABLE dbo.D${REG_ID} (
      SDE_DELETES_ROW_ID INT    NOT NULL,
      SDE_STATE_ID       BIGINT NOT NULL,
      DELETED_AT         BIGINT NOT NULL
    );`);
}

/** Wipe all rows and restore the two base invariants (state 0, lineage (0,0)). */
export async function resetFabric(conn: IDatabaseConnection): Promise<void> {
  // order: locks (FK) before states.
  for (const t of ['sde.SDE_state_locks', 'sde.SDE_mvtables_modified', 'sde.SDE_state_lineages',
                   'sde.SDE_versions', 'sde.SDE_states', `dbo.a${REG_ID}`, `dbo.D${REG_ID}`, `dbo.base${REG_ID}`]) {
    await conn.execute(`DELETE FROM ${t};`);
  }
  await conn.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (0, 'sde', 0, 0);`);
  await conn.execute(`INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (0, 0);`);
}
