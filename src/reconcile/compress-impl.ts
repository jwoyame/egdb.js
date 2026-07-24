/**
 * SDE Compress — implementation of the three phases defined in Esri's docs:
 *
 *   Phase 1: prune unreferenced states           → `pruneStates`
 *   Phase 2: collapse candidate lineages         → `collapseLineages`
 *   Phase 3: graduate delta rows to base         → `graduateTable`
 *
 * This module runs them in order 3 → 1 → 2 (graduate-then-prune is
 * monotonic-safe: nothing graduated can be lost to a later prune). Per-
 * table transactions are the documented atomicity unit; partial completion
 * across tables is normal and surfaced in `CompressResult`.
 *
 * See docs/SDE_COMPRESS_SPEC.md for the full specification.
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';
import { buildIntegerList } from '../utils/sql-helpers';

type Driver = 'sqlserver' | 'postgresql';

function qid(driver: Driver, name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * SDE system-table identifier resolver. SQL Server uses PascalCase
 * (`sde.SDE_states`); PostgreSQL lowercases (`sde.sde_states`).
 */
function sysTable(driver: Driver, name: 'SDE_states' | 'SDE_state_lineages' | 'SDE_versions' | 'SDE_state_locks' | 'SDE_mvtables_modified'): string {
  return driver === 'sqlserver' ? `sde.${name}` : `sde.${name.toLowerCase()}`;
}

/**
 * SDE delta-table column resolver. SQL Server uses uppercase OBJECTID /
 * SDE_STATE_ID / SDE_DELETES_ROW_ID / DELETED_AT; PostgreSQL lowercases.
 */
function col(driver: Driver, name: 'OBJECTID' | 'SDE_STATE_ID' | 'SDE_DELETES_ROW_ID' | 'DELETED_AT' | 'state_id' | 'parent_state_id' | 'lineage_id' | 'lineage_name'): string {
  if (driver === 'sqlserver') return name;
  return name.toLowerCase();
}

function paramRef(driver: Driver, index: number): string {
  return driver === 'sqlserver' ? `@p${index}` : `$${index + 1}`;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

export class InconsistentLineageError extends Error {
  constructor(public readonly missingStates: number[]) {
    super(`SDE_state_lineages is missing self-rows for states: ${missingStates.slice(0, 10).join(', ')}${missingStates.length > 10 ? ` (...and ${missingStates.length - 10} more)` : ''}`);
    this.name = 'InconsistentLineageError';
  }
}

/**
 * Diagnostic: count states that are missing a self-row in
 * SDE_state_lineages. ArcGIS-authored states do NOT have self-rows, and
 * neither do egdb.js states now that createChildState uses SDE_state_new_edit
 * (the child shares the parent's lineage_name). The closure-based queries in
 * this module compensate by UNIONing each tip's own state_id into the
 * effective closure, so this is informational, not fatal.
 *
 * The original spec (SDE_COMPRESS_SPEC.md Section 3.1) called the self-row
 * pattern an invariant and recommended aborting compress if any state
 * lacked one. Empirical verification against Putnam parcel_fabric_test
 * (10.5.1, 161/163 states had no self-row) showed that's not how SDE
 * actually behaves. Use this function for telemetry only.
 */
export async function countMissingSelfRows(connection: IDatabaseConnection): Promise<number> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  const sql = `
    SELECT COUNT(*) AS cnt
    FROM ${states} s
    WHERE NOT EXISTS (
      SELECT 1 FROM ${lineages}
      WHERE ${lid} = s.${sid} AND ${lname} = s.${sid}
    )
  `;
  const rows = await connection.query<{ cnt: number | bigint }>(sql);
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * @deprecated The self-row "invariant" is not real for SDE. Kept for
 * backwards compatibility; callers should switch to `countMissingSelfRows`
 * for telemetry. This function is now a no-op.
 */
export async function assertSelfRowInvariant(_connection: IDatabaseConnection): Promise<void> {
  // Intentionally no-op. See countMissingSelfRows() and the comment above.
}

/** Thrown by `assertCompressPreconditions` when the fabric is not safe to compress. */
export class CompressPreconditionError extends Error {
  constructor(public readonly violations: string[]) {
    super(`compress precondition check failed — refusing to run:\n  - ${violations.join('\n  - ')}`);
    this.name = 'CompressPreconditionError';
  }
}

/**
 * Hard-abort structural precondition gate (COMPRESS_HARDENING_PLAN.md §5.3,
 * NIGHTLY_COMPRESS_ROADMAP.md Step B). An UNATTENDED nightly run has no human to
 * read a warning, so if the fabric is already structurally unsound compress must
 * REFUSE (throw) rather than operate on it and risk propagating/worsening the
 * damage — detection-after-commit cannot undo an irreversible base write. Runs
 * before any phase. Checks only unambiguous, corruption-relevant invariants:
 *   - state 0 (base) present + the load-bearing (0,0) closure row;
 *   - no dangling parent_state_id (C6 — a dangling pointer can otherwise fool a
 *     parent-walk gate into passing while the tree is corrupt);
 *   - states_cuk holds (no duplicated (parent_state_id, lineage_name)) — catches
 *     a fabric whose UNIQUE constraint was dropped, which collapse's lineage_name
 *     dance and the whole state tree rely on.
 * (The per-version closure-divergence threshold gate is graduation-specific and
 * only meaningful once closure repair — Step D — defines an acceptable delta; it
 * is intentionally NOT enforced here yet.)
 */
export async function assertCompressPreconditions(connection: IDatabaseConnection): Promise<void> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');
  const violations: string[] = [];

  const s0 = await connection.query(`SELECT 1 FROM ${states} WHERE ${sid} = 0`);
  if (s0.length === 0) violations.push('state 0 (base) is missing');

  const l0 = await connection.query(`SELECT 1 FROM ${lineages} WHERE ${lname} = 0 AND ${lid} = 0`);
  if (l0.length === 0) violations.push('the (0,0) SDE_state_lineages row is missing');

  const dangling = await connection.query<{ c: number | bigint }>(
    `SELECT COUNT(*) AS c FROM ${states} s WHERE s.${pid} <> 0
       AND NOT EXISTS (SELECT 1 FROM ${states} p WHERE p.${sid} = s.${pid})`);
  const nd = Number(dangling[0]?.c ?? 0);
  if (nd > 0) violations.push(`${nd} state(s) have a dangling parent_state_id (parent row does not exist)`);

  const dup = await connection.query<{ c: number | bigint }>(
    `SELECT COUNT(*) AS c FROM (
       SELECT ${pid} AS p, ${lname} AS l FROM ${states} GROUP BY ${pid}, ${lname} HAVING COUNT(*) > 1
     ) d`);
  const ndup = Number(dup[0]?.c ?? 0);
  if (ndup > 0) violations.push(`${ndup} (parent_state_id, lineage_name) pair(s) are duplicated (states_cuk violated)`);

  if (violations.length > 0) throw new CompressPreconditionError(violations);
}

