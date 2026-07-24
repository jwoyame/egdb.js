/**
 * Real-schema compress smoke test against the LOCAL DOCKER parcel_fabric clone
 * (disposable; restore from /backup/parcel_fabric.bak to reset). NOT prod, NOT
 * shared training. Exercises compress against a real, drifted Esri fabric.
 *
 * For every version it captures a visible-data signature (count + order-
 * independent CHECKSUM_AGG over key columns) using egdb's parent_state_id-walk
 * read semantics, runs each compress phase in turn (prune → graduate → collapse),
 * and re-checks the signature after each. Any change = a compress data bug.
 *
 *   npx tsx scripts/compress-local-smoke.ts
 */
import { EnterpriseGeodatabase } from '../src/enterprise-geodatabase';
import { pruneStates, collapseLineages, computeGraduablePrefix, graduateTable } from '../src/reconcile/compress-impl';
import type { IDatabaseConnection } from '../src/connections/connection';
import type { TableInfo } from '../src/types';

const CFG = { driver: 'sqlserver' as const, server: '127.0.0.1', port: 11433, database: 'parcel_fabric', user: 'sa', password: 'YourStrong@Passw0rd', options: { trustServerCertificate: true, requestTimeout: 600000 } };

// Feature classes to fingerprint. Parcels get a rich column hash; lines/points an OID hash.
const SIGS = [
  { reg: 18, tbl: 'PA.PARCELFABRIC_PARCELS', cols: ['OBJECTID', 'Name', 'Type', 'PlanID'] },
  { reg: 17, tbl: 'PA.PARCELFABRIC_LINES', cols: ['OBJECTID'] },
  { reg: 16, tbl: 'PA.PARCELFABRIC_POINTS', cols: ['OBJECTID'] },
];

const ancCte = (tip: number) => `WITH anc AS (
  SELECT state_id, parent_state_id FROM sde.SDE_states WHERE state_id = ${tip}
  UNION ALL
  SELECT s.state_id, s.parent_state_id FROM sde.SDE_states s JOIN anc ON s.state_id = anc.parent_state_id WHERE anc.parent_state_id <> 0)`;

async function versions(conn: IDatabaseConnection) {
  return conn.query<{ name: string; owner: string; state_id: number }>(
    `SELECT name, owner, state_id FROM sde.SDE_versions WHERE state_id IS NOT NULL ORDER BY state_id;`);
}

type Sig = Record<string, { cnt: number; hOid: number; hAll: number }>;

async function signature(conn: IDatabaseConnection, tip: number): Promise<Sig> {
  const out: Sig = {};
  for (const { reg, tbl, cols } of SIGS) {
    const a = `PA.a${reg}`, d = `PA.D${reg}`;
    const colList = cols.join(', ');
    // One self-contained batch: (re)build the indexed ancestor temp table, then
    // the signature SELECT LAST so query() returns its recordset. Materialising
    // #anc (vs re-walking the recursive CTE per subquery over 239k rows) is what
    // makes this finish. #anc is session-scoped; the leading drop-if-exists keeps
    // it fresh whichever pooled session runs the batch.
    const sql = `IF OBJECT_ID('tempdb..#anc') IS NOT NULL DROP TABLE #anc;
      ${ancCte(tip)} SELECT state_id INTO #anc FROM anc OPTION (MAXRECURSION 0);
      CREATE UNIQUE CLUSTERED INDEX ix_anc ON #anc(state_id);
      WITH vis AS (
        SELECT ${cols.map(c => `b.${c}`).join(', ')} FROM ${tbl} b
        WHERE NOT EXISTS (SELECT 1 FROM ${d} dz JOIN #anc an ON an.state_id = dz.DELETED_AT WHERE dz.SDE_DELETES_ROW_ID = b.OBJECTID)
          AND NOT EXISTS (SELECT 1 FROM ${a} az JOIN #anc an ON an.state_id = az.SDE_STATE_ID WHERE az.OBJECTID = b.OBJECTID)
        UNION ALL
        SELECT ${cols.map(c => `x.${c}`).join(', ')} FROM ${a} x
        JOIN #anc anx ON anx.state_id = x.SDE_STATE_ID
        INNER JOIN (SELECT xx.OBJECTID AS moid, MAX(xx.SDE_STATE_ID) ms FROM ${a} xx JOIN #anc anm ON anm.state_id = xx.SDE_STATE_ID GROUP BY xx.OBJECTID) m
          ON m.moid = x.OBJECTID AND m.ms = x.SDE_STATE_ID
        WHERE NOT EXISTS (SELECT 1 FROM ${d} dd JOIN #anc and2 ON and2.state_id = dd.SDE_STATE_ID WHERE dd.SDE_DELETES_ROW_ID = x.OBJECTID AND dd.SDE_STATE_ID > x.SDE_STATE_ID))
      SELECT COUNT_BIG(*) AS cnt, CHECKSUM_AGG(BINARY_CHECKSUM(OBJECTID)) AS hOid, CHECKSUM_AGG(BINARY_CHECKSUM(${colList})) AS hAll FROM vis;`;
    const r = await conn.query<{ cnt: number; hOid: number; hAll: number }>(sql);
    out[tbl] = { cnt: Number(r[0]!.cnt), hOid: Number(r[0]!.hOid ?? 0), hAll: Number(r[0]!.hAll ?? 0) };
  }
  return out;
}

