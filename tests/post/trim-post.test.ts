/**
 * Trim-post closure invariants, on the synthetic harness (DB-backed, gated on
 * EGDB_COMPRESS_DB like the compress and rebase suites).
 *
 * `postVersion(v, { trimPost: true })` is the production post path. Esri's *_evw
 * views, ArcGIS, and the nightly publish ETL resolve a version through the
 * SDE_state_lineages CLOSURE, while egdb resolves it by walking
 * SDE_states.parent_state_id. A post that advances DEFAULT without writing the
 * closure rows lands the edit for egdb and hides it from every Esri reader, so
 * the closure must stay a superset of DEFAULT's parent walk after every post.
 *
 * Each test therefore reads DEFAULT twice: once the egdb way (`dbVisible`, the
 * parent walk) and once the Esri way (`esriVisible`, the closure), and both must
 * agree with what was posted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EnterpriseGeodatabase } from '../../src/enterprise-geodatabase';
import { connectScratch, resetFabric, HAVE_DB, REG_ID, e2eConfig } from '../compress/db';
import { installE2ESchema } from '../compress/db-e2e';
import { materialize } from '../compress/fabric-builder';
import { assertNoReferencesToDeadStates, dbVisible } from '../compress/invariants';
import { installRebaseProcs, seedIdPool } from '../rebase/sde-procs';
import { Fabric } from '../compress/reference-model';
import type { IDatabaseConnection } from '../../src/connections/connection';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const d = HAVE_DB ? describe : describe.skip;
if (!HAVE_DB) console.warn('[post] EGDB_COMPRESS_DB unset - skipping DB-backed trim-post tests');

const VERSION = 'test.V';
const DEFAULT = 'test.DEFAULT';

// ---- fixtures --------------------------------------------------------------

/**
 * DEFAULT: base row 1 edited to 'default-new' at state 11, plus the base-shadow
 * marker a real post leaves behind so an Esri closure read resolves one row per
 * OBJECTID. Base row 300 is untouched and available for a version to edit.
 *
 * Version V branches off DEFAULT's tip on its OWN lineage_name, which is what
 * SDE_state_new_edit allocates once DEFAULT's tip already has a child. Keeping V
 * off DEFAULT's lineage keeps DEFAULT's closure free of V's unposted states, so
 * the closure reads below see the post and nothing else.
 */
function baseFabric(): Fabric {
  const f = new Fabric();
  const t = f.table('parcels');
  t.base.set(1, { VAL: 'base1' });
  t.base.set(300, { VAL: 'X' });

  f.states.set(10, { stateId: 10, parentStateId: 0, lineageName: 10 });
  f.states.set(11, { stateId: 11, parentStateId: 10, lineageName: 10 });
  f.lineages.add('10:0'); f.lineages.add('10:10'); f.lineages.add('10:11');
  f.versions.set('DEFAULT', 11);
  t.adds.set('1:11', { oid: 1, state: 11, values: { VAL: 'default-new' } });
  t.dels.push({ oid: 1, state: 0, deletedAt: 11 });

  return f;
}

/** Give V a state chain off DEFAULT's tip 11 on lineage 20, reconciled with 11. */
function addVersion(f: Fabric, states: number[]): void {
  let parent = 11;
  for (const s of states) {
    f.states.set(s, { stateId: s, parentStateId: parent, lineageName: 20 });
    parent = s;
  }
  for (const id of [0, 10, 11, ...states]) f.lineages.add(`20:${id}`);
  f.versions.set('V', states[states.length - 1]!);
}

/** V inserts OBJECTID 500 and updates base row 300, in one save (state 12). */
function buildSingleEdit(): Fabric {
  const f = baseFabric();
  const t = f.table('parcels');
  addVersion(f, [12]);
  t.adds.set('500:12', { oid: 500, state: 12, values: { VAL: 'v-insert' } });
  // An update is a delete marker plus a new add row at the same edit state.
  t.adds.set('300:12', { oid: 300, state: 12, values: { VAL: 'v-updated' } });
  t.dels.push({ oid: 300, state: 12, deletedAt: 12 });
  return f;
}

/** V edits OBJECTID 500 in two separate saves; state 13 holds the latest value. */
function buildTwoSaves(): Fabric {
  const f = baseFabric();
  const t = f.table('parcels');
  addVersion(f, [12, 13]);
  t.adds.set('500:12', { oid: 500, state: 12, values: { VAL: 'first-save' } });
  t.adds.set('500:13', { oid: 500, state: 13, values: { VAL: 'second-save' } });
  return f;
}