// ---------------------------------------------------------------------------
// Lock and lineage discovery
// ---------------------------------------------------------------------------

/**
 * Detect whether `sde.SDE_mvtables_modified` exists in the database. The
 * table is conventionally present on SDE schemas but not strictly required.
 * We check ONCE at the start of each phase and gate writes on the result,
 * because on PostgreSQL a transaction that hits a missing-table error
 * enters the `25P02 in_failed_sql_transaction` state and every subsequent
 * statement in the same transaction is silently rejected — destroying the
 * rest of the prune/collapse work. The previous try/catch around the
 * mvtables DELETE was incorrect on PG.
 */
export async function hasMvtablesModified(connection: IDatabaseConnection): Promise<boolean> {
  const driver = connection.driver;
  const sql = driver === 'sqlserver'
    ? `SELECT 1 FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = 'sde' AND t.name = 'SDE_mvtables_modified'`
    : `SELECT 1 FROM information_schema.tables WHERE table_schema = 'sde' AND table_name = 'sde_mvtables_modified'`;
  const rows = await connection.query(sql);
  return rows.length > 0;
}

/**
 * Returns the set of state_ids that compress must NOT touch because a live
 * EditSession has them locked. The set is expanded with all ancestors (so
 * the locked state's reads through the lineage are preserved) and all
 * descendants (so unsaved A/D rows under the lock are preserved).
 *
 * See spec Section 16 step 1: "An implementer who reads 'SELECT state_id
 * FROM SDE_state_locks' literally would prune in-flight child states
 * (destroying unsaved A/D rows) or ancestor states (corrupting versioned-
 * view reads through the locked state when DEFAULT has moved)."
 */
export async function readLockedBranches(connection: IDatabaseConnection): Promise<Set<number>> {
  const driver = connection.driver;
  const locks = sysTable(driver, 'SDE_state_locks');
  const states = sysTable(driver, 'SDE_states');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');

  // Root fix (COMPRESS_HARDENING_PLAN.md §5.1, C5): a locked branch's protected
  // set is the locked states plus their ANCESTORS (so reads through the lock
  // resolve) plus their DESCENDANTS (so unsaved edits under the lock survive) —
  // computed by walking parent_state_id, NOT the SDE_state_lineages closure. The
  // old closure query was simultaneously over-broad (whole lineage_name) and
  // incomplete (missed a re-allocated lineage_name). Ancestors need an UPWARD
  // walk and descendants a DOWNWARD walk — two separate recursive CTEs.
  const rec = driver === 'sqlserver' ? '' : 'RECURSIVE ';
  const maxrec = driver === 'sqlserver' ? ' OPTION (MAXRECURSION 0)' : '';
  const sql = `
    WITH ${rec}locked AS (SELECT DISTINCT ${sid} AS s FROM ${locks}),
    anc AS (
      SELECT st.${sid} AS s, st.${pid} AS p FROM ${states} st JOIN locked l ON l.s = st.${sid}
      UNION ALL
      SELECT pp.${sid}, pp.${pid} FROM ${states} pp JOIN anc a ON pp.${sid} = a.p WHERE a.p <> 0
    ),
    dsc AS (
      SELECT s FROM locked
      UNION ALL
      SELECT c.${sid} FROM ${states} c JOIN dsc dd ON c.${pid} = dd.s
    )
    SELECT s AS state_id FROM anc
    UNION
    SELECT s AS state_id FROM dsc${maxrec}
  `;
  const rows = await connection.query<{ state_id: number | bigint }>(sql);
  return new Set(rows.map(r => Number(r.state_id)));
}

/**
 * Compute the graduable prefix: states that appear in EVERY surviving
 * version's lineage closure. Per spec Section 3.3, a delta row is graduable
 * iff its SDE_STATE_ID is in this set.
 *
 * Algorithm: for each tip T, the closure is `SDE_state_lineages WHERE
 * lineage_name = T` (which includes T itself via the self-row invariant).
 * A state S is graduable iff its lineage_id appears for every distinct
 * lineage_name in (SELECT state_id FROM SDE_versions).
 */
export async function computeGraduablePrefix(connection: IDatabaseConnection): Promise<Set<number>> {
  const driver = connection.driver;
  const versions = sysTable(driver, 'SDE_versions');
  const states = sysTable(driver, 'SDE_states');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');

  // Distinct version tips.
  const versionCountRow = await connection.query<{ cnt: number | bigint }>(
    `SELECT COUNT(DISTINCT ${sid}) AS cnt FROM ${versions} WHERE ${sid} IS NOT NULL`
  );
  const versionCount = Number(versionCountRow[0]?.cnt ?? 0);
  if (versionCount === 0) return new Set();

  // Root fix (COMPRESS_HARDENING_PLAN.md §5.1): a delta is graduable iff its
  // state is an ancestor of EVERY version tip — decided by the authoritative
  // parent_state_id walk, NOT the SDE_state_lineages closure (which manufactures
  // spurious ancestors when tips share a lineage_name — the C1 corruption path).
  // Build (tip, ancestor) pairs by walking parent_state_id up from every tip,
  // then keep ancestors common to all tips. The intersection of root-paths is
  // itself a single chain (the LCA's root-path), so downstream tie-breaking
  // reduces to state-id order. Base state 0 is excluded (never graduated).
  const rec = driver === 'sqlserver' ? '' : 'RECURSIVE ';
  const maxrec = driver === 'sqlserver' ? ' OPTION (MAXRECURSION 0)' : '';
  const sql = `
    WITH ${rec}anc AS (
      SELECT v.${sid} AS tip, v.${sid} AS a, s.${pid} AS p
        FROM ${versions} v JOIN ${states} s ON s.${sid} = v.${sid}
        WHERE v.${sid} IS NOT NULL
      UNION ALL
      SELECT r.tip, st.${sid}, st.${pid}
        FROM ${states} st JOIN anc r ON st.${sid} = r.p WHERE r.p <> 0
    )
    SELECT a AS state_id FROM anc
    GROUP BY a
    HAVING COUNT(DISTINCT tip) = ${versionCount}${maxrec}
  `;
  const rows = await connection.query<{ state_id: number | bigint }>(sql);
  return new Set(rows.map(r => Number(r.state_id)));
}

/**
 * Per spec Section 16 step 3: the in-transaction revalidation. The snapshot
 * prefix is still safe iff every state in it is still in the recomputed
 * prefix (snapshot ⊆ recomputed). A post that extends a tip downstream is
 * the common case and produces a SUPERSET, not invalidating. Only a new-
 * version creation can shrink the intersection.
 */
