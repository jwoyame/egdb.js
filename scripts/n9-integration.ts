/**
 * N9 run-level exclusion — integration check against the LOCAL DOCKER parcel_fabric
 * clone (real SDE procs, disposable). Verifies the whole mechanism end to end:
 *   A. an editor (EditSession.start → createChildState) BOUNCES while compress
 *      holds the exclusive lock, and succeeds once it's released;
 *   B. compress DEFERS ('editors-active') when an SDE_state_lock is present;
 *   C. compress DEFERS ('lock-contended') when the exclusive lock is held elsewhere;
 *   D. with no editors and no contention, compress RUNS.
 *
 *   npx tsx scripts/n9-integration.ts   (needs parcel_fabric restored + Docker up)
 */
import { EnterpriseGeodatabase } from '../src/enterprise-geodatabase';
import { EditSession } from '../src/edit-session';
import { SqlServerConnection } from '../src/connections/sqlserver';
import { acquireCompressLock, ApplockTimeoutError } from '../src/reconcile';
import type { IDatabaseConnection } from '../src/connections/connection';

const CFG = { driver: 'sqlserver' as const, server: '127.0.0.1', port: 11433, database: 'parcel_fabric', user: 'sa', password: 'YourStrong@Passw0rd', options: { trustServerCertificate: true, requestTimeout: 120000 } };

function dedicatedHolder() {
  return new SqlServerConnection({ ...CFG, options: { ...CFG.options, dedicatedPool: true, pool: { max: 1, min: 1, idleTimeoutMillis: 3_600_000 } } });
}

(async () => {
  const egdb = await EnterpriseGeodatabase.connect(CFG);
  const conn = (egdb as unknown as { connection: IDatabaseConnection }).connection;
  await conn.execute('DELETE FROM sde.SDE_state_locks;'); // clear the backup's stale locks
  let pass = 0, fail = 0;
  const ok = (c: boolean, m: string) => { console.log((c ? '✅' : '❌') + ' ' + m); c ? pass++ : fail++; };

  // A. editor bounces while compress holds the exclusive lock.
  const holdA = dedicatedHolder();
  await holdA.connect(); await holdA.beginTransaction();
  await acquireCompressLock(holdA, 'Exclusive', 5000);
  try {
    const s = await EditSession.start(egdb, 'sde.DEFAULT');
    ok(false, 'A: EditSession.start should have BOUNCED under the compress lock');
    await s.close();
  } catch (e) {
    ok(e instanceof ApplockTimeoutError, `A: editor bounced under compress lock (${(e as Error).name})`);
  }
  await holdA.rollbackTransaction(); await holdA.close();
  const s2 = await EditSession.start(egdb, 'sde.DEFAULT');
  ok(true, 'A: EditSession.start succeeds once the compress lock is released');
  await s2.close();
  await conn.execute('DELETE FROM sde.SDE_state_locks;');

  // B. compress defers on an active edit-session lock.
  const anyState = await conn.query<{ s: number | bigint }>('SELECT TOP 1 state_id AS s FROM sde.SDE_states WHERE state_id <> 0;');
  await conn.execute(`INSERT INTO sde.SDE_state_locks (sde_id, state_id, autolock, lock_type, lock_time) VALUES (999123, ${Number(anyState[0]!.s)}, 'N', 'e', GETDATE());`);
  const rB = await egdb.compress({ acknowledgeExperimentalUnsafe: true });
  ok(rB.deferred === 'editors-active', `B: compress deferred on active lock (deferred=${rB.deferred})`);
  await conn.execute('DELETE FROM sde.SDE_state_locks;');

  // C. compress defers when the exclusive lock is held elsewhere.
  const holdC = dedicatedHolder();
  await holdC.connect(); await holdC.beginTransaction();
  await acquireCompressLock(holdC, 'Exclusive', 5000);
  const rC = await egdb.compress({ acknowledgeExperimentalUnsafe: true });
  ok(rC.deferred === 'lock-contended', `C: compress deferred on held exclusive lock (deferred=${rC.deferred})`);
  await holdC.rollbackTransaction(); await holdC.close();

  // D. compress runs when clear (prune-only default).
  const rD = await egdb.compress({ acknowledgeExperimentalUnsafe: true });
  ok(!rD.deferred, `D: compress ran with no editors/contention (deferred=${rD.deferred}, statesRemoved=${rD.statesRemoved})`);

  await egdb.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