/** V hard-deletes base row 300 (a delete marker with no add row). */
function buildHardDelete(): Fabric {
  const f = baseFabric();
  const t = f.table('parcels');
  addVersion(f, [12]);
  t.dels.push({ oid: 300, state: 12, deletedAt: 12 });
  return f;
}

// ---- reads -----------------------------------------------------------------

/** The states an Esri reader sees at `tip`: the closure of the tip's lineage. */
const closureSql = (tip: number) =>
  `SELECT l.lineage_id FROM sde.SDE_states s
     INNER JOIN sde.SDE_state_lineages l ON l.lineage_name = s.lineage_name
    WHERE s.state_id = ${tip} AND l.lineage_id <= s.state_id`;

/** The authoritative ancestry: the parent_state_id walk up from `tip`. */
async function walkStates(conn: IDatabaseConnection, tip: number): Promise<number[]> {
  const rows = await conn.query<{ state_id: number | bigint }>(`
    WITH anc AS (
      SELECT state_id, parent_state_id FROM sde.SDE_states WHERE state_id = ${tip}
      UNION ALL
      SELECT s.state_id, s.parent_state_id FROM sde.SDE_states s
        JOIN anc ON s.state_id = anc.parent_state_id WHERE anc.parent_state_id > 0
    )
    SELECT state_id FROM anc ORDER BY state_id OPTION (MAXRECURSION 0);`);
  return rows.map(r => Number(r.state_id));
}

/** States on the tip's parent walk that the closure does not list. Must be empty. */
async function walkStatesMissingFromClosure(conn: IDatabaseConnection, tip: number): Promise<number[]> {
  const rows = await conn.query<{ state_id: number | bigint }>(`
    WITH anc AS (
      SELECT state_id, parent_state_id FROM sde.SDE_states WHERE state_id = ${tip}
      UNION ALL
      SELECT s.state_id, s.parent_state_id FROM sde.SDE_states s
        JOIN anc ON s.state_id = anc.parent_state_id WHERE anc.parent_state_id > 0
    )
    SELECT a.state_id FROM anc a
     WHERE NOT EXISTS (
       SELECT 1 FROM sde.SDE_state_lineages l JOIN sde.SDE_states s ON s.state_id = ${tip}
        WHERE l.lineage_name = s.lineage_name AND l.lineage_id = a.state_id)
     ORDER BY a.state_id OPTION (MAXRECURSION 0);`);
  return rows.map(r => Number(r.state_id));
}

/**
 * Resolve a state the way Esri's *_evw views and the publish ETL do: the newest
 * add row inside the CLOSURE, and base rows that no SDE_STATE_ID = 0 marker in
 * the closure retires.
 *
 * An OBJECTID that comes back twice is a real defect, not a detail of the read:
 * a base row that keeps its own row alongside the add row that superseded it is
 * how a stale parcel leaks to the published layer. The Map build below refuses
 * to collapse that into one value, so it fails loudly instead.
 */
async function esriVisible(conn: IDatabaseConnection, tip: number): Promise<Map<number, string | null>> {
  const clo = closureSql(tip);
  const rows = await conn.query<{ oid: number; val: string | null }>(`
    SELECT b.OBJECTID AS oid, b.VAL AS val
      FROM dbo.base${REG_ID} b
     WHERE NOT EXISTS (
       SELECT 1 FROM dbo.D${REG_ID} d
        WHERE d.SDE_DELETES_ROW_ID = b.OBJECTID AND d.SDE_STATE_ID = 0
          AND d.DELETED_AT IN (${clo}))
    UNION ALL
    SELECT a.OBJECTID AS oid, a.VAL AS val
      FROM dbo.a${REG_ID} a
     WHERE a.SDE_STATE_ID IN (${clo})
       AND a.SDE_STATE_ID = (
         SELECT MAX(a2.SDE_STATE_ID) FROM dbo.a${REG_ID} a2
          WHERE a2.OBJECTID = a.OBJECTID AND a2.SDE_STATE_ID IN (${clo}))
       AND NOT EXISTS (
         SELECT 1 FROM dbo.D${REG_ID} dd
          WHERE dd.SDE_DELETES_ROW_ID = a.OBJECTID AND dd.SDE_STATE_ID IN (${clo})
            AND dd.SDE_STATE_ID > a.SDE_STATE_ID);`);
  const out = new Map<number, string | null>();
  for (const r of rows) {
    const oid = Number(r.oid);
    if (out.has(oid)) {
      throw new Error(`Esri closure read at state ${tip} resolved OBJECTID ${oid} twice ` +
        `('${out.get(oid)}' and '${r.val}')`);
    }
    out.set(oid, r.val);
  }
  return out;
}

