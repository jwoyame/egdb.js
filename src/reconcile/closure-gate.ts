/**
 * Pre-graduation / pre-collapse CLOSURE-SAFETY gate (NIGHTLY_COMPRESS_ROADMAP.md
 * Step D §3.1). Graduation lowers a delta value into the BASE table and collapse
 * lowers an add from a child state into its parent; both are irreversible and both
 * feed the Esri closure reader (`_evw` / the nightly publish-ETL). Neither is safe
 * when the `SDE_state_lineages` closure carries ancestry the parent-walk does not:
 * a sibling's base-shadow delete marker sitting in a version's closure can hide a
 * freshly-graduated base row → the feature vanishes from the public map, with the
 * egdb-visible (parent-walk) data still perfectly intact (so the Step C self-check
 * would NOT catch it). See CLOSURE_REPAIR_STEP_D.md §2 for the full mechanism.
 *
 * This is the PREVENTION (a hard refusal before the irreversible write), paired
 * with the Step C self-check which is only detection-after-the-fact. Two refuse
 * conditions, both conservative because graduation cannot be undone:
 *
 *   (1) DIVERGENT shared-`lineage_name`: two version tips share an `L` on DIFFERENT
 *       branches. The closure is one bag per `L`, so it structurally cannot equal
 *       both siblings' ancestry, and any backfill (or the closure read itself)
 *       manufactures OVER for one from the other. Colinear sharing (one tip is an
 *       ancestor of the other) is fine and allowed.
 *   (2) STORED OVER present: some version's closure contains a state that is not a
 *       parent-walk ancestor of its tip (excluding state 0). With zero OVER anywhere
 *       there is no stray marker to weaponise. (UNDER — closure MISSING a walk state
 *       — is not gated: graduation moves that data into base where every reader sees
 *       it unconditionally, so UNDER cannot cause a graduation/collapse flip.)
 */
import type { IDatabaseConnection } from '../connections/connection';

type Driver = 'sqlserver' | 'postgresql';
function sys(driver: Driver, n: 'SDE_states' | 'SDE_versions' | 'SDE_state_lineages'): string {
  return driver === 'sqlserver' ? `sde.${n}` : `sde.${n.toLowerCase()}`;
}
function recCte(driver: Driver): string { return driver === 'sqlserver' ? '' : 'RECURSIVE '; }
function maxRec(driver: Driver): string { return driver === 'sqlserver' ? ' OPTION (MAXRECURSION 0)' : ''; }

export class ClosureUnsafeError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`compress refused: the SDE_state_lineages closure is unsafe for graduation/collapse — ${reasons.join('; ')}`);
    this.name = 'ClosureUnsafeError';
  }
}

export interface ClosureSafety { safe: boolean; reasons: string[]; }

/** Parent-walk ancestor set of `tip` (excludes state 0; a walk from one state is a single chain). */
async function walk(conn: IDatabaseConnection, driver: Driver, tip: number): Promise<Set<number>> {
  const st = sys(driver, 'SDE_states');
  const rows = await conn.query<{ s: number | bigint }>(
    `WITH ${recCte(driver)}anc AS (
        SELECT state_id AS s, parent_state_id AS p FROM ${st} WHERE state_id = ${tip}
        UNION ALL SELECT c.state_id, c.parent_state_id FROM ${st} c JOIN anc ON c.state_id = anc.p WHERE anc.p <> 0)
      SELECT s FROM anc${maxRec(driver)}`);
  return new Set(rows.map(r => Number(r.s)));
}

/**
 * Assess whether the closure is safe for an irreversible graduate/collapse. Read-only.
 * Call only when graduation or collapse is requested; prune does not need it.
 */
export async function assessClosureSafety(conn: IDatabaseConnection): Promise<ClosureSafety> {
  const driver = conn.driver as Driver;
  const V = sys(driver, 'SDE_versions');
  const S = sys(driver, 'SDE_states');
  const L = sys(driver, 'SDE_state_lineages');
  const reasons: string[] = [];

  const versions = await conn.query<{ owner: string; name: string; tip: number | bigint; ln: number | bigint }>(
    `SELECT v.owner, v.name, v.state_id AS tip, s.lineage_name AS ln
       FROM ${V} v JOIN ${S} s ON s.state_id = v.state_id WHERE v.state_id IS NOT NULL`);

  // (1) Divergent shared-lineage_name. Group tips by lineage_name; a group is
  // colinear iff every tip is an ancestor of the group's MAX tip (one parent-walk
  // is a single chain, so subset-of-max ⇒ pairwise nested ⇒ colinear).
  const byLineage = new Map<number, Array<{ label: string; tip: number }>>();
  for (const v of versions) {
    const ln = Number(v.ln);
    const arr = byLineage.get(ln) ?? [];
    arr.push({ label: `${v.owner}.${v.name}`, tip: Number(v.tip) });
    byLineage.set(ln, arr);
  }
  for (const [ln, members] of byLineage) {
    if (members.length < 2) continue;
    const maxTip = Math.max(...members.map(m => m.tip));
    const chain = await walk(conn, driver, maxTip);
    const stray = members.filter(m => m.tip !== maxTip && !chain.has(m.tip));
    if (stray.length > 0) {
      reasons.push(`divergent shared lineage_name ${ln}: [${stray.map(s => `${s.label}@${s.tip}`).join(', ')}] not on the chain of the group's max tip ${maxTip}`);
    }
  }

  // (2) Stored OVER: a closure row (L, id) with id <= tip, id <> 0, id not a
  // parent-walk ancestor of tip. Checked per version (versions are few).
  for (const v of versions) {
    const tip = Number(v.tip); const ln = Number(v.ln);
    const over = await conn.query<{ id: number | bigint }>(
      `WITH ${recCte(driver)}anc AS (
          SELECT state_id AS s, parent_state_id AS p FROM ${S} WHERE state_id = ${tip}
          UNION ALL SELECT c.state_id, c.parent_state_id FROM ${S} c JOIN anc ON c.state_id = anc.p WHERE anc.p <> 0)
        SELECT l.lineage_id AS id FROM ${L} l
        WHERE l.lineage_name = ${ln} AND l.lineage_id <= ${tip} AND l.lineage_id <> 0
          AND l.lineage_id NOT IN (SELECT s FROM anc)${maxRec(driver)}`);
    if (over.length > 0) {
      const ids = over.map(r => Number(r.id));
      reasons.push(`version ${v.owner}.${v.name} (tip ${tip}) closure carries ${ids.length} OVER state(s) not in its walk: ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ' …' : ''}`);
    }
  }

  return { safe: reasons.length === 0, reasons };
}
