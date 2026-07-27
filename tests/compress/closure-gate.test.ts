/**
 * Step D closure-safety gate (NIGHTLY_COMPRESS_ROADMAP.md §Step D, closure-gate.ts).
 *
 * The clone (parcel_fabric.bak) has a CLEAN, colinear closure and cannot reproduce
 * the hazard, so these tests CONSTRUCT it: a divergent shared-lineage_name topology
 * with a base-shadow delete marker on a graduable OID. They prove:
 *   - assessClosureSafety refuses divergent sharing and stored OVER, allows clean;
 *   - compress() downgrades to prune-only (or throws) when the gate refuses;
 *   - the hazard is REAL and the gate NECESSARY: forcing graduation past the gate
 *     flips a version's CLOSURE-visible (public-map) data to invisible while every
 *     version's WALK-visible (egdb) data is untouched — exactly what the Step C
 *     walk-only self-check cannot catch;
 *   - on a clean fabric graduation preserves closure-visible data.
 *
 * Gated on EGDB_COMPRESS_DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { connectScratch, resetFabric, HAVE_DB, e2eConfig, PARCELS } from './db';
import { installE2ESchema } from './db-e2e';
import { EnterpriseGeodatabase } from '../../src/enterprise-geodatabase';
import {
  assessClosureSafety, ClosureUnsafeError,
  captureVisibleSnapshot, captureClosureSnapshot, compareSnapshots,
  computeGraduablePrefix, graduateTable,
} from '../../src/reconcile';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;
const silent = { debug() {}, info() {}, warn() {}, error() {} };

// Direct low-level fabric construction (no op-model — we need exact topologies).
async function state(c: SqlServerConnection, id: number, parent: number, lineage: number) {
  await c.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (${id},'sde',${lineage},${parent});`);
}
async function version(c: SqlServerConnection, owner: string, name: string, tip: number) {
  await c.execute(`INSERT INTO sde.SDE_versions (name, owner, state_id) VALUES ('${name}','${owner}',${tip});`);
}
async function lineage(c: SqlServerConnection, name: number, id: number) {
  await c.execute(`INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (${name},${id});`);
}
async function add(c: SqlServerConnection, oid: number, stateId: number, val: string) {
  await c.execute(`INSERT INTO dbo.a18 (OBJECTID, SDE_STATE_ID, VAL) VALUES (${oid},${stateId},'${val}');`);
}
/** Esri base-shadow delete marker: hides the BASE row of `oid` wherever DELETED_AT is an ancestor. */
async function baseShadowMarker(c: SqlServerConnection, oid: number, deletedAt: number) {
  await c.execute(`INSERT INTO dbo.D18 (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) VALUES (${oid},0,${deletedAt});`);
}

/**
 * Divergent shared-lineage_name topology (states_cuk-legal):
 *   0 → 1 → 10        DEFAULT (lineage 1), walk {10,1}
 *   1 → 2             DEAD state (lineage 5, no version) — on NO version's walk
 *   1 → 3             version A (lineage 99), walk {3,1}
 *   10 → 11           version B (lineage 99), walk {11,10,1}
 * A and B share lineage 99 on different branches (walks not nested) → DIVERGENT.
 * State 1 is the only common ancestor of {10,3,11} → the graduable prefix.
 * Lineage-99 bag deliberately carries the DEAD state 2, so 2 is OVER for A (in A's
 * closure, id 2 ≤ A's tip 3, but 2 ∉ walk(A)) AND on no version's walk.
 */
async function buildDivergent(c: SqlServerConnection) {
  await resetFabric(c); // seeds state 0 + (0,0)
  await state(c, 1, 0, 1); await state(c, 10, 1, 1);
  await state(c, 2, 1, 5);            // dead
  await state(c, 3, 1, 99); await state(c, 11, 10, 99);
  await version(c, 'sde', 'DEFAULT', 10); await version(c, 'A', 'va', 3); await version(c, 'B', 'vb', 11);
  for (const id of [0, 1, 10]) await lineage(c, 1, id);      // DEFAULT closure == its walk (clean)
  for (const id of [1, 2, 3, 10, 11]) await lineage(c, 99, id); // shared bag incl. dead state 2
}

