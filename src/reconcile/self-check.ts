/**
 * Post-run self-verification for compress (NIGHTLY_COMPRESS_ROADMAP.md Step C).
 *
 * After a compress that is only supposed to reclaim storage, EVERY version must
 * resolve the SAME visible data. This captures a per-version, per-table signature
 * (row count + order-independent CHECKSUM_AGG over the non-geometry columns of the
 * visible rows) BEFORE and AFTER, via egdb's PARENT-WALK read (the authoritative
 * read path egdb serves), and reports any change. A diff is real data corruption —
 * the property/crash tests should have caught it, so an alarm means production hit
 * something the harness didn't. Detection, not prevention (the run already
 * committed) — the backstop, paired with the pre-run precondition gate, that lets
 * an unattended nightly be trusted.
 *
 * KNOWN LIMITATION: the content hash (CHECKSUM_AGG on SQL Server) is 32-bit, so a
 * count-preserving content-only mutation can collide (~2^-32) and slip past. The
 * row-COUNT check is exact and catches any add/remove; only a same-count UPDATE that
 * compress must never make is exposed to collision. That residual is why this is the
 * backstop, not the primary defence — the Step B precondition gate is the prevention.
 *
 * NOTE (Step D): a CLOSURE-aware read (what Esri `_evw` / the nightly publish-ETL
 * serve, via SDE_state_lineages) is deliberately NOT included here. On this fabric
 * the closure diverges from the parent-walk even before compress, and compress's
 * collapse/graduate legitimately rewrite the closure — so a meaningful closure
 * self-check requires the closure-repair semantics defined in Step D. It lands there.
 */
import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';

