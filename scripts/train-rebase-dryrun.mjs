// READ-ONLY training validation for rebaseVersion. Runs rebaseVersion({dryRun:true})
// against the REAL broken versions on parcel_fabric_test and prints the plan the
// classifier/closure analysis produces from real geometry + fabric shapes. WRITES
// NOTHING (dry run only). Imports the freshly-built egdb dist so it exercises the
// current source, not openparcels' possibly-stale pnpm-linked copy.
//
// Prereqs: port-forward to the training SQL Server up, and creds in env. Run e.g.:
//   TRAIN_PORT=11436 TRAIN_USER=sde TRAIN_PASS=... node scripts/train-rebase-dryrun.mjs
// (put the password in your shell env / a sourced file, not on the argv.)

import { EnterpriseGeodatabase } from '../dist/index.js';

const cfg = {
  driver: 'sqlserver',
  server: process.env.TRAIN_HOST || '127.0.0.1',
  port: Number(process.env.TRAIN_PORT || 11436),
  database: process.env.TRAIN_DB || 'parcel_fabric_test',
  user: process.env.TRAIN_USER || process.env.U,
  password: process.env.TRAIN_PASS || process.env.P,
};
if (!cfg.user || !cfg.password) {
  console.error('Missing TRAIN_USER/TRAIN_PASS (or U/P) in env. Nothing run.');
  process.exit(2);
}
// Hard safety: this script must NEVER write. Guard against a typo'd flag.
const DRYRUN_ONLY = true;

const egdb = await EnterpriseGeodatabase.connect(cfg);
try {
  const db = (await egdb.query('SELECT DB_NAME() AS db'))[0]?.db;
  console.log(`connected: ${cfg.server}:${cfg.port}/${db} as ${cfg.user}`);
  if (!/test/i.test(String(db))) {
    throw new Error(`refusing: connected DB '${db}' is not a *test* database`);
  }

  // Informational: is the SDE proc rebind complete? 3-part refs to the LIVE db
  // (parcel_fabric.sde./ .pa.) mean a WRITE would leak to PROD. Read-only; a dry
  // run is safe regardless, but this reports the write-gate status for later.
  const leak = (await egdb.query(
    `SELECT COUNT(*) AS n FROM sys.sql_modules
      WHERE definition LIKE '%parcel_fabric.sde.%' OR definition LIKE '%parcel_fabric.pa.%'`,
  ))[0]?.n;
  console.log(`rebind check: ${Number(leak)} proc module(s) still 3-part-ref the LIVE db ` +
    `(${Number(leak) === 0 ? 'clean -> writes would stay in test' : 'INCOMPLETE -> writes would LEAK to PROD; do NOT write'})`);

  const versions = await egdb.listVersions();
  const targets = versions.filter((v) => String(v.name).toUpperCase() !== 'DEFAULT');
  console.log(`\n${versions.length} versions; ${targets.length} non-DEFAULT:\n`);

  for (const v of targets) {
    const full = `${v.owner}.${v.name}`;
    try {
      const plan = await egdb.rebaseVersion(full, { dryRun: DRYRUN_ONLY });
      const upd = plan.replayed.reduce((n, r) => n + r.updates, 0);
      const del = plan.replayed.reduce((n, r) => n + r.deletes, 0);
      const conf = plan.conflicts.reduce((n, c) => n + c.objectIds.length, 0);
      console.log(
        `  ${full.padEnd(28)} from=${plan.fromState} replay(adds=${upd} dels=${del}) ` +
        `dropped=${plan.droppedRedundant} conflicts=${conf}` +
        (conf ? `  [${plan.conflicts.map((c) => `${c.table}:${c.objectIds.slice(0, 8).join(',')}`).join(' ')}]` : ''),
      );
    } catch (e) {
      console.log(`  ${full.padEnd(28)} SKIP: ${e.message.split('\n')[0]}`);
    }
  }
} finally {
  await egdb.close();
}
