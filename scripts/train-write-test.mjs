// WRITE TEST on the TEST fabric (parcel_fabric_test): rebase -> post one clean
// version, verifying each step. Hard-gated: refuses if the DB is not *test*, if the
// rebind is not clean, or if the rebase surfaces ANY conflict. Prints the pre-states
// so the operation is reversible before a compress. Does NOT compress.
//
// Run it yourself (writes go through your shell, not the assistant):
//   TRAIN_PORT=11436 TRAIN_PASS=<sde-pw> node scripts/train-write-test.mjs TRACEY.tracey_32922
import { EnterpriseGeodatabase } from '../dist/index.js';

const TARGET = process.argv[2] || 'TRACEY.tracey_32922';
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
setTimeout(() => { log('HARD TIMEOUT 280s'); process.exit(3); }, 280000).unref?.();

const egdb = await EnterpriseGeodatabase.connect({
  driver: 'sqlserver', server: '127.0.0.1', port: Number(process.env.TRAIN_PORT || 11436),
  database: 'parcel_fabric_test', user: 'sde', password: process.env.TRAIN_PASS,
  options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 20000, requestTimeout: 120000 },
});
const q1 = async (sql, p) => (await egdb.query(sql, p))[0];
try {
  const db = (await q1('SELECT DB_NAME() AS db')).db;
  if (!/test/i.test(String(db))) throw new Error(`refusing: DB '${db}' is not a *test* db`);
  const leak = (await q1(`SELECT COUNT(*) AS n FROM sys.sql_modules
    WHERE definition LIKE '%parcel_fabric.sde.%' OR definition LIKE '%parcel_fabric.pa.%'`)).n;
  if (Number(leak) !== 0) throw new Error(`refusing: rebind INCOMPLETE (${leak} live 3-part refs)`);
  log(`connected ${db}; rebind clean`);

  const tables = (await egdb.listTables()).filter((t) => t.isVersioned);
  const parcels = tables.find((t) => /PARCELFABRIC_PARCELS$/i.test(t.name));
  const aTbl = `${parcels.schema}.a${parcels.registrationId}`;

  const [tOwner, tName] = TARGET.split('.');
  const tState0 = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE owner=@p0 AND name=@p1`, [tOwner, tName])).s);
  const defState0 = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  log(`PRE: ${TARGET} state=${tState0}; DEFAULT state=${defState0}`);

  const plan = await egdb.rebaseVersion(TARGET, { dryRun: true });
  const planConf = plan.conflicts.reduce((n, c) => n + c.objectIds.length, 0);
  log(`dry-run: adds=${plan.replayed.reduce((n, r) => n + r.updates, 0)} ` +
      `dels=${plan.replayed.reduce((n, r) => n + r.deletes, 0)} dropped=${plan.droppedRedundant} conflicts=${planConf}`);
  if (planConf > 0) throw new Error(`refusing to write: ${planConf} conflict(s) -- use the rec/post conflict UI`);

  // ---- REBASE (reversible: repoint the version's state_id back to the PRE value) ----
  const rb = await egdb.rebaseVersion(TARGET, { unsafeExperimental: true });
  log(`REBASE: from=${rb.fromState} to=${rb.toState} replayed=${JSON.stringify(rb.replayed)} dropped=${rb.droppedRedundant}`);
  const inVersion = Number((await q1(`SELECT COUNT(*) AS n FROM ${aTbl} WHERE SDE_STATE_ID=@p0`, [rb.toState])).n);
  const defAfterRebase = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  const vlin = Number((await q1(`SELECT lineage_name AS l FROM sde.SDE_states WHERE state_id=@p0`, [rb.toState])).l);
  const recon = Number((await q1(`SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_name=@p0 AND lineage_id=@p1`, [vlin, defState0])).n) > 0;
  log(`  parcels A-rows at newState=${inVersion}; reconciled=${recon}; DEFAULT untouched=${defAfterRebase === defState0}`);
  if (!recon || defAfterRebase !== defState0) throw new Error('post-rebase invariant failed -- aborting before post');

  // ---- POST (no prior reconcile -- proves defect A on the real fabric) ----
  const ps = await egdb.postVersion(TARGET, { trimPost: true });
  const defAfterPost = Number((await q1(`SELECT state_id AS s FROM sde.SDE_versions WHERE name='DEFAULT'`)).s);
  const inDefault = Number((await q1(`SELECT COUNT(*) AS n FROM ${aTbl} WHERE SDE_STATE_ID=@p0`, [defAfterPost])).n);
  log(`POST: changesPosted=${ps.changesPosted} newParentStateId=${ps.newParentStateId}`);
  log(`  DEFAULT advanced=${defAfterPost !== defState0} (${defState0} -> ${defAfterPost}); parcels A-rows at new DEFAULT tip=${inDefault}`);
  log(`RESULT: rebase+post OK on ${TARGET}. PRE states -- version=${tState0}, DEFAULT=${defState0} (for reversal / test-db refresh).`);
} catch (e) {
  log(`ABORTED: ${e.message.split('\n')[0]}`);
} finally {
  await egdb.close();
}
process.exit(0);
