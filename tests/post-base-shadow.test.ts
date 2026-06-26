/**
 * Integration test for the post-time Esri base-shadow marker emit.
 *
 * egdb writes versioned delete markers with the EDIT state for SDE_STATE_ID,
 * which its own reader understands (it matches D rows by `SDE_STATE_ID IN
 * lineage`). But Esri's *_evw views, the publish ETL, and ArcGIS hide a
 * superseded BASE row only when a `SDE_STATE_ID = 0` marker exists -- which
 * egdb never wrote. The effect was that after a post, a retired/merged/updated
 * parcel's stale base row stayed visible to those readers (it leaked to the
 * public map). `postVersion` now emits the standard `SDE_STATE_ID = 0` markers
 * for the rows a post superseded, so every reader hides the old base row.
 *
 * This asserts that end-to-end: edit a base-resident row in a version, post,
 * then (1) the standard base-shadow marker exists and (2) an Esri-style
 * base-half read no longer returns the superseded base row.
 *
 * Hits a live SDE-enabled SQL Server. Skips cleanly when the EGDB_* env vars
 * aren't set, so `yarn test:run` stays fast in CI without a database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EnterpriseGeodatabase, EditSession } from '../src/index';

const SKIP =
  !process.env.EGDB_HOST ||
  !process.env.EGDB_PASSWORD ||
  (process.env.EGDB_DRIVER !== undefined && process.env.EGDB_DRIVER !== 'sqlserver');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set`);
  return value;
}

async function connect(): Promise<EnterpriseGeodatabase> {
  return EnterpriseGeodatabase.connect({
    driver: 'sqlserver',
    server: requireEnv('EGDB_HOST'),
    port: parseInt(requireEnv('EGDB_PORT'), 10),
    database: requireEnv('EGDB_DATABASE'),
    user: requireEnv('EGDB_USER'),
    password: requireEnv('EGDB_PASSWORD'),
    options: { encrypt: false, trustServerCertificate: true },
  });
}

function uniqueVersionName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
}

const TEST_TABLE = process.env.EGDB_TEST_TABLE ?? 'PARCELFABRIC_PLANS';

describe.skipIf(SKIP)('postVersion base-shadow marker emit', () => {
  let egdb: EnterpriseGeodatabase;

  beforeAll(async () => {
    egdb = await connect();
  }, 60000);

  afterAll(async () => {
    await egdb.close();
  });

  it('emits a SDE_STATE_ID=0 marker so a superseded base row is hidden from Esri readers', async () => {
    // Registration id + owning schema for the A/D delta tables of the table.
    const regRow = await egdb.query<{ reg: number; owner: string }>(
      `SELECT registration_id AS reg, owner FROM sde.SDE_table_registry WHERE table_name = @p0`,
      [TEST_TABLE]
    );
    const reg = Number(regRow[0]?.reg);
    const schema = regRow[0]?.owner;
    expect(reg).toBeGreaterThan(0);
    expect(schema).toBeTruthy();

    // Find a feature that is active in DEFAULT AND base-resident: only a row
    // that lives in the base table needs a SDE_STATE_ID=0 shadow marker, and we
    // must be able to read it through the versioned view to edit it. Reading its
    // attributes also lets the edit be a no-op VALUE update -- egdb's D+A update
    // path does not diff, so it still writes a superseding A-row but changes no
    // data, leaving DEFAULT's resolved value untouched.
    const table = await egdb.openTable(TEST_TABLE);
    let current: { id: number; attributes: Record<string, unknown> } | null = null;
    let oid = 0;
    for await (const f of (table as {
      stream(o: { version: string; limit: number }): AsyncIterable<{ id: number; attributes: Record<string, unknown> }>;
    }).stream({ version: 'sde.DEFAULT', limit: 10 })) {
      const inBase = await egdb.query<{ x: number }>(
        `SELECT 1 AS x FROM ${schema}.${TEST_TABLE} WHERE OBJECTID = ${Number(f.id)}`
      );
      if (inBase.length > 0) {
        current = f;
        oid = Number(f.id);
        break;
      }
    }
    expect(current).not.toBeNull();
    expect(oid).toBeGreaterThan(0);
    const field = Object.keys(current!.attributes).find(
      (k) =>
        !/^(objectid|globalid)$/i.test(k) &&
        current!.attributes[k] !== null &&
        typeof current!.attributes[k] !== 'object'
    );
    expect(field).toBeTruthy();

    const versionName = uniqueVersionName('test_baseshadow');
    const v = await egdb.createVersion(versionName, { parent: 'sde.DEFAULT' });
    const fullName = `${v.owner}.${v.name}`;
    let posted = false;
    try {
      const session = await EditSession.start(egdb, fullName);
      await session.update(TEST_TABLE, oid, { [field!]: current!.attributes[field!] });
      await session.save();
      await session.close();

      await egdb.reconcileVersion(fullName);
      const result = await egdb.postVersion(fullName, { deleteVersionAfterPost: true });
      posted = true; // postVersion deleted the version; don't double-delete in finally
      const tip = Number(result.newParentStateId);

      // The parent's (DEFAULT's) closure at its new tip.
      const closure =
        `SELECT l.lineage_id FROM sde.SDE_states s ` +
        `INNER JOIN sde.SDE_state_lineages l ON l.lineage_name = s.lineage_name ` +
        `WHERE s.state_id = ${tip} AND l.lineage_id <= s.state_id`;

      // (1) The post emitted a standard Esri base-shadow marker for the row.
      const marker = await egdb.query<{ s: number }>(
        `SELECT SDE_STATE_ID AS s FROM ${schema}.D${reg} ` +
        `WHERE SDE_DELETES_ROW_ID = ${oid} AND SDE_STATE_ID = 0 AND DELETED_AT IN (${closure})`
      );
      expect(marker.length).toBeGreaterThan(0);

      // (2) An Esri-style base-half read (the publish/_evw pattern) no longer
      //     returns the superseded base row -- it is shadowed.
      const leak = await egdb.query<{ oid: number }>(
        `SELECT b.OBJECTID AS oid FROM ${schema}.${TEST_TABLE} b ` +
        `WHERE b.OBJECTID = ${oid} AND NOT EXISTS (` +
        `  SELECT 1 FROM ${schema}.D${reg} d WHERE d.SDE_DELETES_ROW_ID = b.OBJECTID ` +
        `  AND d.SDE_STATE_ID = 0 AND d.DELETED_AT IN (${closure}))`
      );
      expect(leak.length).toBe(0);
    } finally {
      if (!posted) await egdb.deleteVersion(fullName).catch(() => {});
    }
  }, 120000);
});
