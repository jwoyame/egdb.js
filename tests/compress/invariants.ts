/**
 * Shared invariant assertions for the compress harness. The centrepiece is
 * `snapshotVisible` / `assertVisibleDataUnchanged`: for every version, the set of
 * (OBJECTID -> value) it resolves must be identical before and after a compress
 * that is only supposed to reclaim storage.
 *
 * The DB-side read mirrors the production versioned read (enterprise-table.ts
 * :502-530): base rows minus deletes-in-lineage minus superseded-by-add, UNION
 * the freshest add per OID not deleted afterward. "Lineage" is the authoritative
 * parent_state_id walk from the tip.
 */
import { expect } from 'vitest';
import type { IDatabaseConnection } from '../../src/connections/connection';
import { REG_ID } from './db';

/** Recursive parent_state_id walk from `tip` (edit states, excludes 0), as a CTE. */
const ancCte = (tip: number) => `
  WITH anc AS (
    SELECT state_id, parent_state_id FROM sde.SDE_states WHERE state_id = ${tip}
    UNION ALL
    SELECT s.state_id, s.parent_state_id FROM sde.SDE_states s
      JOIN anc ON s.state_id = anc.parent_state_id WHERE anc.parent_state_id <> 0
  )`;

/** Every version's tip. */
export async function versionTips(conn: IDatabaseConnection): Promise<Array<{ name: string; tip: number }>> {
  const rows = await conn.query<{ name: string; owner: string; state_id: number | bigint }>(
    `SELECT name, owner, state_id FROM sde.SDE_versions WHERE state_id IS NOT NULL;`);
  return rows.map(r => ({ name: `${r.owner}.${r.name}`, tip: Number(r.state_id) }));
}

/** Resolve the visible (OBJECTID -> VAL) set for one version tip, egdb semantics. */
export async function dbVisible(conn: IDatabaseConnection, tip: number, regId: number = REG_ID): Promise<Map<number, string | null>> {
  const sql = `
    ${ancCte(tip)}
    SELECT b.OBJECTID AS oid, b.VAL AS val
    FROM dbo.base${regId} b
    WHERE b.OBJECTID NOT IN (SELECT SDE_DELETES_ROW_ID FROM dbo.D${regId} WHERE DELETED_AT IN (SELECT state_id FROM anc))
      AND b.OBJECTID NOT IN (SELECT OBJECTID FROM dbo.a${regId} WHERE SDE_STATE_ID IN (SELECT state_id FROM anc))
    UNION ALL
    SELECT a.OBJECTID AS oid, a.VAL AS val
    FROM dbo.a${regId} a
    INNER JOIN (
      SELECT OBJECTID AS moid, MAX(SDE_STATE_ID) AS ms FROM dbo.a${regId}
      WHERE SDE_STATE_ID IN (SELECT state_id FROM anc) GROUP BY OBJECTID
    ) m ON m.moid = a.OBJECTID AND m.ms = a.SDE_STATE_ID
    WHERE a.SDE_STATE_ID IN (SELECT state_id FROM anc)
      AND NOT EXISTS (
        SELECT 1 FROM dbo.D${regId} d
        WHERE d.SDE_DELETES_ROW_ID = a.OBJECTID
          AND d.SDE_STATE_ID IN (SELECT state_id FROM anc)
          AND d.SDE_STATE_ID > a.SDE_STATE_ID
      )
    OPTION (MAXRECURSION 0);`;
  const rows = await conn.query<{ oid: number; val: string | null }>(sql);
  const out = new Map<number, string | null>();
  for (const r of rows) out.set(Number(r.oid), r.val);
  return out;
}

export type VisibleSnapshot = Map<string, Map<number, string | null>>;

export async function snapshotVisible(conn: IDatabaseConnection, regId: number = REG_ID): Promise<VisibleSnapshot> {
  const out: VisibleSnapshot = new Map();
  for (const { name, tip } of await versionTips(conn)) out.set(name, await dbVisible(conn, tip, regId));
  return out;
}

function mapEq(a: Map<number, string | null>, b: Map<number, string | null>): string | null {
  if (a.size !== b.size) return `size ${a.size} != ${b.size}`;
  for (const [k, v] of a) { if (!b.has(k)) return `oid ${k} missing after`; if (b.get(k) !== v) return `oid ${k}: '${v}' -> '${b.get(k)}'`; }
  return null;
}

/** THE core property: every version resolves the same data before and after. */
export function assertVisibleDataUnchanged(before: VisibleSnapshot, after: VisibleSnapshot): void {
  const versions = new Set([...before.keys(), ...after.keys()]);
  for (const v of versions) {
    const b = before.get(v), a = after.get(v);
    if (!b || !a) throw new Error(`version ${v} appeared/disappeared`);
    const diff = mapEq(b, a);
    expect(diff, `visible data changed for ${v}: ${diff}`).toBeNull();
  }
}