async function countAt(conn: IDatabaseConnection, sql: string): Promise<number> {
  const r = await conn.query<{ n: number | bigint }>(sql);
  return Number(r[0]!.n);
}

const locksOn = (conn: IDatabaseConnection, tip: number) =>
  countAt(conn, `SELECT COUNT(*) AS n FROM sde.SDE_state_locks WHERE state_id = ${tip};`);

/** OBJECTIDs holding more than one add row at `state`. */
async function duplicateARowOids(conn: IDatabaseConnection, state: number): Promise<number[]> {
  const rows = await conn.query<{ oid: number }>(`
    SELECT OBJECTID AS oid FROM dbo.a${REG_ID}
     WHERE SDE_STATE_ID = ${state} GROUP BY OBJECTID HAVING COUNT(*) > 1;`);
  return rows.map(r => Number(r.oid));
}

async function tipOf(conn: IDatabaseConnection, version: string): Promise<number> {
  const [owner, name] = [version.split('.')[0], version.split('.').slice(1).join('.')];
  const r = await conn.query<{ state_id: number | bigint }>(
    `SELECT state_id FROM sde.SDE_versions WHERE owner = @p0 AND name = @p1;`, [owner, name]);
  return Number(r[0]!.state_id);
}

// ---- harness procs ---------------------------------------------------------

/** Column listVersions selects but the synthetic SDE_versions lacks; add it. */
async function ensureVersionColumns(conn: IDatabaseConnection): Promise<void> {
  await conn.execute(`IF COL_LENGTH('sde.SDE_versions','creation_time') IS NULL
    ALTER TABLE sde.SDE_versions ADD creation_time DATETIME NULL;`);
}

/**
 * A synthetic sde.delete_version for the deleteVersionAfterPost path. It drops
 * the version row and then reclaims everything no surviving version can reach:
 * states, their delta rows, closure rows and locks. That is the aggressive
 * reading on purpose - if a post left DEFAULT depending on the posted version's
 * own states instead of copying the deltas onto DEFAULT's new tip, deleting the
 * version takes DEFAULT's data with it and the test says so.
 */
async function installDeleteVersionProc(conn: IDatabaseConnection): Promise<void> {
  await conn.execute(`
    CREATE OR ALTER PROCEDURE sde.delete_version @version NVARCHAR(128) AS
    BEGIN
      SET NOCOUNT ON;
      DECLARE @dot INT = CHARINDEX('.', @version);
      DECLARE @owner NVARCHAR(32) = LEFT(@version, @dot - 1);
      DECLARE @name NVARCHAR(64) = SUBSTRING(@version, @dot + 1, 128);
      DELETE FROM sde.SDE_versions WHERE owner = @owner AND name = @name;

      CREATE TABLE #keep (state_id BIGINT PRIMARY KEY);
      INSERT INTO #keep (state_id) VALUES (0);
      ;WITH reach AS (
        SELECT s.state_id, s.parent_state_id FROM sde.SDE_states s
          JOIN sde.SDE_versions v ON v.state_id = s.state_id
        UNION ALL
        SELECT p.state_id, p.parent_state_id FROM sde.SDE_states p
          JOIN reach r ON p.state_id = r.parent_state_id
         WHERE r.parent_state_id > 0
      )
      INSERT INTO #keep (state_id)
        SELECT DISTINCT state_id FROM reach WHERE state_id <> 0 OPTION (MAXRECURSION 0);

      DECLARE @sql NVARCHAR(MAX) = N'';
      SELECT @sql = @sql +
        N'DELETE FROM [' + owner + N'].[a' + CAST(registration_id AS NVARCHAR(12)) + N']
            WHERE SDE_STATE_ID NOT IN (SELECT state_id FROM #keep);
          DELETE FROM [' + owner + N'].[D' + CAST(registration_id AS NVARCHAR(12)) + N']
            WHERE SDE_STATE_ID NOT IN (SELECT state_id FROM #keep)
               OR DELETED_AT NOT IN (SELECT state_id FROM #keep);'
        FROM sde.SDE_table_registry;
      IF @sql <> N'' EXEC sp_executesql @sql;

      DELETE FROM sde.SDE_state_locks WHERE state_id NOT IN (SELECT state_id FROM #keep);
      DELETE FROM sde.SDE_mvtables_modified WHERE state_id NOT IN (SELECT state_id FROM #keep);
      DELETE FROM sde.SDE_state_lineages WHERE lineage_id NOT IN (SELECT state_id FROM #keep);
      DELETE FROM sde.SDE_states WHERE state_id NOT IN (SELECT state_id FROM #keep);
      DELETE FROM sde.SDE_state_lineages
        WHERE lineage_name <> 0
          AND lineage_name NOT IN (SELECT lineage_name FROM sde.SDE_states);
      DROP TABLE #keep;
    END`);
}