async function allSigs(conn: IDatabaseConnection): Promise<Record<string, Sig>> {
  const out: Record<string, Sig> = {};
  for (const v of await versions(conn)) out[`${v.owner}.${v.name}`] = await signature(conn, Number(v.state_id));
  return out;
}

function diff(before: Record<string, Sig>, after: Record<string, Sig>): string[] {
  const problems: string[] = [];
  for (const ver of Object.keys(before)) {
    for (const tbl of Object.keys(before[ver]!)) {
      const b = before[ver]![tbl]!, a = after[ver]?.[tbl];
      if (!a) { problems.push(`${ver}/${tbl}: version/table vanished`); continue; }
      if (b.cnt !== a.cnt) problems.push(`${ver}/${tbl}: count ${b.cnt} -> ${a.cnt}`);
      if (b.hOid !== a.hOid) problems.push(`${ver}/${tbl}: OID-set hash changed (${b.hOid} -> ${a.hOid})`);
      if (b.hAll !== a.hAll) problems.push(`${ver}/${tbl}: content hash changed (${b.hAll} -> ${a.hAll})`);
    }
  }
  return problems;
}

async function stateCount(conn: IDatabaseConnection): Promise<number> {
  const r = await conn.query<{ c: number }>(`SELECT COUNT(*) AS c FROM sde.SDE_states;`);
  return Number(r[0]!.c);
}
async function danglingCount(conn: IDatabaseConnection): Promise<number> {
  const r = await conn.query<{ c: number }>(`SELECT COUNT(*) AS c FROM sde.SDE_states s WHERE s.parent_state_id <> 0 AND NOT EXISTS (SELECT 1 FROM sde.SDE_states p WHERE p.state_id = s.parent_state_id);`);
  return Number(r[0]!.c);
}

(async () => {
  const egdb = await EnterpriseGeodatabase.connect(CFG);
  const conn = (egdb as unknown as { connection: IDatabaseConnection }).connection;
  const versioned: TableInfo[] = (await egdb.listTables()).filter(t => t.isVersioned && t.registrationId);
  console.log(`versioned tables: ${versioned.length}; states: ${await stateCount(conn)}; dangling(before): ${await danglingCount(conn)}`);
  for (const v of await versions(conn)) console.log(`  version ${v.owner}.${v.name} @ state ${v.state_id}`);

  // Simulate a no-editor nightly window: clear open EditSession locks so collapse
  // is not (correctly) blocked by their ancestor-branch protection. Disposable
  // clone only. A real nightly must actually run when no EditSessions are open.
  if (process.env.CLEAR_LOCKS === '1') {
    await conn.execute(`DELETE FROM sde.SDE_state_locks;`);
    console.log('CLEARED SDE_state_locks (simulating a no-editor nightly window)');
  }
  const T = () => Date.now();
  const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  const check = async (label: string, base: Record<string, Sig>) => {
    const now = await allSigs(conn);
    const problems = diff(base, now);
    const dang = await danglingCount(conn);
    if (problems.length || dang) { console.log(`❌ ${label}: ${problems.length} data diffs, ${dang} dangling parents`); problems.slice(0, 20).forEach(p => console.log('   - ' + p)); }
    else console.log(`✅ ${label}: all versions/tables identical, 0 dangling`);
    return now;
  };

  console.log('\n== baseline signatures ==');
  const baseline = await allSigs(conn);
  for (const ver of Object.keys(baseline)) console.log(`  ${ver}: ` + Object.entries(baseline[ver]!).map(([t, s]) => `${t.split('.').pop()}=${s.cnt}`).join(' '));

  console.log('\n== PHASE 1: prune only ==');
  let t = T();
  const pr = await pruneStates(conn, versioned);
  console.log(`prune: ${pr.statesRemoved} states removed, ${pr.deltaRowsRemoved} delta rows removed; states now ${await stateCount(conn)} [${secs(t)}]`);
  await check('after prune', baseline);

  console.log('\n== PHASE 2: graduate ==');
  t = T();
  const prefix = await computeGraduablePrefix(conn);
  console.log(`graduable prefix size: ${prefix.size}`);
  let gUps = 0, gDel = 0, gA = 0;
  for (const t of versioned) {
    const wasTx = conn.inTransaction();
    if (!wasTx) await conn.beginTransaction({ isolation: 'serializable' });
    try { const r = await graduateTable(conn, t, prefix); if (!wasTx) await conn.commitTransaction(); gUps += r.upserts; gDel += r.deletes; gA += r.aRowsRemoved; }
    catch (e) { if (!wasTx && conn.inTransaction()) await conn.rollbackTransaction(); throw e; }
  }
  console.log(`graduate: ${gUps} base upserts, ${gDel} base deletes, ${gA} a-rows graduated [${secs(t)}]`);
  await check('after graduate', baseline);

  if (process.env.COMPRESS_COLLAPSE === '1') {
    console.log('\n== PHASE 3: collapse ==');
    t = T();
    const cr = await collapseLineages(conn, versioned);
    console.log(`collapse: ${cr.collapses} collapses, ${cr.rowsRewritten} rows rewritten; states now ${await stateCount(conn)} [${secs(t)}]`);
    await check('after collapse', baseline);
  } else {
    console.log('\n== PHASE 3: collapse SKIPPED (set COMPRESS_COLLAPSE=1 to run) ==');
  }

  await egdb.close();
  console.log('\ndone.');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
