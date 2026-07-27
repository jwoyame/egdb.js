// Undo the POST of one version while KEEPING its rebase, on the TEST fabric.
// trimPost created a new DEFAULT state as a child of the pre-post tip and moved
// DEFAULT's pointer onto it. Undo = repoint DEFAULT's pointer back to the pre-post
// tip (its parent) via updateVersionState's optimistic CAS. The version's rebased
// state is untouched and stays reconciled with the pre-post tip; the orphaned post
// state is reclaimed by a future compress.
import { EnterpriseGeodatabase, updateVersionState } from '../dist/index.js';

const VERSION = process.argv[2] || 'tracey_32922'; // the version whose post to undo
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const egdb = await EnterpriseGeodatabase.connect({
  driver: 'sqlserver', server: '127.0.0.1', port: Number(process.env.TRAIN_PORT || 11436),
  database: 'parcel_fabric_test', user: 'sde', password: process.env.TRAIN_PASS,
  options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 20000, requestTimeout: 30000 },
});
const conn = egdb.getConnection();
const q1 = async (s, p) => (await egdb.query(s, p))[0];
try {
  const db = (await q1('SELECT DB_NAME() AS db')).db;
  if (!/test/i.test(String(db))) throw new Error(`refusing: DB '${db}' is not a *test* db`);

  const defTip = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  const st = await q1(`SELECT parent_state_id AS p, lineage_name AS l FROM sde.SDE_states WHERE state_id=@p0`, [defTip]);
  const prePost = Number(st.p);
  const verTip = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name=@p0`, [VERSION])).s);
  log(`DEFAULT tip=${defTip} (parent/pre-post=${prePost}, lineage=${st.l}); ${VERSION}=${verTip}`);

  // Safety: the post state must be a fresh child of the pre-post tip, reuse its
  // lineage (linear post), and carry NO other version. Otherwise abort.
  if (prePost <= 0) throw new Error('DEFAULT tip has no parent -- not a post state; nothing to undo');
  if (Number(st.l) !== prePost && Number(st.l) !== defTip) {
    log(`note: post-state lineage ${st.l} (pre-post ${prePost}) -- repoint keeps DEFAULT on the pre-post lineage`);
  }
  const others = await egdb.query(`SELECT owner,name FROM sde.SDE_versions WHERE state_id=@p0 AND name<>'DEFAULT'`, [defTip]);
  if (others.length) throw new Error(`refusing: other versions sit on the post state: ${others.map(o=>o.owner+'.'+o.name).join(',')}`);

  // Repoint DEFAULT back to the pre-post tip, CAS-guarded on the current post state.
  const moved = await updateVersionState(conn, 'sde', 'DEFAULT', prePost, defTip);
  if (moved !== 1) throw new Error(`repoint matched ${moved} rows (expected 1) -- DEFAULT moved concurrently; nothing changed`);
  log(`UNDO: DEFAULT repointed ${defTip} -> ${prePost}`);

  // Verify: DEFAULT back to pre-post; version still on its rebased tip & reconciled.
  const defNow = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  const verNow = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name=@p0`, [VERSION])).s);
  const vlin = Number((await q1(`SELECT lineage_name AS l FROM sde.SDE_states WHERE state_id=@p0`, [verNow])).l);
  const recon = Number((await q1(`SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_name=@p0 AND lineage_id=@p1`, [vlin, defNow])).n) > 0;
  log(`VERIFY: DEFAULT=${defNow} (back=${defNow === prePost}); ${VERSION}=${verNow} (rebase intact=${verNow === verTip}); reconciled=${recon}`);
  log(`RESULT: post undone, rebase kept. Orphaned post state ${defTip} will be reclaimed by a compress.`);
} catch (e) {
  log(`ABORTED: ${e.message.split('\n')[0]}`);
} finally {
  await egdb.close();
}
process.exit(0);
