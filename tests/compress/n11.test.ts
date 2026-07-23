/**
 * N11 — base-write fidelity in graduateTable (COMPRESS_HARDENING_PLAN.md §4).
 * The base upsert supplies OBJECTID explicitly. Against a real Esri base table
 * that is an IDENTITY column, an explicit-OBJECTID INSERT fails unless wrapped in
 * SET IDENTITY_INSERT; a GLOBALID UNIQUE index must also survive the upsert.
 * Both were previously untested. This drives graduateTable against an IDENTITY +
 * GLOBALID base and asserts a posted new-add and update graduate cleanly.
 *
 * Gated on EGDB_COMPRESS_DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { computeGraduablePrefix, graduateTable } from '../../src/reconcile/compress-impl';
import { connectScratch, HAVE_DB } from './db';
import type { SqlServerConnection } from '../../src/connections/sqlserver';
import type { TableInfo } from '../../src/types';

const d = HAVE_DB ? describe : describe.skip;

const BASE20: TableInfo = { name: 'base20', physicalName: 'dbo.base20', schema: 'dbo', isFeatureClass: true, registrationId: 20, isVersioned: true };
const G = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

d('compress N11 — IDENTITY + GLOBALID base fidelity (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => {
    conn = await connectScratch('egdb_compress_n11');
    await conn.execute(`IF OBJECT_ID('dbo.base20') IS NULL CREATE TABLE dbo.base20 (
      OBJECTID INT IDENTITY(1,1) NOT NULL CONSTRAINT base20_pk PRIMARY KEY,
      GLOBALID UNIQUEIDENTIFIER NOT NULL CONSTRAINT base20_gid UNIQUE,
      VAL NVARCHAR(64) NULL);`);
    await conn.execute(`IF OBJECT_ID('dbo.a20') IS NULL CREATE TABLE dbo.a20 (
      OBJECTID INT NOT NULL, SDE_STATE_ID BIGINT NOT NULL, GLOBALID UNIQUEIDENTIFIER NOT NULL, VAL NVARCHAR(64) NULL,
      CONSTRAINT a20_pk PRIMARY KEY (OBJECTID, SDE_STATE_ID));`);
    await conn.execute(`IF OBJECT_ID('dbo.D20') IS NULL CREATE TABLE dbo.D20 (
      SDE_DELETES_ROW_ID INT NOT NULL, SDE_STATE_ID BIGINT NOT NULL, DELETED_AT BIGINT NOT NULL);`);
  });
  afterAll(async () => { if (conn) await conn.close(); });

  beforeEach(async () => {
    for (const t of ['sde.SDE_state_locks', 'sde.SDE_mvtables_modified', 'sde.SDE_state_lineages', 'sde.SDE_versions', 'sde.SDE_states', 'dbo.a20', 'dbo.D20'])
      await conn.execute(`DELETE FROM ${t};`);
    await conn.execute(`DELETE FROM dbo.base20;`);
    await conn.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (0,'sde',0,0);`);
    await conn.execute(`INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (0,0);`);
  });

  it('graduates an update and a new add against an IDENTITY + GLOBALID base', async () => {
    // States 0 <- 1 <- 2, DEFAULT at tip 2 (both graduable — single version).
    await conn.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (1,'t',1,0),(2,'t',1,1);`);
    await conn.execute(`INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (1,1),(1,2);`);
    await conn.execute(`INSERT INTO sde.SDE_versions (name, owner, state_id) VALUES ('DEFAULT','t',2);`);
    // base row oid 100 (G100, 'old'); an UPDATE at state 2 (new a-row) and a NEW add oid 200 at state 2.
    await conn.execute(`SET IDENTITY_INSERT dbo.base20 ON; INSERT INTO dbo.base20 (OBJECTID, GLOBALID, VAL) VALUES (100, @p0, 'old'); SET IDENTITY_INSERT dbo.base20 OFF;`, [G(100)]);
    await conn.execute(`INSERT INTO dbo.a20 (OBJECTID, SDE_STATE_ID, GLOBALID, VAL) VALUES (100, 2, @p0, 'new'), (200, 2, @p1, 'brand-new');`, [G(100), G(200)]);

    const prefix = await computeGraduablePrefix(conn);
    expect([...prefix].sort((a, b) => a - b)).toEqual([1, 2]);
    await graduateTable(conn, BASE20, prefix); // must not throw on IDENTITY_INSERT

    const base = await conn.query<{ OBJECTID: number; GLOBALID: string; VAL: string }>(`SELECT OBJECTID, CONVERT(NVARCHAR(36), GLOBALID) AS GLOBALID, VAL FROM dbo.base20 ORDER BY OBJECTID;`);
    expect(base.map(r => ({ oid: Number(r.OBJECTID), gid: r.GLOBALID.toLowerCase(), val: r.VAL }))).toEqual([
      { oid: 100, gid: G(100), val: 'new' },       // update landed, GLOBALID preserved
      { oid: 200, gid: G(200), val: 'brand-new' },  // new add inserted with its explicit OBJECTID
    ]);
    const aLeft = await conn.query(`SELECT 1 FROM dbo.a20 WHERE SDE_STATE_ID IN (1,2);`);
    expect(aLeft.length, 'graduated a-rows removed').toBe(0);
  });

  it('a failed identity-insert does NOT leak SET IDENTITY_INSERT ON to later writes', async () => {
    // Two winner a-rows share a GLOBALID → the graduate base INSERT violates the
    // UNIQUE(GLOBALID) constraint and throws. The in-batch TRY/CATCH must still
    // run SET IDENTITY_INSERT OFF (a ROLLBACK would NOT reset it — it is
    // session-scoped and non-transactional, and the connection is pooled and
    // shared with the app). Proof the flag was reset: a subsequent AUTO-identity
    // insert (no explicit OBJECTID) succeeds — it would fail if the flag were ON.
    await conn.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (1,'t',1,0),(2,'t',1,1);`);
    await conn.execute(`INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (1,1),(1,2);`);
    await conn.execute(`INSERT INTO sde.SDE_versions (name, owner, state_id) VALUES ('DEFAULT','t',2);`);
    await conn.execute(`INSERT INTO dbo.a20 (OBJECTID, SDE_STATE_ID, GLOBALID, VAL) VALUES (100, 2, @p0, 'a'), (200, 2, @p0, 'b');`, [G(500)]);

    const prefix = await computeGraduablePrefix(conn);
    await expect(graduateTable(conn, BASE20, prefix)).rejects.toThrow(); // UNIQUE(GLOBALID) violation

    // The flag must be OFF now: an auto-identity insert must succeed.
    await expect(conn.execute(`INSERT INTO dbo.base20 (GLOBALID, VAL) VALUES (@p0, 'auto');`, [G(999)])).resolves.toBeDefined();
  });
});