type Driver = 'sqlserver' | 'postgresql';
function qid(driver: Driver, name: string): string {
  // double the closing delimiter so a catalog name containing ] or " can't break out
  return driver === 'sqlserver' ? `[${name.replace(/]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
}
function sys(driver: Driver, n: 'SDE_states' | 'SDE_versions'): string {
  return driver === 'sqlserver' ? `sde.${n}` : `sde.${n.toLowerCase()}`;
}

export interface TableSig { count: number; hash: string; }
export type CompressSnapshot = Record<string, Record<number, TableSig>>;

export interface SelfCheckResult {
  passed: boolean;   // false iff any version's egdb-visible (parent-walk) data changed
  diffs: string[];   // per-version/table differences
}

/** Non-geometry, non-blob columns of a table (for a content hash). */
async function hashColumns(conn: IDatabaseConnection, driver: Driver, table: TableInfo, cache: Map<string, string[]>): Promise<string[]> {
  const key = `${table.schema}.${table.name}`;
  const hit = cache.get(key); if (hit) return hit;
  const sql = driver === 'sqlserver'
    ? `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=@p0 AND TABLE_NAME=@p1
          AND DATA_TYPE NOT IN ('geometry','geography','image','varbinary','binary','text','ntext') ORDER BY ORDINAL_POSITION`
    : `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2
          AND data_type NOT IN ('bytea','USER-DEFINED') ORDER BY ordinal_position`;
  const rows = await conn.query<{ name: string }>(sql, [table.schema, table.name]);
  const cols = rows.map(r => r.name);
  cache.set(key, cols);
  return cols;
}

async function versionTips(conn: IDatabaseConnection, driver: Driver): Promise<Array<{ key: string; tip: number }>> {
  const v = sys(driver, 'SDE_versions');
  const rows = await conn.query<{ owner: string; name: string; state_id: number | bigint }>(
    `SELECT owner, name, state_id FROM ${v} WHERE state_id IS NOT NULL`);
  return rows.map(r => ({ key: `${r.owner}.${r.name}`, tip: Number(r.state_id) }));
}

// Fixed-name REAL staging table (a #temp does not survive across this pool's
// requests). It is safe only because it is written on ONE connection within a single
// compress run, and compress holds the fabric-wide EXCLUSIVE applock (N9) for its whole
// run — so no second compress/self-check can drop+recreate it concurrently. Do NOT call
// captureVisibleSnapshot outside that exclusion against the same database concurrently.
const MEM = { sqlserver: 'dbo.egdb_selfcheck_mem', postgresql: 'egdb_selfcheck_mem' } as const;

/** Materialise the ancestor state-id set of `tip` (parent_state_id walk) into an
 * indexed staging table ONCE per version, so the per-table signature queries
 * semi-join it instead of re-running an ~n-deep recursive CTE per big-table scan
 * (which times out on a real fabric). Real table (a #temp does not survive across
 * this pool's requests). */
async function materializeMem(conn: IDatabaseConnection, driver: Driver, tip: number): Promise<string> {
  const ref = MEM[driver]; const st = sys(driver, 'SDE_states');
  const rec = driver === 'sqlserver' ? '' : 'RECURSIVE ';
  const maxrec = driver === 'sqlserver' ? ' OPTION (MAXRECURSION 0)' : '';
  const walk = `WITH ${rec}mem AS (
      SELECT state_id AS s, parent_state_id AS p FROM ${st} WHERE state_id = ${tip}
      UNION ALL SELECT c.state_id, c.parent_state_id FROM ${st} c JOIN mem ON c.state_id = mem.p WHERE mem.p <> 0)`;
  if (driver === 'sqlserver') {
    await conn.execute(`IF OBJECT_ID('${ref}') IS NOT NULL DROP TABLE ${ref};`);
    await conn.execute(`${walk} SELECT s INTO ${ref} FROM mem${maxrec}; CREATE UNIQUE CLUSTERED INDEX ix_scmem ON ${ref}(s);`);
  } else {
    await conn.execute(`DROP TABLE IF EXISTS ${ref};`);
    await conn.execute(`CREATE TABLE ${ref} (s BIGINT PRIMARY KEY); ${walk} INSERT INTO ${ref} SELECT s FROM mem;`);
  }
  return ref;
}
async function dropMem(conn: IDatabaseConnection, driver: Driver): Promise<void> {
  const ref = MEM[driver];
  await conn.execute(driver === 'sqlserver' ? `IF OBJECT_ID('${ref}') IS NOT NULL DROP TABLE ${ref};` : `DROP TABLE IF EXISTS ${ref};`);
}

/** count + CHECKSUM_AGG over the rows visible to a version, using the pre-materialised
 * ancestor-state staging table `mem(s)`. */
async function tableSig(conn: IDatabaseConnection, driver: Driver, table: TableInfo, cols: string[], memRef: string): Promise<TableSig> {
  const reg = table.registrationId!;
  const qSchema = qid(driver, table.schema);
  const base = `${qSchema}.${qid(driver, table.name)}`;
  const a = `${qSchema}.${qid(driver, `a${reg}`)}`;
  const dd = `${qSchema}.${qid(driver, `D${reg}`)}`;
  const oid = driver === 'sqlserver' ? 'OBJECTID' : 'objectid';
  const sidc = driver === 'sqlserver' ? 'SDE_STATE_ID' : 'sde_state_id';
  const drow = driver === 'sqlserver' ? 'SDE_DELETES_ROW_ID' : 'sde_deletes_row_id';
  const delAt = driver === 'sqlserver' ? 'DELETED_AT' : 'deleted_at';
  const colList = cols.map(c => qid(driver, c)).join(', ');
  const chk = driver === 'sqlserver'
    ? `CHECKSUM_AGG(BINARY_CHECKSUM(${colList}))`
    : `SUM(('x'||substr(md5(${cols.map(c => `coalesce(${qid(driver, c)}::text,'')`).join("||'|'||")}),1,8))::bit(32)::bigint)`;
  const sql = `WITH mem AS (SELECT s FROM ${memRef})
    , vis AS (
      SELECT ${cols.map(c => `b.${qid(driver, c)}`).join(', ')} FROM ${base} b
      WHERE NOT EXISTS (SELECT 1 FROM ${dd} dz JOIN mem ON mem.s = dz.${delAt} WHERE dz.${drow} = b.${oid})
        AND NOT EXISTS (SELECT 1 FROM ${a} az JOIN mem ON mem.s = az.${sidc} WHERE az.${oid} = b.${oid})
      UNION ALL
      SELECT ${cols.map(c => `x.${qid(driver, c)}`).join(', ')} FROM ${a} x
      JOIN mem mx ON mx.s = x.${sidc}
      INNER JOIN (SELECT xx.${oid} AS moid, MAX(xx.${sidc}) AS ms FROM ${a} xx JOIN mem mm ON mm.s = xx.${sidc} GROUP BY xx.${oid}) m
        ON m.moid = x.${oid} AND m.ms = x.${sidc}
      WHERE NOT EXISTS (SELECT 1 FROM ${dd} d2 JOIN mem md ON md.s = d2.${sidc} WHERE d2.${drow} = x.${oid} AND d2.${sidc} > x.${sidc}))
    SELECT COUNT_BIG(*) AS cnt, ${chk} AS hsh FROM vis`;
  const rows = await conn.query<{ cnt: number | bigint; hsh: number | bigint | null }>(sql);
  // count fits in a JS number (Putnam's largest table is ~2.8M rows). The hash does
  // NOT: the PG path SUMs 32-bit values, and on a multi-million-row table that sum
  // exceeds 2^53 — node-postgres already hands back int8 as an exact string, so keep
  // it a string and never round it through Number(). SQL Server returns a 32-bit int.
  const h = rows[0]?.hsh;
  return { count: Number(rows[0]?.cnt ?? 0), hash: h == null ? '0' : String(h) };
}

/** Capture the per-version visible-data signature via egdb's parent-walk read. */
export async function captureVisibleSnapshot(conn: IDatabaseConnection, versionedTables: TableInfo[]): Promise<CompressSnapshot> {
  const driver = conn.driver;
  const cache = new Map<string, string[]>();
  const tables = versionedTables.filter(t => t.isVersioned && t.registrationId);
  const out: CompressSnapshot = {};
  try {
    for (const v of await versionTips(conn, driver)) {
      const memRef = await materializeMem(conn, driver, v.tip); // ancestor states, once per version
      const perTable: Record<number, TableSig> = {};
      for (const t of tables) {
        const cols = await hashColumns(conn, driver, t, cache);
        perTable[t.registrationId!] = await tableSig(conn, driver, t, cols, memRef);
      }
      out[v.key] = perTable;
    }
  } finally {
    await dropMem(conn, driver).catch(() => { /* best-effort cleanup */ });
  }
  return out;
}

export function compareSnapshots(before: CompressSnapshot, after: CompressSnapshot): SelfCheckResult {
  const diffs: string[] = [];
  for (const ver of Object.keys(before)) {
    const b = before[ver] ?? {}; const a = after[ver];
    if (!a) { diffs.push(`${ver}: version disappeared`); continue; }
    for (const reg of Object.keys(b)) {
      const bs = b[Number(reg)]!; const as = a[Number(reg)];
      if (!as) { diffs.push(`${ver}/reg${reg}: table missing after`); continue; }
      if (bs.count !== as.count) diffs.push(`${ver}/reg${reg}: count ${bs.count} -> ${as.count}`);
      else if (bs.hash !== as.hash) diffs.push(`${ver}/reg${reg}: content hash changed (${bs.hash} -> ${as.hash})`);
    }
  }
  return { passed: diffs.length === 0, diffs };
}