// ---- tests -----------------------------------------------------------------

d('postVersion({ trimPost: true }) closure invariants', () => {
  let conn: IDatabaseConnection;
  let gdb: EnterpriseGeodatabase;

  beforeAll(async () => {
    conn = await connectScratch('egdb_trimpost_test');
    await installE2ESchema(conn);
    await ensureVersionColumns(conn);
    await installRebaseProcs(conn);
    await installDeleteVersionProc(conn);
    gdb = new (EnterpriseGeodatabase as unknown as new (c: unknown, conn: unknown) => EnterpriseGeodatabase)(
      { ...e2eConfig('egdb_trimpost_test'), logger: silent }, conn);
  });
  afterAll(async () => { if (conn) await conn.close(); });

  async function load(build: () => Fabric): Promise<void> {
    await resetFabric(conn);
    await materialize(conn, build());
    await conn.execute(
      `UPDATE sde.SDE_versions SET parent_name = @p0 WHERE owner = 'test' AND name = 'V';`, [DEFAULT]);
    await seedIdPool(conn);
  }

  it('every state on DEFAULT new tip parent walk is listed in the closure', async () => {
    await load(buildSingleEdit);
    const before = await tipOf(conn, DEFAULT);

    const res = await gdb.postVersion(VERSION, { trimPost: true });
    const tip = res.newParentStateId;
    expect(tip).toBeGreaterThan(before);
    expect(await tipOf(conn, DEFAULT)).toBe(tip);

    expect(await walkStatesMissingFromClosure(conn, tip)).toEqual([]);
    // The walk really did grow, so the check above is not vacuous.
    expect(await walkStates(conn, tip)).toEqual([10, 11, tip]);
  });

  it('the Esri closure read at the new tip returns the posted values', async () => {
    await load(buildSingleEdit);
    const res = await gdb.postVersion(VERSION, { trimPost: true });
    const tip = res.newParentStateId;

    const esri = await esriVisible(conn, tip);
    expect(esri.get(500)).toBe('v-insert');   // the version's insert
    expect(esri.get(300)).toBe('v-updated');  // the version's update of a base row
    expect(esri.get(1)).toBe('default-new');  // DEFAULT's own edit intact

    // egdb's parent-walk reader agrees with the Esri closure reader.
    expect(await dbVisible(conn, tip)).toEqual(esri);
  });

  it('no state lock remains on the new DEFAULT tip', async () => {
    await load(buildSingleEdit);
    const res = await gdb.postVersion(VERSION, { trimPost: true });
    // SDE_state_new_edit locks the state it creates. A lock left on DEFAULT's
    // permanent tip blocks later edits and makes compress skip the branch.
    expect(await locksOn(conn, res.newParentStateId)).toBe(0);
  });

  it('no OBJECTID has more than one add row at the new tip', async () => {
    await load(buildSingleEdit);
    const res = await gdb.postVersion(VERSION, { trimPost: true });
    const tip = res.newParentStateId;
    expect(await duplicateARowOids(conn, tip)).toEqual([]);
    // One row per posted feature, so the copy neither doubled nor skipped one.
    expect(await countAt(conn,
      `SELECT COUNT(*) AS n FROM dbo.a${REG_ID} WHERE SDE_STATE_ID = ${tip};`)).toBe(2);
  });

  it('an OBJECTID edited in two saves publishes the latest value, exactly once', async () => {
    await load(buildTwoSaves);
    const res = await gdb.postVersion(VERSION, { trimPost: true });
    const tip = res.newParentStateId;

    // The post must copy the version's TIP row. Copying an earlier save would
    // publish stale content to every reader.
    const esri = await esriVisible(conn, tip);
    expect(esri.get(500)).toBe('second-save');
    expect(await dbVisible(conn, tip)).toEqual(esri);
    expect(await countAt(conn,
      `SELECT COUNT(*) AS n FROM dbo.a${REG_ID} WHERE OBJECTID = 500 AND SDE_STATE_ID = ${tip};`)).toBe(1);
    expect(await walkStatesMissingFromClosure(conn, tip)).toEqual([]);
  });

  it('a hard delete of a base row leaves a base-shadow marker inside DEFAULT closure', async () => {
    await load(buildHardDelete);
    const res = await gdb.postVersion(VERSION, { trimPost: true });
    const tip = res.newParentStateId;

    // The base row survives (compress removes it later); Esri readers hide it
    // only on a SDE_STATE_ID = 0 marker whose DELETED_AT is in the closure.
    expect(await countAt(conn,
      `SELECT COUNT(*) AS n FROM dbo.base${REG_ID} WHERE OBJECTID = 300;`)).toBe(1);
    expect(await countAt(conn, `
      SELECT COUNT(*) AS n FROM dbo.D${REG_ID} d
       WHERE d.SDE_DELETES_ROW_ID = 300 AND d.SDE_STATE_ID = 0
         AND d.DELETED_AT IN (${closureSql(tip)});`)).toBe(1);

    const esri = await esriVisible(conn, tip);
    expect(esri.has(300)).toBe(false);
    expect(await dbVisible(conn, tip)).toEqual(esri);
    expect(await walkStatesMissingFromClosure(conn, tip)).toEqual([]);
  });

  it('posting the same version twice is rejected and leaves DEFAULT unchanged', async () => {
    await load(buildSingleEdit);
    const res = await gdb.postVersion(VERSION, { trimPost: true });
    const tip = res.newParentStateId;
    const esri = await esriVisible(conn, tip);
    const states = await countAt(conn, `SELECT COUNT(*) AS n FROM sde.SDE_states;`);

    await expect(gdb.postVersion(VERSION, { trimPost: true }))
      .rejects.toThrow(/no longer reconciled/i);

    expect(await tipOf(conn, DEFAULT)).toBe(tip);
    expect(await esriVisible(conn, tip)).toEqual(esri);
    // The refused post rolled back the state it had created.
    expect(await countAt(conn, `SELECT COUNT(*) AS n FROM sde.SDE_states;`)).toBe(states);
    expect(await countAt(conn,
      `SELECT COUNT(*) AS n FROM dbo.a${REG_ID} WHERE OBJECTID = 500;`)).toBe(2); // version's row + the post's copy
  });

  it('the closure and Esri-read checks report the damage they guard against', async () => {
    // A green suite is only worth what its oracles can see, so run both checks
    // against fabrics that carry the damage and confirm they say so.
    await resetFabric(conn);
    const sparse = buildSingleEdit();
    sparse.lineages.delete('20:12'); // the sparse closure an ArcMap edit leaves
    await materialize(conn, sparse);
    expect(await walkStatesMissingFromClosure(conn, 12)).toEqual([12]);

    // Nothing has emitted a base-shadow marker for the version's update of base
    // row 300 yet, so an Esri closure read resolves the stale base row next to
    // the new add row. That double resolve is what leaks a retired parcel.
    await load(buildSingleEdit);
    await expect(esriVisible(conn, 12)).rejects.toThrow(/OBJECTID 300 twice/);
  });

  it('trimPost with deleteVersionAfterPost lands the edit and leaves the closure clean', async () => {
    await load(buildSingleEdit);
    const res = await gdb.postVersion(VERSION, { trimPost: true, deleteVersionAfterPost: true });
    const tip = res.newParentStateId;

    expect(await gdb.getVersion(VERSION)).toBeNull();
    expect(await tipOf(conn, DEFAULT)).toBe(tip);

    // Tearing the version down reclaims its states. DEFAULT keeps the posted
    // content because the post copied it onto DEFAULT's own new tip.
    const esri = await esriVisible(conn, tip);
    expect(esri.get(500)).toBe('v-insert');
    expect(esri.get(300)).toBe('v-updated');
    expect(esri.get(1)).toBe('default-new');
    expect(await dbVisible(conn, tip)).toEqual(esri);

    expect(await walkStatesMissingFromClosure(conn, tip)).toEqual([]);
    await assertNoReferencesToDeadStates(conn);
  });
});
