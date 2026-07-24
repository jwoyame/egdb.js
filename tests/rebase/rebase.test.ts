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
import { buildOrphan, expectedAfterRebase, diffMaps } from './rebase-model';
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

  // DEFECT A (open): the rework seeds only [newState] into the closure, so
  // isReconciled — a pure closure lookup for (child lineage, parent tip) — is
  // false, and postVersion refuses. A rebased version must be postable.
  it.fails('DEFECT A: a rebased version is reconciled with DEFAULT (postable)', async () => {
    const fx = await loadOrphan();
    await gdb.rebaseVersion(fx.version, { unsafeExperimental: true });
    expect(await isReconciledInDb(conn, fx.version, fx.parent)).toBe(true);
  });
});