export function isSubsetOf(snapshot: Set<number>, recomputed: Set<number>): boolean {
  for (const s of snapshot) {
    if (!recomputed.has(s)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Graduate delta rows to base
// ---------------------------------------------------------------------------

export interface GraduateTableResult {
  table: string;
  status: 'graduated' | 'skipped-version-set-changed' | 'no-graduable-rows';
  upserts: number;
  deletes: number;
  /** Rows removed from the A-table */
  aRowsRemoved: number;
  /** Rows removed from the D-table */
  dRowsRemoved: number;
  /** Warnings produced (e.g. Pro-authored DELETED_AT outside prefix). */
  warnings: string[];
}

interface DeltaRow {
  state_id: number;
  oid: number;
  isDelete: boolean;
}

/**
 * Graduate one registered table's delta rows into its base table.
 *
 * Must be called inside a transaction at SERIALIZABLE or REPEATABLE READ.
 * The first step is an in-fence subset revalidation of the graduable
 * snapshot; if the version set changed since the snapshot, the table is
 * skipped with `status: 'skipped-version-set-changed'`.
 *
 * Tie-breaking rules for an OID with both A and D rows in the graduable
 * prefix:
 *  - A and D at the same SDE_STATE_ID → UPSERT-A (the pair is an UPDATE)
 *  - D's state is a descendant of A's state → DELETE (D supersedes A)
 *  - A's state is a descendant of or equal to D's state → UPSERT-A
 *  - only A → UPSERT-A; only D → DELETE
 *
 * "Descendant" is resolved via `SDE_state_lineages`, never via numeric
 * state_id comparison: within a `lineage_name` state_id is lineage order,
 * but across different `lineage_name` trees state_ids are allocation
 * order. See docs/SDE_COMPRESS_SPEC.md Section 4.
 */
export async function graduateTable(
  connection: IDatabaseConnection,
  table: TableInfo,
  graduableSnapshot: Set<number>,
  columnCache?: ColumnCache,
): Promise<GraduateTableResult> {
  const cache = columnCache ?? new Map<string, string[]>();
  const result: GraduateTableResult = {
    table: table.name,
    status: 'no-graduable-rows',
    upserts: 0,
    deletes: 0,
    aRowsRemoved: 0,
    dRowsRemoved: 0,
    warnings: [],
  };

  if (!table.isVersioned || !table.registrationId) return result;

  // Graduation needs a transaction: the SDE_versions fence lock (below) only holds
  // inside one, and the graduable-prefix temp table (materializeStateSet) must
  // survive across the follow-up statements on one pooled session. Manage our own
  // when the caller (compress) has not already opened one.
  const ownTx = !connection.inTransaction();
  if (ownTx) await connection.beginTransaction({ isolation: 'serializable' });
  try {
    await graduateTableBody(connection, table, graduableSnapshot, cache, result);
    if (ownTx) await connection.commitTransaction();
  } catch (e) {
    if (ownTx && connection.inTransaction()) await connection.rollbackTransaction();
    throw e;
  }
  return result;
}

async function graduateTableBody(
  connection: IDatabaseConnection,
  table: TableInfo,
  graduableSnapshot: Set<number>,
  cache: ColumnCache,
  result: GraduateTableResult,
): Promise<void> {
  const driver = connection.driver;

  // Take a shared lock on SDE_versions so concurrent createVersion blocks
  // until this txn commits. Without this, a snapshot-isolation read can be
  // racy at commit time (SQL Server surfaces this as a serialization
  // failure, leaving the half-graduated table to be rolled back, instead of
  // the documented 'skipped-version-set-changed' status). With the lock,
  // the in-fence revalidation below is a true critical section relative to
  // version-set changes. See SDE_COMPRESS_SPEC Section 16 step 3.
  // The probe must lock the FULL range, not a single row. `TOP 1 ... WITH
  // (HOLDLOCK, ROWLOCK)` under READ COMMITTED takes a key-range lock for
  // only the one row scanned; a concurrent createVersion inserting outside
  // that range proceeds. TABLOCK + HOLDLOCK takes a table-level shared lock
  // that blocks every INSERT into SDE_versions until commit. The
  // computeGraduablePrefix recompute below is then a true critical section.
  const versionsTbl = sysTable(connection.driver, 'SDE_versions');
  if (connection.driver === 'sqlserver') {
    await connection.query(`SELECT COUNT(*) FROM ${versionsTbl} WITH (HOLDLOCK, TABLOCK)`);
  } else {
    // SHARE mode on the whole table; same intent as SQL Server's TABLOCK+HOLDLOCK.
    await connection.execute(`LOCK TABLE ${versionsTbl} IN SHARE MODE`);
  }

  // In-fence subset revalidation
  const recomputed = await computeGraduablePrefix(connection);
  if (!isSubsetOf(graduableSnapshot, recomputed)) {
    result.status = 'skipped-version-set-changed';
    return;
  }

  if (graduableSnapshot.size === 0) return;

  const regId = table.registrationId!;
  const qSchema = qid(driver, table.schema);
  const aTable = `${qSchema}.${qid(driver, `a${regId}`)}`;
  const dTable = `${qSchema}.${qid(driver, `D${regId}`)}`;
  const baseTable = `${qSchema}.${qid(driver, table.name)}`;
  const oidCol = col(driver, 'OBJECTID');
  const sidCol = col(driver, 'SDE_STATE_ID');
  const drowCol = col(driver, 'SDE_DELETES_ROW_ID');
  const delAtCol = col(driver, 'DELETED_AT');
  // Materialise the graduable prefix into an indexed staging table and reference
  // it as a semi-join. Inlining the ids as a literal IN-list overflows the SQL
  // Server query planner (error 8623) once the prefix is large — a real fabric's
  // shared prefix is ~10k states and winnersSub embeds the list ~9×.
  const gradRef = await materializeStateSet(connection, driver, Array.from(graduableSnapshot));
  const graduableList = `SELECT sid FROM ${gradRef}`;

  // The graduable prefix is a single chain (computeGraduablePrefix intersects
  // the tips' parent_state_id root-paths), so within it states are totally
  // ordered by state_id: the winner per OID is simply the MAX graduable-state
  // A-row not superseded by a graduable delete at a higher state. No cross-
  // lineage ancestry resolution is needed — this replaces the old closure-based
  // winner machinery (which carried the C1 wrong-value bug and a reserved-word
  // SQL bug), and it fixes C0 by keying delete-graduation on DELETED_AT so the
  // Esri base-shadow markers (SDE_STATE_ID = 0) are honoured and cleared.
  const baseCols = (await getTableColumns(connection, driver, table, cache))
    .filter(c => c.toLowerCase() !== sidCol.toLowerCase());
  const qCols = baseCols.map(c => qid(driver, c)).join(', ');
  const srcCols = baseCols.map(c => `a.${qid(driver, c)}`).join(', ');

  // Winner rows (oid, winning state) as a reusable subquery over the intact
  // delta tables (must be read before the cleanup deletes below).
  const winnersSub = `
    SELECT a.${oidCol} AS oid, a.${sidCol} AS st
    FROM ${aTable} a
    INNER JOIN (
      SELECT ${oidCol} AS moid, MAX(${sidCol}) AS ms
      FROM ${aTable} WHERE ${sidCol} IN (${graduableList}) GROUP BY ${oidCol}
    ) m ON m.moid = a.${oidCol} AND m.ms = a.${sidCol}
    WHERE a.${sidCol} IN (${graduableList})
      AND NOT EXISTS (
        SELECT 1 FROM ${dTable} d
        WHERE d.${drowCol} = a.${oidCol} AND d.${sidCol} IN (${graduableList})
          AND d.${sidCol} > a.${sidCol}
      )`;

  // 1. Replace base rows for the winners with the winning A-row's column values
  //    (delete-then-insert handles both existing and new base OIDs). The INSERT
  //    writes an EXPLICIT OBJECTID, so bracket it with SET IDENTITY_INSERT when
  //    the base OBJECTID is an identity column (N11); turn it back OFF even on
  //    error (session-scoped, and only one table may hold it ON at a time).
  await connection.execute(
    `DELETE FROM ${baseTable} WHERE ${oidCol} IN (SELECT oid FROM (${winnersSub}) w)`);
  const insertSql =
    `INSERT INTO ${baseTable} (${qCols})
     SELECT ${srcCols} FROM ${aTable} a
     INNER JOIN (${winnersSub}) w ON w.oid = a.${oidCol} AND w.st = a.${sidCol}`;
  // Esri base OBJECTIDs are commonly IDENTITY columns, and this INSERT supplies
  // OBJECTID explicitly (N11). SET IDENTITY_INSERT is session-scoped and does NOT
  // survive across separate pooled/transaction requests, so it must ride in the
  // SAME batch as the INSERT. It is also NON-transactional: a ROLLBACK does not
  // reset it, and a leaked ON on a pooled connection (shared with the app's own
  // fabric writes) would break every later INSERT into this base table. So the
  // OFF must run even when the INSERT fails — a BEGIN TRY/CATCH guarantees it for
  // both statement- and batch-aborting errors (a connection-fatal error kills the
  // session, taking the flag with it). Safe standalone and inside compress()'s
  // per-table SERIALIZABLE transaction alike.
  const identityOid = await baseObjectIdIsIdentity(connection, driver, table, oidCol);
  const ins = await connection.execute(
    identityOid
      ? `SET IDENTITY_INSERT ${baseTable} ON;
         BEGIN TRY
           ${insertSql};
         END TRY
         BEGIN CATCH
           SET IDENTITY_INSERT ${baseTable} OFF;
           THROW;
         END CATCH;
         SET IDENTITY_INSERT ${baseTable} OFF;`
      : insertSql);
  result.upserts = ins.rowsAffected;

  // 2. Delete base rows whose net result in the prefix is a delete: an OID with
  //    a graduable delete marker (keyed on SDE_STATE_ID OR DELETED_AT so the
  //    state-0 base-shadow markers are honoured — C0) and no surviving winner.
  const delBase = await connection.execute(
    `DELETE FROM ${baseTable}
     WHERE ${oidCol} IN (
       SELECT DISTINCT d.${drowCol} FROM ${dTable} d
       WHERE (d.${sidCol} IN (${graduableList}) OR d.${delAtCol} IN (${graduableList}))
         AND d.${drowCol} NOT IN (SELECT oid FROM (${winnersSub}) w)
     )`);
  result.deletes = delBase.rowsAffected;

  // 3. Remove the graduated deltas. Every graduable A-row is now in base; every
  //    delete marker whose SDE_STATE_ID OR DELETED_AT is graduable is applied —
  //    including the state-0 base-shadow markers. Leaving those behind would
  //    hide the freshly-graduated base row with no A-row to restore it (the
  //    feature would vanish from every version, and publicly — C0).
  const delA = await connection.execute(
    `DELETE FROM ${aTable} WHERE ${sidCol} IN (${graduableList})`);
  result.aRowsRemoved = delA.rowsAffected;
  const delD = await connection.execute(
    `DELETE FROM ${dTable} WHERE ${sidCol} IN (${graduableList}) OR ${delAtCol} IN (${graduableList})`);
  result.dRowsRemoved = delD.rowsAffected;

  await dropStateSet(connection, driver);
  result.status = 'graduated';
}

/**
 * Test/diagnostic hook. Set `compressProgressHook.graduateTable` to a
 * callback that receives progress events from graduateTable.
 */
export const compressProgressHook: {
  graduateTable?: (info: { table: string; total: number; done: number }) => void;
} = {};


/**
 * Per-invocation column-name cache. The base table and the A-table share
 * the same columns (plus SDE_STATE_ID on the A-table). The caller passes a
 * fresh Map for each `compress()` invocation so DDL changes between runs
 * are never served from stale memory, and so connection-pool wrapping
 * cannot stabilize the cache key incorrectly.
 */
export type ColumnCache = Map<string, string[]>;

async function getTableColumns(
  connection: IDatabaseConnection,
  driver: Driver,
  table: TableInfo,
  cache: ColumnCache,
): Promise<string[]> {
  const key = `${table.schema}.${table.name}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const sql = driver === 'sqlserver'
    ? `
      SELECT COLUMN_NAME AS name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1
      ORDER BY ORDINAL_POSITION
    `
    : `
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;
  const rows = await connection.query<{ name: string }>(sql, [table.schema, table.name]);
  const names = rows.map(r => r.name);
  if (names.length === 0) {
    throw new Error(`No columns found for ${table.schema}.${table.name}; cannot graduate.`);
  }
  cache.set(key, names);
  return names;
}

/**
 * Does the base table's OBJECTID column carry an IDENTITY property? Esri base
 * tables commonly do, and graduation INSERTs an EXPLICIT OBJECTID, which SQL
 * Server rejects unless bracketed by SET IDENTITY_INSERT (N11). PostgreSQL
 * accepts explicit values into a serial/DEFAULT-nextval OBJECTID (the Esri-on-PG
 * shape) without a session toggle, so this is a SQL-Server-only concern → false
 * elsewhere. (A base declared GENERATED ALWAYS AS IDENTITY would need OVERRIDING
 * SYSTEM VALUE, but Esri does not create that shape.)
 */
async function baseObjectIdIsIdentity(
  connection: IDatabaseConnection,
  driver: Driver,
  table: TableInfo,
  oidCol: string,
): Promise<boolean> {
  if (driver !== 'sqlserver') return false;
  const rows = await connection.query<{ is_identity: number | boolean }>(
    `SELECT c.is_identity
     FROM sys.columns c
     JOIN sys.objects o ON o.object_id = c.object_id
     JOIN sys.schemas s ON s.schema_id = o.schema_id
     WHERE s.name = @p0 AND o.name = @p1 AND c.name = @p2`,
    [table.schema, table.name, oidCol],
  );
  return rows.length > 0 && (rows[0]!.is_identity === 1 || rows[0]!.is_identity === true);
}

// Staging table lives in the `sde` schema — the schema the compress login
// unambiguously owns (system tables are `sde.*`), avoiding a third-schema CREATE
// permission assumption on `dbo`.
const GRAD_STAGE = { sqlserver: 'sde.egdb_grad_stage', postgresql: 'egdb_grad_stage' } as const;

/**
 * Materialise a (potentially large) state-id set into an indexed staging table
 * and return a SQL reference to it, so callers can write
 * `... IN (SELECT sid FROM <ref>)` instead of inlining thousands of literals.
 * A literal IN-list of a real fabric's graduable prefix (~10k states), embedded
 * ~9× in the winner query, overflows the SQL Server query planner (error 8623).
 *
 * A REAL (catalog) table, not a #temp: with this connection's pooling a session
 * temp table does NOT survive across separate requests (even inside a
 * transaction), whereas a catalog table does. It is created fresh (drop-if-
 * exists), used, then dropped by `dropStateSet`; a crash rolls it back with the
 * enclosing transaction. The compress login therefore needs CREATE TABLE rights
 * in the staging schema (the SDE owner has them).
 */
async function materializeStateSet(connection: IDatabaseConnection, driver: Driver, ids: number[]): Promise<string> {
  const ref = GRAD_STAGE[driver];
  if (driver === 'sqlserver') {
    await connection.execute(`IF OBJECT_ID('${ref}') IS NOT NULL DROP TABLE ${ref}; CREATE TABLE ${ref} (sid BIGINT NOT NULL PRIMARY KEY);`);
  } else {
    await connection.execute(`DROP TABLE IF EXISTS ${ref}; CREATE TABLE ${ref} (sid BIGINT NOT NULL PRIMARY KEY);`);
  }
  const CHUNK = 1000; // SQL Server caps a VALUES row-constructor at 1000 rows.
  for (let i = 0; i < ids.length; i += CHUNK) {
    const values = ids.slice(i, i + CHUNK).map(v => {
      if (!Number.isInteger(v)) throw new Error(`materializeStateSet: non-integer state id ${v}`);
      return `(${v})`;
    }).join(',');
    await connection.execute(`INSERT INTO ${ref} (sid) VALUES ${values}`);
  }
  return ref;
}

async function dropStateSet(connection: IDatabaseConnection, driver: Driver): Promise<void> {
  const ref = GRAD_STAGE[driver];
  await connection.execute(driver === 'sqlserver'
    ? `IF OBJECT_ID('${ref}') IS NOT NULL DROP TABLE ${ref};`
    : `DROP TABLE IF EXISTS ${ref};`);
}

// ---------------------------------------------------------------------------
// Prune states
// ---------------------------------------------------------------------------

export interface PruneResult {
  /** Number of states deleted from SDE_states */
  statesRemoved: number;
  /** Number of A/D rows deleted across all tables for pruned states */
  deltaRowsRemoved: number;
  /** States considered but skipped because re-check failed under locking */
  statesSkipped: number;
  /**
   * Number of delta rows already committed to disk for a state that was
   * subsequently aborted by the metadata-transaction recheck (a new
   * EditSession.start landed a lock after we'd committed the per-table
   * delta-row deletes but before we committed SDE_states). The state itself
   * is preserved (counted in statesSkipped), but its A/D rows for the
   * graduable prefix are gone. Operators should treat a non-zero value here
   * as a signal to investigate concurrent EditSession activity during
   * compress windows. See SDE_COMPRESS_SPEC Section 16 step 4(b).
   */
  deltaRowsLostToLateLocks: number;
}

/**
 * All non-zero states NOT reachable as an ancestor of any version tip, decided by
 * the AUTHORITATIVE parent_state_id walk (never the SDE_state_lineages closure —
 * COMPRESS_HARDENING_PLAN.md §5.1). The unreachable set is downward-closed (every
 * descendant of an unreachable state is itself unreachable, since a reachable
 * descendant would make its ancestor reachable), so it can be removed WHOLESALE
 * without ever orphaning a survivor: any state that stays is reachable, and
 * reachability is ancestor-closed, so its entire parent chain stays too.
 */
async function findUnreachableStates(connection: IDatabaseConnection): Promise<number[]> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const versions = sysTable(driver, 'SDE_versions');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');
  const rec = driver === 'sqlserver' ? '' : 'RECURSIVE ';
  const maxrec = driver === 'sqlserver' ? ' OPTION (MAXRECURSION 0)' : '';
  const sql = `
    WITH ${rec}reachable AS (
      SELECT ${sid} AS rs, ${pid} AS rp FROM ${states}
        WHERE ${sid} IN (SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL)
      UNION ALL
      SELECT st.${sid}, st.${pid} FROM ${states} st
        JOIN reachable r ON st.${sid} = r.rp WHERE r.rp <> 0
    )
    SELECT s.${sid} AS state_id
    FROM ${states} s
    WHERE s.${sid} <> 0 AND s.${sid} NOT IN (SELECT rs FROM reachable)${maxrec}
  `;
  const rows = await connection.query<{ state_id: number | bigint }>(sql);
  return rows.map(r => Number(r.state_id));
}

/**
 * Prune every unreachable, unlocked state in ONE atomic pass.
 *
 * The prunable set = {unreachable from any tip} − {locked branches}. Because the
 * unreachable set is downward-closed and readLockedBranches returns each lock's
 * ancestors AND descendants, deleting the whole set at once leaves NO dangling
 * parent_state_id: every surviving state is reachable or locked, and both of those
 * sets are parent-closed, so no survivor points at a deleted state. Directly-locked
 * states are inside lockedExpanded, so none of them is deleted — the SDE_state_locks
 * → SDE_states FK is never violated.
 *
 * This replaces the previous leaves-only-and-iterate loop, which re-ran
 * readLockedBranches + candidate discovery (two recursive CTEs over ALL states)
 * once PER TABLE PER STATE — O(dead-depth × fabric-scan), measured at ~2h and
 * still unfinished on a real 11.5k-state fabric. The set-based delete finishes in
 * seconds.
 *
 * Runs in a single SERIALIZABLE transaction (unless the caller already owns one):
 * readLockedBranches inside the fence serialises against a concurrent
 * EditSession.start that would otherwise lock a state mid-prune, and the delta +
 * metadata deletes commit atomically. With no partial-commit window there is no
 * late-lock race, so statesSkipped / deltaRowsLostToLateLocks stay 0.
 */
export async function pruneStates(
  connection: IDatabaseConnection,
  tables: TableInfo[],
): Promise<PruneResult> {
  const result: PruneResult = {
    statesRemoved: 0,
    deltaRowsRemoved: 0,
    statesSkipped: 0,
    deltaRowsLostToLateLocks: 0,
  };
  const driver = connection.driver;
  // Pre-check ONCE (a missing table mid-transaction poisons a PG transaction).
  const mvExists = await hasMvtablesModified(connection);
  const versionedTables = tables.filter(t => t.isVersioned && t.registrationId);

  const wasTx = connection.inTransaction();
  if (!wasTx) await connection.beginTransaction({ isolation: 'serializable' });
  try {
    const lockedExpanded = await readLockedBranches(connection);
    const unreachable = await findUnreachableStates(connection);
    const toPrune = unreachable.filter(s => !lockedExpanded.has(s));
    if (toPrune.length === 0) {
      if (!wasTx) await connection.commitTransaction();
      return result;
    }

    const lineages = sysTable(driver, 'SDE_state_lineages');
    const states = sysTable(driver, 'SDE_states');
    const mv = sysTable(driver, 'SDE_mvtables_modified');
    const sidM = col(driver, 'state_id');
    const lid = col(driver, 'lineage_id');
    const sidCol = col(driver, 'SDE_STATE_ID');
    const delAtCol = col(driver, 'DELETED_AT');

    // Chunk the id list to stay within SQL Server's IN-expression limits.
    const CHUNK = 1000;
    for (let i = 0; i < toPrune.length; i += CHUNK) {
      const list = buildIntegerList(toPrune.slice(i, i + CHUNK), 'pruneStates');
      for (const table of versionedTables) {
        const regId = table.registrationId!;
        const qSchema = qid(driver, table.schema);
        const aTable = `${qSchema}.${qid(driver, `a${regId}`)}`;
        const dTable = `${qSchema}.${qid(driver, `D${regId}`)}`;
        const delA = await connection.execute(`DELETE FROM ${aTable} WHERE ${sidCol} IN (${list})`);
        result.deltaRowsRemoved += delA.rowsAffected;
        const delD = await connection.execute(`DELETE FROM ${dTable} WHERE ${sidCol} IN (${list}) OR ${delAtCol} IN (${list})`);
        result.deltaRowsRemoved += delD.rowsAffected;
      }
      // Metadata: lineages → mvtables_modified → states (spec Section 16 order).
      // Delete closure rows by lineage_id ONLY, never by lineage_name (N6). A
      // lineage_name is allocated from the same id-space as state_id, so a pruned
      // state's id can collide with a lineage_name still in use by a LIVE branch;
      // deleting by lineage_name would wipe that live branch's whole closure (the
      // publish-ETL / _evw invisibility failure). A pruned state's own now-orphaned
      // lineage_name rows are harmless (nothing reads a dead lineage) and are left
      // for the separate closure-repair pass. Mirrors compressRef's prune exactly.
      await connection.execute(`DELETE FROM ${lineages} WHERE ${lid} IN (${list})`);
      if (mvExists) await connection.execute(`DELETE FROM ${mv} WHERE ${sidM} IN (${list})`);
      const delS = await connection.execute(`DELETE FROM ${states} WHERE ${sidM} IN (${list})`);
      result.statesRemoved += delS.rowsAffected;
    }
    if (!wasTx) await connection.commitTransaction();
  } catch (e) {
    if (!wasTx && connection.inTransaction()) await connection.rollbackTransaction();
    throw e;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Collapse candidate lineages
// ---------------------------------------------------------------------------

export interface CollapseResult {
  /** Number of (parent, child) merges performed */
  collapses: number;
  /** Number of delta rows rewritten (SDE_STATE_ID or DELETED_AT updates) */
  rowsRewritten: number;
}

/**
 * Find collapse candidates: (parent P, child C) where C is not a version tip,
 * P has exactly one child (= C), and C has at most one child of its own.
 *
 * Note: branch points must survive. A state with ≥ 2 children cannot collapse
 * its children up because doing so would merge sibling branches.
 */
async function findCollapsePairs(
  connection: IDatabaseConnection,
  lockedExpanded: Set<number>,
): Promise<Array<{ parent: number; child: number }>> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const versions = sysTable(driver, 'SDE_versions');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');

  // The parent P survives and inherits the child's edits, so P must NOT be a
  // version tip (a version at P would silently gain C's edits — C2) and must NOT
  // be the base state 0 (collapsing into base makes C's edits unconditionally
  // visible to every version — N5). The child must be a non-tip leaf-ish node.
  const sql = `
    SELECT c.${sid} AS child, p.${sid} AS parent
    FROM ${states} c
    INNER JOIN ${states} p ON p.${sid} = c.${pid}
    WHERE c.${sid} NOT IN (SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL)
      AND p.${sid} NOT IN (SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL)
      AND p.${sid} <> 0
      AND (SELECT COUNT(*) FROM ${states} p2 WHERE p2.${pid} = p.${sid}) = 1
      AND (SELECT COUNT(*) FROM ${states} cc WHERE cc.${pid} = c.${sid}) <= 1
  `;
  const rows = await connection.query<{ parent: number | bigint; child: number | bigint }>(sql);
  return rows
    .map(r => ({ parent: Number(r.parent), child: Number(r.child) }))
    .filter(p => !lockedExpanded.has(p.parent) && !lockedExpanded.has(p.child));
}

/**
 * Compute the full collapse plan from the STATIC post-prune tree in ONE query:
 * the ordered list of (anchor, deleted-state) pairs the iterative collapse would
 * produce. This is derivable without iterating because collapse never changes a
 * surviving state's child count (a branch point keeps its children; a linear
 * anchor keeps exactly one). A state is COLLAPSED AWAY iff it is not a version
 * tip, not locked, not state 0, has ≤1 child, AND its parent is a "valid absorbing
 * target" (non-tip, non-locked, non-zero, exactly one child). Its ANCHOR is the
 * nearest surviving ancestor (walk up parent_state_id). Emitting (anchor, child)
 * for every deleted state in ASCENDING state_id order and feeding it to the SAME
 * per-pair logic reproduces the one-at-a-time result exactly (a child's state_id
 * always exceeds its parent's, so ascending order = the tip-most edit wins the
 * per-pair dedupe), without re-running readLockedBranches + findCollapsePairs
 * after every pair (two recursive CTEs per round → O(states) rounds, ~hours on a
 * real fabric).
 */
async function computeCollapsePlan(
  connection: IDatabaseConnection,
  lockedExpanded: Set<number>,
): Promise<Array<{ parent: number; child: number }>> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const versions = sysTable(driver, 'SDE_versions');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');
  const rec = driver === 'sqlserver' ? '' : 'RECURSIVE ';
  const maxrec = driver === 'sqlserver' ? ' OPTION (MAXRECURSION 0)' : '';
  // -1 sentinel (no state has id -1) so an empty lock set works in BOTH `IN` and
  // `NOT IN` — `NOT IN (NULL)` would be UNKNOWN and wrongly exclude every row.
  const lockList = lockedExpanded.size ? buildIntegerList([...lockedExpanded], 'computeCollapsePlan') : '-1';
  const sql = `
    WITH ${rec}cc AS (
      SELECT ${pid} AS p, COUNT(*) AS c FROM ${states} WHERE ${sid} <> 0 GROUP BY ${pid}
    ),
    tips AS (SELECT DISTINCT ${sid} AS s FROM ${versions} WHERE ${sid} IS NOT NULL),
    surv AS (
      -- A state survives iff it is state 0, a tip, locked, a branch point (≥2
      -- children), OR its parent is NOT a valid absorbing target — i.e. the
      -- parent is 0, a tip, locked, or itself a branch point. That last clause is
      -- essential: the single child of a branch point cannot be collapsed (its
      -- parent has 2+ children), so it survives and anchors its own run.
      SELECT s.${sid} AS s FROM ${states} s
      WHERE s.${sid} = 0
        OR s.${sid} IN (SELECT s FROM tips)
        OR s.${sid} IN (${lockList})
        OR COALESCE((SELECT c FROM cc WHERE cc.p = s.${sid}), 0) >= 2
        OR s.${pid} = 0
        OR s.${pid} IN (SELECT s FROM tips)
        OR s.${pid} IN (${lockList})
        OR COALESCE((SELECT c FROM cc WHERE cc.p = s.${pid}), 0) >= 2
    ),
    prop AS (
      -- Anchor via DOWNWARD propagation: each survivor anchors itself; a deleted
      -- child inherits its parent's anchor. A deleted state has ≤1 child, so each
      -- state is visited exactly once — O(states). (The obvious per-deleted-state
      -- UPWARD walk is O(states²) on a near-linear ~10k-state history and times
      -- out.) Non-survivors are exactly the collapsed-away states.
      SELECT s AS st, s AS anchor FROM surv
      UNION ALL
      SELECT c.${sid}, p.anchor
      FROM prop p JOIN ${states} c ON c.${pid} = p.st
      WHERE c.${sid} NOT IN (SELECT s FROM surv)
    )
    SELECT st AS child, anchor FROM prop WHERE st NOT IN (SELECT s FROM surv) ORDER BY st ASC${maxrec}
  `;
  const rows = await connection.query<{ child: number | bigint; anchor: number | bigint }>(sql);
  return rows.map(r => ({ parent: Number(r.anchor), child: Number(r.child) }));
}

/**
 * Collapse linear runs of states.
 *
 * Note on collapse direction: per spec Section 3.2, child C collapses into
 * parent P (P survives). Delta rows at C are rebased to P; SDE_versions
 * entries pointing at C are rewritten to P in the same transaction.
 *
 * DELETED_AT independent rewrite (spec Section 3.2 step 4, fix H5): D-row
 * SDE_STATE_ID and DELETED_AT can each independently equal C; both must be
 * rewritten in their own UPDATEs.
 */
export async function collapseLineages(
  connection: IDatabaseConnection,
  tables: TableInfo[],
): Promise<CollapseResult> {
  const result: CollapseResult = { collapses: 0, rowsRewritten: 0 };
  const driver = connection.driver;
  const versionedTables = tables.filter(t => t.isVersioned && t.registrationId);
  const mvExists = await hasMvtablesModified(connection);

  // Compute locks + the full ordered collapse plan ONCE, then execute the SAME
  // per-pair logic below for each planned (anchor, child) pair. The plan already
  // reflects the whole cascade (children ordered by ascending state_id so the
  // tip-most edit wins the per-pair dedupe), so no per-round recomputation is
  // needed — the old for(;;) re-ran two recursive CTEs per pair (O(states) rounds,
  // ~hours on a real fabric). Each pair is still its own atomic transaction.
  const lockedExpanded = await readLockedBranches(connection);
  const plan = await computeCollapsePlan(connection, lockedExpanded);
  {
    for (const { parent, child } of plan) {
      // ONE transaction for the whole pair — delta rewrites AND metadata — so a
      // failure (e.g. the states_cuk dance below) rolls back atomically instead
      // of leaving the child's edits committed at the parent with the state tree
      // unchanged (N3). A collapse touches few rows, so a single tx is cheap.
      try {
        await connection.beginTransaction();

        // Per-table delta-row rewrites.
        for (const table of versionedTables) {
          const regId = table.registrationId!;
          const qSchema = qid(driver, table.schema);
          const aTable = `${qSchema}.${qid(driver, `a${regId}`)}`;
          const dTable = `${qSchema}.${qid(driver, `D${regId}`)}`;
          const oidCol = col(driver, 'OBJECTID');
          const sidCol = col(driver, 'SDE_STATE_ID');
          const drowCol = col(driver, 'SDE_DELETES_ROW_ID');
          const delAtCol = col(driver, 'DELETED_AT');

          // Dedupe BEFORE rewrite (spec Section 3.2 step 3). Within a P→C
          // chain, C is closer to the tip, so C wins; delete the loser
          // A-row at P for any OID that also has an A-row at C.
          await connection.execute(
            `DELETE FROM ${aTable}
             WHERE ${sidCol} = ${paramRef(driver, 0)}
               AND ${oidCol} IN (
                 SELECT ${oidCol} FROM ${aTable} WHERE ${sidCol} = ${paramRef(driver, 1)}
               )`,
            [parent, child],
          );
          await connection.execute(
            `DELETE FROM ${dTable}
             WHERE ${sidCol} = ${paramRef(driver, 0)}
               AND ${drowCol} IN (
                 SELECT ${drowCol} FROM ${dTable} WHERE ${sidCol} = ${paramRef(driver, 1)}
               )`,
            [parent, child],
          );

          // Cross A/D dedupe — the tip-ward child's operation is the NET result.
          // A state must never hold both an A-row and a D-row for one OID (the
          // versioned read only lets a delete suppress an add at a STRICTLY
          // greater state, so an add and delete landing on the SAME collapsed
          // state would resurrect a deleted feature — the add would win). So:
          //   • C deletes what P added  → net delete: drop P's A-row.
          //   • C (re)adds what P deleted → net add:  drop P's D-row.
          await connection.execute(
            `DELETE FROM ${aTable}
             WHERE ${sidCol} = ${paramRef(driver, 0)}
               AND ${oidCol} IN (
                 SELECT ${drowCol} FROM ${dTable} WHERE ${sidCol} = ${paramRef(driver, 1)}
               )`,
            [parent, child],
          );
          await connection.execute(
            `DELETE FROM ${dTable}
             WHERE ${sidCol} = ${paramRef(driver, 0)}
               AND ${drowCol} IN (
                 SELECT ${oidCol} FROM ${aTable} WHERE ${sidCol} = ${paramRef(driver, 1)}
               )`,
            [parent, child],
          );

          // Rewrite SDE_STATE_ID (C → P).
          const aUpd = await connection.execute(
            `UPDATE ${aTable} SET ${sidCol} = ${paramRef(driver, 0)} WHERE ${sidCol} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
          result.rowsRewritten += aUpd.rowsAffected;
          const dUpd1 = await connection.execute(
            `UPDATE ${dTable} SET ${sidCol} = ${paramRef(driver, 0)} WHERE ${sidCol} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
          result.rowsRewritten += dUpd1.rowsAffected;
          // Independent DELETED_AT rewrite (fix H5).
          const dUpd2 = await connection.execute(
            `UPDATE ${dTable} SET ${delAtCol} = ${paramRef(driver, 0)} WHERE ${delAtCol} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
          result.rowsRewritten += dUpd2.rowsAffected;
        }

        // Metadata (same transaction).
        const states = sysTable(driver, 'SDE_states');
        const lineages = sysTable(driver, 'SDE_state_lineages');
        const versions = sysTable(driver, 'SDE_versions');
        const mv = sysTable(driver, 'SDE_mvtables_modified');
        const sid = col(driver, 'state_id');
        const lid = col(driver, 'lineage_id');
        const lname = col(driver, 'lineage_name');

        // Rewrite lineage rows: any lineage_id = child → parent.
        // First, DELETE any rows whose update would PK-conflict — a
        // (lineage_name, lineage_id=parent) row already exists, so we'd
        // duplicate. Then the bulk UPDATE is safe.
        // (lineage_name = child is removed: child's own closure rows go away.)
        const dedupLineages = driver === 'sqlserver'
          ? `DELETE sl1 FROM ${lineages} sl1
             WHERE sl1.${lid} = @p0
               AND EXISTS (
                 SELECT 1 FROM ${lineages} sl2
                 WHERE sl2.${lid} = @p1 AND sl2.${lname} = sl1.${lname}
               )`
          : `DELETE FROM ${lineages} sl1
             WHERE sl1.${lid} = $1
               AND EXISTS (
                 SELECT 1 FROM ${lineages} sl2
                 WHERE sl2.${lid} = $2 AND sl2.${lname} = sl1.${lname}
               )`;
        await connection.execute(dedupLineages, [child, parent]);
        await connection.execute(
          `UPDATE ${lineages} SET ${lid} = ${paramRef(driver, 0)} WHERE ${lid} = ${paramRef(driver, 1)}`,
          [parent, child],
        );
        // N6: do NOT delete closure rows by lineage_name = child. lineage_name
        // shares the state_id id-space, so on a DIVERGENT fabric the collapsed
        // child's id can equal a lineage_name still used by a LIVE branch, and
        // deleting by it would wipe that branch's closure (publish-ETL
        // invisibility). A collapsed state is never a branch root (branch roots
        // have ≥2 children → they survive), so on a well-formed fabric there are
        // no lineage_name = child rows and this delete only ever no-ops; any that
        // exist on a divergent fabric are left for the closure-repair pass.
        // Mirrors the prune N6 fix.
        if (mvExists) {
          // SDE_mvtables_modified PK is typically (state_id, registration_id).
          // Same dedupe pattern as SDE_state_lineages above.
          const dedupMv = driver === 'sqlserver'
            ? `DELETE mv1 FROM ${mv} mv1
               WHERE mv1.${sid} = @p0
                 AND EXISTS (
                   SELECT 1 FROM ${mv} mv2
                   WHERE mv2.${sid} = @p1
                     AND mv2.registration_id = mv1.registration_id
                 )`
            : `DELETE FROM ${mv} mv1
               WHERE mv1.${sid} = $1
                 AND EXISTS (
                   SELECT 1 FROM ${mv} mv2
                   WHERE mv2.${sid} = $2
                     AND mv2.registration_id = mv1.registration_id
                 )`;
          await connection.execute(dedupMv, [child, parent]);
          await connection.execute(
            `UPDATE ${mv} SET ${sid} = ${paramRef(driver, 0)} WHERE ${sid} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
        }
        // No-op in steady state per spec; covers race where a version was
        // created concurrently and now points at C.
        await connection.execute(
          `UPDATE ${versions} SET ${sid} = ${paramRef(driver, 0)} WHERE ${sid} = ${paramRef(driver, 1)}`,
          [parent, child],
        );
        // C3 / states_cuk dance: the child C and its own child G may share a
        // lineage_name (a linear run from SDE_state_new_edit). Re-pointing G's
        // parent to P would momentarily give G and the still-present C the same
        // (parent_state_id, lineage_name) → states_cuk violation. Negate C's
        // lineage_name first (C is about to be deleted, so the negative value is
        // transient and unique) to keep the pair distinct during the re-point.
        // Mirrors Esri's SDE_state_def_trim_states.
        await connection.execute(
          `UPDATE ${states} SET ${lname} = -${lname} WHERE ${sid} = ${paramRef(driver, 0)}`,
          [child],
        );
        // Re-point any other state's parent_state_id from child to parent
        // (i.e. the child's child becomes a direct child of the parent).
        const pid = col(driver, 'parent_state_id');
        await connection.execute(
          `UPDATE ${states} SET ${pid} = ${paramRef(driver, 0)} WHERE ${pid} = ${paramRef(driver, 1)}`,
          [parent, child],
        );
        await connection.execute(
          `DELETE FROM ${states} WHERE ${sid} = ${paramRef(driver, 0)}`,
          [child],
        );
        await connection.commitTransaction();
        result.collapses += 1;
      } catch (e) {
        if (connection.inTransaction()) await connection.rollbackTransaction();
        throw e;
      }
    }
  }

  return result;
}
