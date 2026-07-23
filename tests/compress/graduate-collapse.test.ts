/**
 * DB-backed red tests for the two nastiest phase bugs:
 *   C0  graduation orphans base-shadow markers → a posted update vanishes
 *   C3  collapse violates states_cuk on a 3-state run (corrupts, then aborts)
 * Red against today's code; green once fixed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { computeGraduablePrefix, graduateTable, collapseLineages } from '../../src/reconcile/compress-impl';
import { Fabric } from './reference-model';
import { connectScratch, resetFabric, HAVE_DB, PARCELS } from './db';
import { materialize } from './fabric-builder';
import { snapshotVisible, assertVisibleDataUnchanged, assertNoShadowMarkerOrphans, assertStructuralInvariants } from './invariants';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;

d('compress graduate/collapse bugs (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => { conn = await connectScratch('egdb_compress_grad'); });
  afterAll(async () => { if (conn) await conn.close(); });
  beforeEach(async () => { await resetFabric(conn); });

  function st(f: Fabric, id: number, parent: number, lineage: number) {
    f.states.set(id, { stateId: id, parentStateId: parent, lineageName: lineage });
    // maintain a clean closure so computeGraduablePrefix works normally
    for (const key of [...f.lineages]) {
      const [ln, lid] = key.split(':').map(Number);
      if (ln === f.states.get(parent)!.lineageName) f.lineages.add(`${lineage}:${lid}`);
    }
    f.lineages.add(`${lineage}:${id}`);
  }

  it('C0: graduating a posted UPDATE must not make the feature vanish', async () => {
    // DEFAULT at state 1. Base row {100:'old'}; an update posted at state 1
    // wrote a NEW a-row {100:'new'} plus the Esri base-shadow marker
    // (100, SDE_STATE_ID=0, DELETED_AT=1). DEFAULT sees 'new'. Graduation moves
    // the a-row into base but (buggily) leaves the shadow marker, so the base row
    // is hidden with no a-row to restore it → the feature disappears.
    const f = new Fabric();
    st(f, 1, 0, 1);
    f.versions.set('DEFAULT', 1);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'old' });
    t.adds.set('100:1', { oid: 100, state: 1, values: { VAL: 'new' } });
    t.dels.push({ oid: 100, state: 0, deletedAt: 1 }); // base-shadow marker
    await materialize(conn, f);

    const before = await snapshotVisible(conn);
    expect(before.get('test.DEFAULT')!.get(100)).toBe('new');

    const prefix = await computeGraduablePrefix(conn);
    await graduateTable(conn, PARCELS, prefix);

    const after = await snapshotVisible(conn);
    assertVisibleDataUnchanged(before, after);      // must still see 'new'
    await assertNoShadowMarkerOrphans(conn);
  });

  it('C3: collapse must not corrupt or abort on a 3-state linear run', async () => {
    // 0 <- 1 <- 2 <- 3 (DEFAULT at tip 3), all on one lineage_name (a linear run
    // from SDE_state_new_edit). Collapse pairs (1,2). Re-pointing 3's parent to 1
    // without flipping lineage_name collides with the not-yet-deleted state 2 on
    // states_cuk(parent_state_id, lineage_name) → the per-table delta moves have
    // already committed, then the metadata UPDATE throws. Correct behaviour:
    // succeed atomically with visible data unchanged.
    const f = new Fabric();
    st(f, 1, 0, 1);
    st(f, 2, 1, 1);
    st(f, 3, 2, 1);
    f.versions.set('DEFAULT', 3);
    f.table('parcels').adds.set('100:2', { oid: 100, state: 2, values: { VAL: 'edit-at-2' } });
    await materialize(conn, f);

    const before = await snapshotVisible(conn);
    expect(before.get('test.DEFAULT')!.get(100)).toBe('edit-at-2');

    await collapseLineages(conn, [PARCELS]); // red: throws on states_cuk today

    const after = await snapshotVisible(conn);
    assertVisibleDataUnchanged(before, after);
  });

  it('C0×collapse: collapsing a state whose base-shadow marker DELETED_AT lands on it does not resurrect', async () => {
    // Bounds the residual C0 family the vet flagged: a trim-post UPDATE of a BASE
    // row emits an A-row at the edit state PLUS a base-shadow marker
    // (oid, SDE_STATE_ID=0, DELETED_AT=<edit state>) that retires the base row.
    // 0 <- 1 <- 2 <- 3 (DEFAULT@3). Base {100:'old'}. Update-in-place at state 2:
    // A-row 100@2 'new' + shadow (100,0,DELETED_AT=2). Collapse rewrites the
    // shadow's DELETED_AT 2->1 while the A-row rides along; the read must still
    // resolve 'new' (the A-row wins), never resurrect the retired 'old' base row.
    const f = new Fabric();
    st(f, 1, 0, 1);
    st(f, 2, 1, 1);
    st(f, 3, 2, 1);
    f.versions.set('DEFAULT', 3);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'old' });
    t.adds.set('100:2', { oid: 100, state: 2, values: { VAL: 'new' } });
    t.dels.push({ oid: 100, state: 0, deletedAt: 2 }); // base-shadow marker
    await materialize(conn, f);

    const before = await snapshotVisible(conn);
    expect(before.get('test.DEFAULT')!.get(100)).toBe('new');

    await collapseLineages(conn, [PARCELS]);

    const after = await snapshotVisible(conn);
    assertVisibleDataUnchanged(before, after);   // still 'new', 'old' never returns
    await assertStructuralInvariants(conn);       // incl. assertNoShadowMarkerOrphans
  });
});
