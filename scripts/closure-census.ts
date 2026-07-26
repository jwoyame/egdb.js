/**
 * Step D closure-divergence census (read-only) against the local Docker clone.
 *
 * For every version, compares its TRUE ancestry (parent_state_id walk — what egdb
 * reads) against its ESRI closure ancestry (SDE_state_lineages rows for the tip's
 * lineage_name with lineage_id <= tip — what _evw / publish-ETL / ArcGIS read):
 *   UNDER = walk ancestors missing from the closure  (backfill — additive, safe)
 *   OVER  = closure ids <= tip that are NOT walk ancestors (needs evidence: some
 *           are query artifacts from tips SHARING a lineage_name, per N7 — those
 *           are NOT deletable without breaking the sharing version).
 * Also answers the N7 gate: do any two version tips share a lineage_name?
 *
 *   npx tsx scripts/closure-census.ts
 */
import { EnterpriseGeodatabase } from '../src/enterprise-geodatabase';

// Defaults target the local Docker clone; override via env for a live read-only run:
//   CENSUS_PORT=11435 CENSUS_USER=sde CENSUS_PASS='...' npx tsx scripts/closure-census.ts
const CFG = { driver: 'sqlserver' as const, server: '127.0.0.1',
  port: Number(process.env.CENSUS_PORT || 11433),
  database: process.env.CENSUS_DB || 'parcel_fabric',
  user: process.env.CENSUS_USER || 'sa',
  password: process.env.CENSUS_PASS || 'YourStrong@Passw0rd',
  options: { trustServerCertificate: true, requestTimeout: 600000 } };

async function main() {
  const egdb = await EnterpriseGeodatabase.connect(CFG);
  const q = <T,>(sql: string) => egdb.query<T>(sql);
  try {
    const total = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM sde.SDE_states`))[0].n;
    const dangling = (await q<{ n: number }>(`SELECT COUNT(*) AS n FROM sde.SDE_states c
      WHERE c.parent_state_id <> 0 AND NOT EXISTS (SELECT 1 FROM sde.SDE_states p WHERE p.state_id=c.parent_state_id)`))[0].n;
    console.log(`states=${total}  dangling_parents=${dangling}`);

    // N7 gate: version tips sharing a lineage_name
    const shared = await q<{ lineage_name: number; tips: number; names: string }>(`
      SELECT s.lineage_name, COUNT(*) AS tips, STRING_AGG(CONCAT(v.owner,'.',v.name), ', ') AS names
      FROM sde.SDE_versions v JOIN sde.SDE_states s ON s.state_id=v.state_id
      GROUP BY s.lineage_name HAVING COUNT(*) > 1`);
    console.log(`\nN7 tips sharing a lineage_name: ${shared.length}`);
    shared.forEach(r => console.log(`  L=${r.lineage_name}: ${r.tips} tips -> ${r.names}`));

    const versions = await q<{ owner: string; name: string; tip: number; L: number }>(`
      SELECT v.owner, v.name, v.state_id AS tip, s.lineage_name AS L
      FROM sde.SDE_versions v JOIN sde.SDE_states s ON s.state_id=v.state_id
      ORDER BY v.owner, v.name`);

    console.log(`\nversion                              tip     walk  closure  UNDER  OVER`);
    for (const v of versions) {
      const r = (await q<{ walk: number; closure: number; under: number; over: number }>(`
        ;WITH anc AS (
          SELECT state_id, parent_state_id FROM sde.SDE_states WHERE state_id=${v.tip}
          UNION ALL SELECT s.state_id, s.parent_state_id FROM sde.SDE_states s
          JOIN anc ON s.state_id=anc.parent_state_id WHERE anc.parent_state_id > 0)
        , walk AS (SELECT state_id AS s FROM anc)
        , clo AS (SELECT lineage_id AS s FROM sde.SDE_state_lineages WHERE lineage_name=${v.L} AND lineage_id <= ${v.tip})
        SELECT (SELECT COUNT(*) FROM walk) AS walk,
               (SELECT COUNT(*) FROM clo) AS closure,
               (SELECT COUNT(*) FROM walk WHERE s NOT IN (SELECT s FROM clo)) AS [under],
               -- state 0 is the universal root: it is a legitimate closure ancestor
               -- but the walk CTE stops at parent_state_id>0, so exclude it from OVER.
               (SELECT COUNT(*) FROM clo WHERE s <> 0 AND s NOT IN (SELECT s FROM walk)) AS [over]
        OPTION (MAXRECURSION 0)`))[0];
      const label = `${v.owner}.${v.name}`.slice(0, 34).padEnd(36);
      console.log(`${label} ${String(v.tip).padStart(6)} ${String(r.walk).padStart(7)} ${String(r.closure).padStart(7)} ${String(r.under).padStart(6)} ${String(r.over).padStart(5)}`);
    }
  } finally { await egdb.close(); }
}
main().catch(e => { console.error('CENSUS FAILED:', e?.message || e); process.exit(1); });
