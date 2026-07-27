/**
 * Rebase harness — built on the compress harness infrastructure (reference
 * model, synthetic schema, snapshot invariants) per COMPRESS_HARDENING_PLAN.md
 * §6, extended for `rebaseVersion`.
 *
 * DB-backed, gated on EGDB_COMPRESS_DB (docker/sqlserver up). Runs against a
 * SEPARATE scratch DB from the compress suite.
 *
 * What each test targets is named. The invariants that the rebase rework already
 * satisfies run as normal `it`. The known-OPEN defects (documented on
 * `rebaseVersion`) are pinned as `it.fails` — the assertion states the CORRECT
 * behaviour, and `.fails` records that today's code does not meet it, so fixing
 * the defect turns the test red until the `.fails` is removed. That is the
 * red-before-green contract, without a permanently red suite.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { EnterpriseGeodatabase } from '../../src/enterprise-geodatabase';
import { connectScratch, resetFabric, HAVE_DB, REG_ID } from '../compress/db';
import { installE2ESchema } from '../compress/db-e2e';
import { materialize } from '../compress/fabric-builder';
import { dbVisible, snapshotVisible } from '../compress/invariants';
import { installRebaseProcs, seedIdPool } from './sde-procs';
import {
  buildOrphan, buildResidueConflict, buildEditorDeletes, buildParentDeleteConflict,
  expectedAfterRebase, diffMaps,
} from './rebase-model';
import type { IDatabaseConnection } from '../../src/connections/connection';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const d = HAVE_DB ? describe : describe.skip;
if (!HAVE_DB) console.warn('[rebase] EGDB_COMPRESS_DB unset — skipping DB-backed rebase tests');

/** Column listVersions selects but the synthetic SDE_versions lacks; add it. */
async function ensureVersionColumns(conn: IDatabaseConnection): Promise<void> {
  await conn.execute(`IF COL_LENGTH('sde.SDE_versions','creation_time') IS NULL
    ALTER TABLE sde.SDE_versions ADD creation_time DATETIME NULL;`);
}

/** Resolve a version's tip and its visible set, by name (owner.name). */
async function visibleOf(conn: IDatabaseConnection, name: string): Promise<Map<number, string | null>> {
  const owner = name.split('.')[0], nm = name.split('.').slice(1).join('.');
  const rows = await conn.query<{ state_id: number | bigint }>(
    `SELECT state_id FROM sde.SDE_versions WHERE owner=@p0 AND name=@p1;`, [owner, nm]);
  return dbVisible(conn, Number(rows[0]!.state_id), REG_ID);
}

async function lineageNameOf(conn: IDatabaseConnection, name: string): Promise<{ tip: number; lineage: number }> {
  const owner = name.split('.')[0], nm = name.split('.').slice(1).join('.');
  const r = await conn.query<{ tip: number | bigint; lineage: number | bigint }>(
    `SELECT v.state_id AS tip, s.lineage_name AS lineage
       FROM sde.SDE_versions v JOIN sde.SDE_states s ON s.state_id = v.state_id
      WHERE v.owner=@p0 AND v.name=@p1;`, [owner, nm]);
  return { tip: Number(r[0]!.tip), lineage: Number(r[0]!.lineage) };
}

/** isReconciled's exact predicate: closure has (child lineage_name, parent tip). */
async function isReconciledInDb(conn: IDatabaseConnection, version: string, parent: string): Promise<boolean> {
  const v = await lineageNameOf(conn, version);
  const p = await lineageNameOf(conn, parent);
  const r = await conn.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_name=@p0 AND lineage_id=@p1;`,
    [v.lineage, p.tip]);
  return Number(r[0]!.n) > 0;
}

async function inParentClosure(conn: IDatabaseConnection, version: string, parent: string): Promise<number> {
  const v = await lineageNameOf(conn, version);
  const p = await lineageNameOf(conn, parent);
  const r = await conn.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_name=@p0 AND lineage_id=@p1;`,
    [p.lineage, v.tip]);
  return Number(r[0]!.n);
}

