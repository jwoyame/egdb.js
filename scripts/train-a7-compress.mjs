// A7 on the REAL fabric: with a REBASED-but-unposted version present
// (TRACEY.tracey_32922 @ its rebased tip), prove rebase <-> compress interoperate:
//   1. the closure-safety gate (Step D) reports SAFE with the rebased version,
//   2. a prune (Step C self-check on) leaves every version's visible data unchanged,
//   3. the rebased version survives intact + reclaims the orphaned post state.
// Prune-only (the safe default); does NOT graduate/collapse. Test fabric only.
import { EnterpriseGeodatabase, assessClosureSafety } from '../dist/index.js';

const VERSION = process.argv[2] || 'tracey_32922';
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => { log('HARD TIMEOUT 550s'); process.exit(3); }, 550000).unref?.();

const egdb = await EnterpriseGeodatabase.connect({
  driver: 'sqlserver', server: '127.0.0.1', port: Number(process.env.TRAIN_PORT || 11436),
  database: 'parcel_fabric_test', user: 'sde', password: process.env.TRAIN_PASS,
  options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 20000, requestTimeout: 180000 },
});
const conn = egdb.getConnection();
const q1 = async (s, p) => (await egdb.query(s, p))[0];
const LEAF_ORPHANS = `SELECT COUNT(*) AS n FROM sde.SDE_states s
  WHERE s.state_id <> 0 AND NOT EXISTS (SELECT 1 FROM sde.SDE_versions v WHERE v.state_id = s.state_id)
    AND NOT EXISTS (SELECT 1 FROM sde.SDE_states c WHERE c.parent_state_id = s.state_id)`;
const lineageOf = async (st) => Number((await q1(`SELECT lineage_name AS l FROM sde.SDE_states WHERE state_id=@p0`, [st])).l);
const reconciled = async (verTip, defTip) =>
  Number((await q1(`SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_name=@p0 AND lineage_id=@p1`, [await lineageOf(verTip), defTip])).n) > 0;
try {
  const db = (await q1('SELECT DB_NAME() AS db')).db;
  if (!/test/i.test(String(db))) throw new Error(`refusing: DB '${db}' is not a *test* db`);
  log(`connected ${db}`);

  const verTip = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name=@p0`, [VERSION])).s);
  const defTip = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  const reconPre = await reconciled(verTip, defTip);
  const orphansPre = Number((await q1(LEAF_ORPHANS)).n);
  log(`PRE: ${VERSION} tip=${verTip} (reconciled=${reconPre}); DEFAULT tip=${defTip}; leaf-orphan states=${orphansPre}`);

  // (1) Closure-safety gate WITH the rebased version present -- read-only. The
  // precise interoperability assertion is that the REBASED version is not among
  // the reasons (its own-lineage + walk-equal closure => OVER=0). A pre-existing
  // OVER on OTHER versions (e.g. DEFAULT) is a separate closure-repair concern and
  // does NOT block prune (prune is closure-safe; the gate only guards graduate/collapse).
  const gate = await assessClosureSafety(conn);
  const implicated = gate.reasons.filter((r) => r.includes(`.${VERSION}`) || r.includes(`${VERSION} `));
  log(`STEP D gate: safe=${gate.safe}; rebased-version(${VERSION})-implicated=${implicated.length > 0}; total-reasons=${gate.reasons.length}`);
  for (const r of gate.reasons) log(`   reason: ${r.slice(0, 120)}…`);
  if (implicated.length > 0) throw new Error(`the REBASED version ${VERSION} trips Step D -- rebase produced a bad closure: ${implicated.join('; ')}`);

  // (2) Prune (+ optional Step-C self-check with VERIFY=1 -- exhaustive table scan
  // per version, so opt-in on a 245k-parcel fabric). Prune only removes states the
  // parent-walk already ignores; a REFERENCED version's states are never pruned,
  // so the rebased version's data is structurally safe.
  const verify = process.env.VERIFY === '1';
  const res = await egdb.compress({ acknowledgeExperimentalUnsafe: true, phases: { prune: true }, verify });
  log(`COMPRESS(prune) done. selfCheck=${JSON.stringify(res.selfCheck ?? null)}`);
  log(`  result=${JSON.stringify(res)}`);

  // (3) Rebased version intact + orphans reclaimed.
  const verNow = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name=@p0`, [VERSION])).s);
  const defNow = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  const reconNow = await reconciled(verNow, defNow);
  const orphansPost = Number((await q1(LEAF_ORPHANS)).n);
  log(`POST: ${VERSION} tip=${verNow} (intact=${verNow === verTip}, reconciled=${reconNow}); DEFAULT tip=${defNow} (unchanged=${defNow === defTip})`);
  log(`  leaf-orphan states: ${orphansPre} -> ${orphansPost} (reclaimed=${orphansPre - orphansPost})`);
  log(`RESULT: gate safe=${gate.safe}; rebase intact=${verNow === verTip && reconNow}; self-check=${JSON.stringify(res.selfCheck ?? 'n/a')}`);
} catch (e) {
  log(`ABORTED: ${e.message.split('\n')[0]}`);
} finally {
  await egdb.close();
}
process.exit(0);
