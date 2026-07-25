/**
 * Quick real-fabric check of the Step C self-check: run a prune-only compress with
 * verify:true against the local Docker parcel_fabric clone and confirm the
 * self-check reports egdb-visible data unchanged. (Locks cleared to simulate a
 * no-editor window.)  npx tsx scripts/verify-real.ts
 */
import { EnterpriseGeodatabase } from '../src/enterprise-geodatabase';
import type { IDatabaseConnection } from '../src/connections/connection';

const CFG = { driver: 'sqlserver' as const, server: '127.0.0.1', port: 11433, database: 'parcel_fabric', user: 'sa', password: 'YourStrong@Passw0rd', options: { trustServerCertificate: true, requestTimeout: 600000 } };

(async () => {
  const egdb = await EnterpriseGeodatabase.connect(CFG);
  const conn = (egdb as unknown as { connection: IDatabaseConnection }).connection;
  await conn.execute('DELETE FROM sde.SDE_state_locks;');
  const t0 = Date.now();
  const r = await egdb.compress({ acknowledgeExperimentalUnsafe: true, verify: true, phases: { prune: true } });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`prune-only + verify: statesRemoved=${r.statesRemoved}, deferred=${r.deferred}, [${secs}s]`);
  if (r.selfCheck) {
    console.log(`self-check: passed=${r.selfCheck.passed}, diffs=${r.selfCheck.diffs.length}`);
    r.selfCheck.diffs.slice(0, 10).forEach(d => console.log('  - ' + d));
  } else {
    console.log('self-check: NOT PRESENT (deferred or verify off)');
  }
  await egdb.close();
  process.exit(r.selfCheck && !r.selfCheck.passed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
