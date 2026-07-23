/**
 * Layer 2 — property-based compress sweep (COMPRESS_HARDENING_PLAN.md §6).
 *
 * For each random seed we grow a valid topology, materialise it, run the real
 * DB compress (graduate → prune → collapse, the enterprise-geodatabase order),
 * and assert three properties against the obviously-correct `compressRef` oracle:
 *   1. every version resolves the SAME visible data before and after compress;
 *   2. the DB's post-compress visible data equals the oracle's;
 *   3. the DB's surviving state set equals the oracle's, and all structural
 *      invariants hold (no dangling parents, state 0 intact, no dead refs, no
 *      shadow-marker orphans).
 * On failure the op-log is shrunk to the shortest failing prefix and printed
 * with its seed, ready to paste into a named regression test.
 *
 * Gated on EGDB_COMPRESS_DB. Tune the sweep with EGDB_PROP_SEEDS / EGDB_PROP_LEN.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeGraduablePrefix, graduateTable, pruneStates, collapseLineages } from '../../src/reconcile/compress-impl';
import { compressRef, type Fabric } from './reference-model';
import { connectScratch, resetFabric, HAVE_DB, PARCELS } from './db';
import { materialize, liveStateIds } from './fabric-builder';
import { snapshotVisible, assertVisibleDataUnchanged, assertStructuralInvariants } from './invariants';
import { generate, applyLog, type Op } from './op-model';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;
const SEEDS = Number(process.env.EGDB_PROP_SEEDS ?? 80);
const LEN = Number(process.env.EGDB_PROP_LEN ?? 18);

/** The real DB compress, in the enterprise-geodatabase.compress() phase order. */
async function dbCompress(conn: SqlServerConnection): Promise<void> {
  const prefix = await computeGraduablePrefix(conn);
  await graduateTable(conn, PARCELS, prefix);
  await pruneStates(conn, [PARCELS]);
  await collapseLineages(conn, [PARCELS]);
}

/** Oracle's visible data, projected into the DB snapshot's shape (owner.version → oid → VAL). */
function modelVisible(f: Fabric): Map<string, Map<number, string | null>> {
  const t = f.tables.get('parcels');
  const out = new Map<string, Map<number, string | null>>();
  for (const v of f.versions.keys()) {
    const m = new Map<number, string | null>();
    if (t) for (const [oid, r] of f.visibleEgdb(t, v)) m.set(oid, r.VAL == null ? null : String(r.VAL));
    out.set(`test.${v}`, m);
  }
  return out;
}

function cmpVisible(a: Map<string, Map<number, string | null>>, b: Map<string, Map<number, string | null>>): string | null {
  const vs = new Set([...a.keys(), ...b.keys()]);
  for (const v of vs) {
    const x = a.get(v), y = b.get(v);
    if (!x || !y) return `version ${v} present in only one side`;
    if (x.size !== y.size) return `${v}: size ${x.size} != ${y.size}`;
    for (const [k, val] of x) { if (!y.has(k)) return `${v}: oid ${k} missing`; if (y.get(k) !== val) return `${v}: oid ${k} '${val}' != '${y.get(k)}'`; }
  }
  return null;
}

d('compress property sweep (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => { conn = await connectScratch('egdb_compress_property'); });
  afterAll(async () => { if (conn) await conn.close(); });

  /** Run the full assert pipeline on one fabric; return the first failure or null. */
  async function check(fabric: Fabric): Promise<string | null> {
    await resetFabric(conn);
    await materialize(conn, fabric);
    const before = await snapshotVisible(conn);
    await dbCompress(conn);
    const after = await snapshotVisible(conn);

    // 1. visible data unchanged by the DB compress
    try { assertVisibleDataUnchanged(before, after); } catch (e) { return `visible changed: ${(e as Error).message}`; }

    // 2. DB post-compress == oracle post-compress
    const model = fabric.clone();
    compressRef(model);
    const vdiff = cmpVisible(after, modelVisible(model));
    if (vdiff) return `db vs oracle visible: ${vdiff}`;

    // 3. surviving state set matches the oracle, structure is sound
    const dbStates = await liveStateIds(conn);
    const modelStates = new Set(model.states.keys());
    const missing = [...modelStates].filter(s => !dbStates.has(s));
    const extra = [...dbStates].filter(s => !modelStates.has(s));
    if (missing.length || extra.length) return `live states differ: missing=${missing} extra=${extra}`;
    try { await assertStructuralInvariants(conn); } catch (e) { return `structural invariant: ${(e as Error).message}`; }
    return null;
  }

  /** Shrink a failing log to the shortest prefix that still fails. */
  async function shrink(log: Op[]): Promise<Op[]> {
    let best = log;
    for (let n = 1; n < log.length; n++) {
      const prefix = log.slice(0, n);
      if (await check(applyLog(prefix))) { best = prefix; break; }
    }
    return best;
  }

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed} survives compress`, async () => {
      const { fabric, log } = generate(seed, LEN);
      const fail = await check(fabric);
      if (fail) {
        const shrunk = await shrink(log);
        // eslint-disable-next-line no-console
        console.error(`SEED ${seed} FAILED: ${fail}\nshrunk log (${shrunk.length} ops):\n${JSON.stringify(shrunk, null, 2)}`);
      }
      expect(fail, `seed ${seed}: ${fail}`).toBeNull();
    });
  }
});