d('Step D closure-safety gate (DB-backed)', () => {
  let conn: SqlServerConnection;
  let egdb: EnterpriseGeodatabase;
  beforeAll(async () => {
    conn = await connectScratch('egdb_closure_gate');
    await installE2ESchema(conn); // GDB catalog so compress()'s listTables() resolves
    egdb = new (EnterpriseGeodatabase as unknown as new (c: unknown, conn: unknown) => EnterpriseGeodatabase)(
      { ...e2eConfig('egdb_closure_gate'), logger: silent }, conn);
  });
  afterAll(async () => { if (conn) await conn.close(); });
  beforeEach(async () => { await resetFabric(conn); });

  it('assessClosureSafety: refuses a DIVERGENT shared lineage_name', async () => {
    await buildDivergent(conn);
    const r = await assessClosureSafety(conn);
    expect(r.safe).toBe(false);
    expect(r.reasons.some(x => /divergent shared lineage_name 99/.test(x))).toBe(true);
  });

  it('assessClosureSafety: refuses a stored OVER row (colinear, no divergence)', async () => {
    // clean colinear chain 0→1→3, DEFAULT tip 3; then a closure row claiming the dead
    // state 2 (id 2 ≤ tip 3, not on walk {3,1}) → OVER, with NO shared lineage_name.
    await state(conn, 1, 0, 1); await state(conn, 3, 1, 1); await state(conn, 2, 1, 5); // 2 dead
    await version(conn, 'sde', 'DEFAULT', 3);
    for (const id of [0, 1, 3]) await lineage(conn, 1, id);
    expect((await assessClosureSafety(conn)).safe, 'clean before injection').toBe(true);
    await lineage(conn, 1, 2); // inject OVER
    const r = await assessClosureSafety(conn);
    expect(r.safe).toBe(false);
    expect(r.reasons.some(x => /OVER state/.test(x))).toBe(true);
    expect(r.reasons.some(x => /divergent/.test(x)), 'no divergence here').toBe(false);
  });

  it('assessClosureSafety: allows a clean colinear fabric', async () => {
    await state(conn, 1, 0, 1); await state(conn, 2, 1, 1); await state(conn, 3, 2, 1);
    await version(conn, 'sde', 'DEFAULT', 3); await version(conn, 'W', 'vw', 2); // colinear: walk(2)⊆walk(3)
    for (const id of [0, 1, 2, 3]) await lineage(conn, 1, id);
    const r = await assessClosureSafety(conn);
    expect(r.safe, r.reasons.join('; ')).toBe(true);
  });

  it('compress(): unsafe closure + prune requested → downgrades to PRUNE-ONLY', async () => {
    await buildDivergent(conn);
    const r = await egdb.compress({ acknowledgeExperimentalUnsafe: true, phases: { prune: true, graduate: true, collapse: true } });
    expect(r.closureGate?.safe).toBe(false);
    expect(r.graduatedUpserts, 'graduation refused').toBe(0);
    expect(r.lineagesCollapsed, 'collapse refused').toBe(0);
  });

  it('compress(): unsafe closure + graduate-only requested → throws ClosureUnsafeError', async () => {
    await buildDivergent(conn);
    await expect(egdb.compress({ acknowledgeExperimentalUnsafe: true, phases: { graduate: true } }))
      .rejects.toBeInstanceOf(ClosureUnsafeError);
  });

  it('THE HAZARD: forcing graduation past the gate flips CLOSURE-visible data, WALK-visible intact', async () => {
    await buildDivergent(conn);
    // OID 100 introduced by an add at the graduable state 1; a base-shadow marker at
    // the DEAD state 2 (OVER for version A, on no version's walk). Pre-graduation A
    // sees 100 (the add wins); post-graduation 100 is a BASE row the marker at 2 —
    // in A's closure but not its walk — hides.
    await add(conn, 100, 1, 'HELLO');
    await baseShadowMarker(conn, 100, 2);

    const walkBefore = await captureVisibleSnapshot(conn, [PARCELS]);
    const closBefore = await captureClosureSnapshot(conn, [PARCELS]);

    await graduateTable(conn, PARCELS, await computeGraduablePrefix(conn), new Map()); // bypass the gate

    const walkAfter = await captureVisibleSnapshot(conn, [PARCELS]);
    const closAfter = await captureClosureSnapshot(conn, [PARCELS]);

    // egdb (walk) read unchanged for EVERY version — the Step C self-check sees nothing...
    expect(compareSnapshots(walkBefore, walkAfter).passed, 'walk-visible data must be intact').toBe(true);
    // ...yet the Esri closure read FLIPPED (100 vanished for version A) — the public-map
    // corruption. This is why the pre-graduation gate, not the walk self-check, is the control.
    const closDiff = compareSnapshots(closBefore, closAfter);
    expect(closDiff.passed, 'closure-visible data changed').toBe(false);
    expect(closDiff.diffs.some(x => /A\.va/.test(x)), 'version A lost a feature').toBe(true);
  });

  it('clean fabric: graduation preserves CLOSURE-visible data', async () => {
    // colinear 0→1→2→3; DEFAULT tip 3, W tip 2; closure == walk. OID 100 added at the
    // graduable state 1 (moves to base, visible to all); OID 200 added at state 3
    // (non-graduable, DEFAULT-only, stays a delta). No orphaned markers.
    await state(conn, 1, 0, 1); await state(conn, 2, 1, 1); await state(conn, 3, 2, 1);
    await version(conn, 'sde', 'DEFAULT', 3); await version(conn, 'W', 'vw', 2);
    for (const id of [0, 1, 2, 3]) await lineage(conn, 1, id);
    await add(conn, 100, 1, 'BASE'); await add(conn, 200, 3, 'TIP');

    const closBefore = await captureClosureSnapshot(conn, [PARCELS]);
    const r = await egdb.compress({ acknowledgeExperimentalUnsafe: true, phases: { prune: true, graduate: true, collapse: true } });
    expect(r.closureGate?.safe, r.closureGate?.reasons.join('; ')).toBe(true);
    expect(r.graduatedUpserts, '100 graduated to base').toBeGreaterThan(0);
    const closAfter = await captureClosureSnapshot(conn, [PARCELS]);
    expect(compareSnapshots(closBefore, closAfter).passed, 'closure-visible unchanged').toBe(true);
  });
});