d('rebaseVersion harness (DB-backed)', () => {
  let conn: IDatabaseConnection;
  let gdb: EnterpriseGeodatabase;

  beforeAll(async () => {
    conn = await connectScratch('egdb_rebase_test');
    await installE2ESchema(conn);
    await ensureVersionColumns(conn);
    await installRebaseProcs(conn);
    gdb = new (EnterpriseGeodatabase as unknown as new (c: unknown, conn: unknown) => EnterpriseGeodatabase)(
      { driver: 'sqlserver', logger: silent }, conn);
  });
  afterAll(async () => { if (conn) await conn.close(); });

  async function loadOrphan() {
    await resetFabric(conn);
    const fx = buildOrphan();
    await materialize(conn, fx.f);
    // materialize doesn't set parent linkage; a rebase needs it.
    await conn.execute(`UPDATE sde.SDE_versions SET parent_name=@p0 WHERE owner='test' AND name='V';`, [fx.parent]);
    await seedIdPool(conn);
    return fx;
  }

  it('refuses to write without unsafeExperimental (gate holds)', async () => {
    await loadOrphan();
    await expect(gdb.rebaseVersion('test.V')).rejects.toThrow(/not production ready|experimental/i);
  });

  it('dry run reports the plan and writes nothing', async () => {
    const fx = await loadOrphan();
    const before = await snapshotVisible(conn);
    const plan = await gdb.rebaseVersion(fx.version, { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.toState).toBeNull();
    const after = await snapshotVisible(conn);
    expect(after).toEqual(before); // no writes
  });

  it('rebases the orphan: identity kept, own lineage, no DEFAULT-closure leak', async () => {
    const fx = await loadOrphan();
    const res = await gdb.rebaseVersion(fx.version, { unsafeExperimental: true });

    // identity: same version row, moved onto a new state under the parent tip.
    const after = await lineageNameOf(conn, fx.version);
    expect(after.tip).toBe(res.toState);
    const parent = await lineageNameOf(conn, fx.parent);
    const parentRow = await conn.query<{ p: number }>(
      `SELECT parent_state_id AS p FROM sde.SDE_states WHERE state_id=@p0;`, [after.tip]);
    expect(Number(parentRow[0]!.p)).toBe(parent.tip); // branched off DEFAULT tip

    // own lineage, and NOT in DEFAULT's closure (the round-1/round-2 leak).
    expect(after.lineage).not.toBe(parent.lineage);
    expect(await inParentClosure(conn, fx.version, fx.parent)).toBe(0);
  });

  it('two-part content invariant: editor edits kept, other OIDs = DEFAULT tip', async () => {
    const fx = await loadOrphan();
    const before = await visibleOf(conn, fx.version);
    const parentVisible = await visibleOf(conn, fx.parent);
    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true });

    const after = await visibleOf(conn, fx.version);
    const expected = expectedAfterRebase(before, parentVisible, fx.editorOids);
    const problems = diffMaps(expected, after);
    expect(problems, problems.join('; ')).toEqual([]);
    // Concretely: OID 1 (not editor-touched) must now read DEFAULT's newer value,
    // and OID 100 (editor) must survive.
    expect(after.get(1)).toBe('default-new');
    expect(after.get(100)).toBe('alex');
  });

  it('DEFAULT is untouched by the rebase (nothing posted)', async () => {
    const fx = await loadOrphan();
    const before = await visibleOf(conn, fx.parent);
    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true });
    expect(await visibleOf(conn, fx.parent)).toEqual(before);
  });

  // DEFECT A/C (fixed): the closure is seeded from the parent walk, so a rebased
  // version is reconciled with DEFAULT (postable) regardless of the
  // SDE_state_new_edit branch taken.
  it('a rebased version is reconciled with DEFAULT (postable) — defect A fixed', async () => {
    const fx = await loadOrphan();
    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true });
    expect(await isReconciledInDb(conn, fx.version, fx.parent)).toBe(true);
  });

  // ---- Defect D: three-way comparison against the common ancestor -------------

  async function loadResidueConflict() {
    await resetFabric(conn);
    const fx = buildResidueConflict();
    await materialize(conn, fx.f);
    await conn.execute(`UPDATE sde.SDE_versions SET parent_name=@p0 WHERE owner='test' AND name='V';`, [fx.parent]);
    await seedIdPool(conn);
    return fx;
  }

  it('DEFECT D fixed: residue the parent re-edited is a CONFLICT, genuine edits are kept', async () => {
    const fx = await loadResidueConflict();
    // Dry run classifies: OID 5 conflict; OID 7 (edit) + 100 (insert) changed;
    // OID 1 (editor-untouched, DEFAULT-changed) is neither.
    const plan = await gdb.rebaseVersion(fx.version, { dryRun: true });
    const conflictOids = plan.conflicts.flatMap((c) => c.objectIds).sort((a, b) => a - b);
    expect(conflictOids).toEqual([5]);
    const changedUpdates = plan.replayed.reduce((n, r) => n + r.updates, 0);
    expect(changedUpdates).toBe(2); // OID 7 and OID 100

    // The tip-only comparison this replaces would have silently replayed OID 5='B'
    // over DEFAULT's 'C'. The three-way refuses instead.
    await expect(gdb.rebaseVersion(fx.version, { unsafeExperimental: true }))
      .rejects.toThrow(/conflict/i);

    // Refusal wrote nothing.
    const v = await lineageNameOf(conn, fx.version);
    expect(v.tip).toBe(5); // still on its orphan state
    expect((await visibleOf(conn, fx.parent)).get(5)).toBe('C'); // DEFAULT intact
  });

  it('acceptConflicts replays the editor value (favour-edit) and keeps the rest', async () => {
    const fx = await loadResidueConflict();
    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true, acceptConflicts: true });
    const after = await visibleOf(conn, fx.version);
    expect(after.get(5)).toBe('B');            // editor's value won (favour-edit)
    expect(after.get(7)).toBe('alex7');        // genuine edit kept
    expect(after.get(100)).toBe('alex');       // genuine insert kept
    expect(after.get(1)).toBe('default-new');  // editor-untouched -> DEFAULT's tip
    expect(await isReconciledInDb(conn, fx.version, fx.parent)).toBe(true);
  });

  // ---- Defect E: delete-aware resolution --------------------------------------

  async function loadFixture(build: () => ReturnType<typeof buildEditorDeletes>) {
    await resetFabric(conn);
    const fx = build();
    await materialize(conn, fx.f);
    await conn.execute(`UPDATE sde.SDE_versions SET parent_name=@p0 WHERE owner='test' AND name='V';`, [fx.parent]);
    await seedIdPool(conn);
    return fx;
  }

  it('DEFECT E fixed: create-then-delete drops, delete-after-reconcile emits a delete', async () => {
    const fx = await loadFixture(buildEditorDeletes);
    const before = await visibleOf(conn, fx.version);
    const parentVisible = await visibleOf(conn, fx.parent);
    // Pre-rebase the version already resolves 200 and 300 as absent (editor deleted).
    expect(before.has(200)).toBe(false);
    expect(before.has(300)).toBe(false);

    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true });

    const after = await visibleOf(conn, fx.version);
    const problems = diffMaps(expectedAfterRebase(before, parentVisible, fx.editorOids), after);
    expect(problems, problems.join('; ')).toEqual([]);
    expect(after.has(200)).toBe(false);        // NOT resurrected (create-then-delete)
    expect(after.has(300)).toBe(false);        // editor's delete kept (no vanish)
    expect(after.get(100)).toBe('alex');       // genuine insert survives
    expect(after.get(1)).toBe('default-new');  // editor-untouched -> DEFAULT's tip
    // DEFAULT still has 300 -- the delete is the version's, not posted.
    expect((await visibleOf(conn, fx.parent)).get(300)).toBe('X');
  });

  it('DEFECT #4 fixed: parent-deleted row the child edited is a CONFLICT', async () => {
    const fx = await loadFixture(buildParentDeleteConflict);
    const plan = await gdb.rebaseVersion(fx.version, { dryRun: true });
    expect(plan.conflicts.flatMap((c) => c.objectIds)).toEqual([400]);

    await expect(gdb.rebaseVersion(fx.version, { unsafeExperimental: true }))
      .rejects.toThrow(/conflict/i);

    // favour-edit resurrects the editor's version of 400 (the owner's call).
    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true, acceptConflicts: true });
    expect((await visibleOf(conn, fx.version)).get(400)).toBe('alex400');
  });
});