/** No non-zero parent_state_id points at a missing state. */
export async function assertNoDanglingParents(conn: IDatabaseConnection): Promise<void> {
  const rows = await conn.query<{ state_id: number | bigint }>(
    `SELECT s.state_id FROM sde.SDE_states s WHERE s.parent_state_id <> 0
       AND NOT EXISTS (SELECT 1 FROM sde.SDE_states p WHERE p.state_id = s.parent_state_id);`);
  expect(rows.map(r => Number(r.state_id)), 'dangling parent_state_id').toEqual([]);
}

/** State 0 and the (0,0) lineage row survive. */
export async function assertStateZeroIntact(conn: IDatabaseConnection): Promise<void> {
  const s0 = await conn.query(`SELECT 1 FROM sde.SDE_states WHERE state_id = 0;`);
  const l0 = await conn.query(`SELECT 1 FROM sde.SDE_state_lineages WHERE lineage_name = 0 AND lineage_id = 0;`);
  expect(s0.length, 'state 0 missing').toBe(1);
  expect(l0.length, '(0,0) lineage row missing').toBe(1);
}

/** Every state reference resolves to a live state (or 0). Catches N4/N6/C4 debris. */
export async function assertNoReferencesToDeadStates(conn: IDatabaseConnection): Promise<void> {
  const refs = [
    [`dbo.a${REG_ID}`, 'SDE_STATE_ID'],
    [`dbo.D${REG_ID}`, 'SDE_STATE_ID'],
    [`dbo.D${REG_ID}`, 'DELETED_AT'],
    ['sde.SDE_state_lineages', 'lineage_id'],
    ['sde.SDE_versions', 'state_id'],
    ['sde.SDE_state_locks', 'state_id'],
    ['sde.SDE_mvtables_modified', 'state_id'],
  ] as const;
  for (const [tbl, col] of refs) {
    const rows = await conn.query<{ v: number | bigint }>(
      `SELECT DISTINCT ${col} AS v FROM ${tbl} WHERE ${col} <> 0
         AND NOT EXISTS (SELECT 1 FROM sde.SDE_states s WHERE s.state_id = ${col});`);
    expect(rows.map(r => Number(r.v)), `${tbl}.${col} references dead states`).toEqual([]);
  }
}

/**
 * C0 guard: no base-shadow delete marker (SDE_STATE_ID = 0) whose DELETED_AT is
 * a graduated (no-longer-live) state while the base row is still present — that
 * combination hides a live base row forever with no A-row to restore it.
 */
export async function assertNoShadowMarkerOrphans(conn: IDatabaseConnection): Promise<void> {
  const rows = await conn.query<{ oid: number }>(
    `SELECT d.SDE_DELETES_ROW_ID AS oid FROM dbo.D${REG_ID} d
      WHERE d.SDE_STATE_ID = 0
        AND NOT EXISTS (SELECT 1 FROM sde.SDE_states s WHERE s.state_id = d.DELETED_AT)
        AND EXISTS (SELECT 1 FROM dbo.base${REG_ID} b WHERE b.OBJECTID = d.SDE_DELETES_ROW_ID);`);
  expect(rows.map(r => Number(r.oid)), 'orphaned base-shadow markers (C0)').toEqual([]);
}

/**
 * No single state holds BOTH an A-row and a (non-shadow) D-row for one OID — an
 * SDE state is one atomic edit, so an OID is added XOR deleted there, never both.
 * Collapse's cross-A/D dedupe RELIES on this being true of its inputs; asserting
 * it after compress makes that load-bearing assumption explicit rather than
 * silent (shadow markers with SDE_STATE_ID=0 are excluded — they legitimately
 * co-exist with an A-row at a real state to retire the base row).
 */
export async function assertNoSameStateAddAndDelete(conn: IDatabaseConnection): Promise<void> {
  const rows = await conn.query<{ oid: number; st: number }>(
    `SELECT a.OBJECTID AS oid, a.SDE_STATE_ID AS st FROM dbo.a${REG_ID} a
       JOIN dbo.D${REG_ID} d ON d.SDE_DELETES_ROW_ID = a.OBJECTID AND d.SDE_STATE_ID = a.SDE_STATE_ID
      WHERE d.SDE_STATE_ID <> 0;`);
  expect(rows.map(r => `${Number(r.oid)}@${Number(r.st)}`), 'a state holds both an add and a delete for one OID').toEqual([]);
}

/** Run all structural invariants that must hold after any compress. */
export async function assertStructuralInvariants(conn: IDatabaseConnection): Promise<void> {
  await assertNoDanglingParents(conn);
  await assertStateZeroIntact(conn);
  await assertNoReferencesToDeadStates(conn);
  await assertNoShadowMarkerOrphans(conn);
  await assertNoSameStateAddAndDelete(conn);
}
