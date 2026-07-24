/**
 * The ONE end-to-end test through EnterpriseGeodatabase.compress()
 * (COMPRESS_HARDENING_PLAN.md §6.2). Everything else drives compress-impl
 * functions directly with hand-built TableInfo; this run keeps the real public
 * entry point honest: listTables() (GDB catalog → registrationId + isVersioned),
 * the two safety guards, the graduate→prune→collapse order, and CompressOptions
 * scoping (N2 — an excluded table must still be pruned/collapsed, never left with
 * dangling state references).
 *
 * Gated on EGDB_COMPRESS_DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EnterpriseGeodatabase } from '../../src/enterprise-geodatabase';
import { connectScratch, resetFabric, HAVE_DB } from './db';
import { materialize } from './fabric-builder';
import { installE2ESchema, copy18to19, E2E_TABLES } from './db-e2e';
import { snapshotVisible, assertVisibleDataUnchanged, assertStructuralInvariants } from './invariants';
import { generate } from './op-model';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

d('compress end-to-end via EnterpriseGeodatabase.compress() (DB-backed)', () => {
  let conn: SqlServerConnection;
  let egdb: EnterpriseGeodatabase;
  beforeAll(async () => {
    conn = await connectScratch('egdb_compress_e2e');
    await installE2ESchema(conn);
    // Construct over the existing scratch connection (bypass static connect's own
    // connect()/verifyGeodatabase()); config only needs the driver + logger.
    egdb = new (EnterpriseGeodatabase as unknown as new (c: unknown, conn: unknown) => EnterpriseGeodatabase)(
      { driver: 'sqlserver', logger: silent }, conn);
  });
  afterAll(async () => { if (conn) await conn.close(); });
  beforeEach(async () => { await resetFabric(conn); });

  it('listTables() resolves the catalog into two versioned tables', async () => {
    const tables = await egdb.listTables();
    const versioned = tables.filter(t => t.isVersioned);
    expect(versioned.map(t => t.name).sort()).toEqual(['base18', 'base19']);
    expect(versioned.find(t => t.name === 'base18')!.registrationId).toBe(18);
  });

  it('refuses without acknowledgeExperimentalUnsafe', async () => {
    await expect(egdb.compress()).rejects.toThrow(/experimental/i);
  });

  it('refuses inside an open transaction', async () => {
    await conn.beginTransaction();
    try {
      await expect(egdb.compress({ acknowledgeExperimentalUnsafe: true })).rejects.toThrow(/transaction/i);
    } finally {
      if (conn.inTransaction()) await conn.rollbackTransaction();
    }
  });

  it('a full compress preserves every version on both tables', async () => {
    await materialize(conn, generate(72, 18).fabric);
    await copy18to19(conn);
    const before18 = await snapshotVisible(conn, 18);
    const before19 = await snapshotVisible(conn, 19);

    const res = await egdb.compress({ acknowledgeExperimentalUnsafe: true, phases: { prune: true, graduate: true, collapse: true } });
    expect(res).toBeDefined();

    assertVisibleDataUnchanged(before18, await snapshotVisible(conn, 18));
    assertVisibleDataUnchanged(before19, await snapshotVisible(conn, 19));
    await assertStructuralInvariants(conn);
  });

  it('phases: omitted defaults to prune-only; explicit toggles run exactly what is set', async () => {
    // Prune-only default must NOT graduate (base tables untouched) and must NOT
    // collapse (state count only drops by pruned states, not collapsed ones).
    await materialize(conn, generate(72, 18).fabric);
    await copy18to19(conn);
    const base18Before = await conn.query<{ n: number }>(`SELECT COUNT(*) AS n FROM dbo.base18;`);
    const r = await egdb.compress({ acknowledgeExperimentalUnsafe: true }); // omitted → prune-only
    expect(r.graduatedUpserts, 'prune-only must not graduate').toBe(0);
    expect(r.lineagesCollapsed, 'prune-only must not collapse').toBe(0);
    const base18After = await conn.query<{ n: number }>(`SELECT COUNT(*) AS n FROM dbo.base18;`);
    expect(Number(base18After[0]!.n), 'base unchanged by prune-only').toBe(Number(base18Before[0]!.n));

    // Explicit collapse-only: no graduation, but collapses may occur.
    await resetFabric(conn); await materialize(conn, generate(72, 18).fabric);
    const r2 = await egdb.compress({ acknowledgeExperimentalUnsafe: true, phases: { collapse: true } });
    expect(r2.graduatedUpserts, 'collapse-only must not graduate').toBe(0);
    expect(r2.statesRemoved, 'collapse-only must not prune').toBe(0);
  });

  it('N2: scoping graduation to one table still prunes/collapses the excluded one safely', async () => {
    await materialize(conn, generate(41, 20).fabric);
    await copy18to19(conn);
    const before18 = await snapshotVisible(conn, 18);
    const before19 = await snapshotVisible(conn, 19);

    // Graduate base18 only; prune & collapse must still run over base19 (N2) so it
    // is never left with delta rows tagged to a pruned/collapsed-away state.
    await egdb.compress({ acknowledgeExperimentalUnsafe: true, tables: ['base18'], phases: { prune: true, graduate: true, collapse: true } });

    assertVisibleDataUnchanged(before18, await snapshotVisible(conn, 18));
    assertVisibleDataUnchanged(before19, await snapshotVisible(conn, 19));
    await assertStructuralInvariants(conn); // reg18 a/D refs
    // Explicitly: base19 has no delta row pointing at a now-dead state.
    const deadRefs = await conn.query<{ v: number }>(`
      SELECT SDE_STATE_ID AS v FROM dbo.a19 WHERE SDE_STATE_ID <> 0 AND SDE_STATE_ID NOT IN (SELECT state_id FROM sde.SDE_states)
      UNION SELECT SDE_STATE_ID FROM dbo.D19 WHERE SDE_STATE_ID <> 0 AND SDE_STATE_ID NOT IN (SELECT state_id FROM sde.SDE_states)
      UNION SELECT DELETED_AT FROM dbo.D19 WHERE DELETED_AT <> 0 AND DELETED_AT NOT IN (SELECT state_id FROM sde.SDE_states);`);
    expect(deadRefs.map(r => Number(r.v)), 'base19 references a dead state (N2)').toEqual([]);
  });
});
