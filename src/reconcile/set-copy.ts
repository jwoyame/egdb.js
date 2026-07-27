/**
 * Set-based delta copying.
 *
 * The original reconcile/apply path copied delta rows ONE AT A TIME, and each
 * copy re-queried INFORMATION_SCHEMA for the table's column list. On a real
 * fabric that is fatal: catching a version up to DEFAULT can mean tens of
 * thousands of features, i.e. ~3-4 sequential round-trips each, which blows past
 * any request timeout. ArcSDE does this work set-based; so do we now.
 *
 * Two primitives live here:
 *   - `selectChangedObjectIds` - which of a child version's rows actually DIFFER
 *     from the parent's, using a single `EXCEPT`. Rows that are byte-identical to
 *     the parent's are redundant by definition (a previous reconcile copied them
 *     in), so replaying them is a no-op and they can be dropped safely.
 *   - `copyTipRows` / `insertDeleteMarkers` - move the surviving rows into a
 *     target state with one statement per table.
 *
 * Both are used by `rebaseVersion` and by the reconcile apply path.
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';
import { buildIntegerList } from '../utils/sql-helpers';

export interface ColumnMeta {
  name: string;
  dataType: string;
}

/**
 * Quote an identifier. PostgreSQL folds unquoted identifiers to lower case and
 * the SDE tables are created that way, so a quoted "OBJECTID" would not resolve
 * there -- every other pg path in this codebase uses lower case, and so must we.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name.toLowerCase()}"`;
}

// Column metadata is invariant for a given connection, but the old code re-read
// it per copied row. Cache it -- this alone removes O(rows) metadata queries from
// reconcile.
//
// Keyed by the CONNECTION object, not by schema+table: one process can hold
// connections to several databases that share a schema name and registration ids
// (openparcels runs live `parcel_fabric` and training `parcel_fabric_test` side by
// side). A global schema:table key would let whichever database populated the
// cache first dictate the column list for the other, producing a wrong-column
// INSERT on a live reconcile.
const columnCache = new WeakMap<IDatabaseConnection, Map<string, ColumnMeta[]>>();

/** Clear the column-metadata cache (tests, or after a schema change). */
export function clearColumnCache(connection?: IDatabaseConnection): void {
  if (connection) columnCache.delete(connection);
  // Without a connection there is nothing global to clear: entries are
  // per-connection and die with the connection.
}

export async function getTableColumnsCached(
  connection: IDatabaseConnection,
  schema: string,
  tableName: string,
): Promise<ColumnMeta[]> {
  let perConn = columnCache.get(connection);
  if (!perConn) { perConn = new Map(); columnCache.set(connection, perConn); }
  const key = `${schema}:${tableName}`.toLowerCase();
  const hit = perConn.get(key);
  if (hit) return hit;

  const sql = connection.driver === 'sqlserver'
    ? `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1 ORDER BY ORDINAL_POSITION`
    : `SELECT column_name AS "COLUMN_NAME", data_type AS "DATA_TYPE" FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`;

  const rows = await connection.query<{ COLUMN_NAME: string; DATA_TYPE: string }>(sql, [schema, tableName]);
  const cols = rows.map((r) => ({ name: r.COLUMN_NAME, dataType: (r.DATA_TYPE || '').toLowerCase() }));
  perConn.set(key, cols);
  return cols;
}

/**
 * Expression to use when COMPARING a column. SQL Server's `geometry`/`geography`
 * CLR types are not comparable, so `EXCEPT` over a table containing a Shape
 * column fails outright; cast them to varbinary so the row comparison works.
 */
const TEXT_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar']);

function comparableExpr(driver: 'sqlserver' | 'postgresql', col: ColumnMeta): string {
  const q = quoteId(driver, col.name);
  if (driver === 'sqlserver') {
    if (col.dataType === 'geometry' || col.dataType === 'geography') {
      return `CAST(${q} AS varbinary(max)) AS ${q}`;
    }
    // Compare text BINARY, not under the column's collation. A fabric's default
    // collation is typically case- and trailing-space-insensitive, so 'McClury'
    // would equal 'MCCLURY' and 'MAIN ST ' would equal 'MAIN ST' -- meaning an
    // editor's capitalisation or whitespace correction compares EQUAL to the
    // parent's row and gets discarded as redundant. Silent data loss; force a
    // binary collation so any real difference is seen.
    if (TEXT_TYPES.has(col.dataType)) {
      return `${q} COLLATE Latin1_General_BIN2 AS ${q}`;
    }
  }
  return q;
}

/** Columns that participate in a row copy / comparison (never the state column). */
function payloadColumns(cols: ColumnMeta[]): ColumnMeta[] {
  return cols.filter((c) => c.name.toUpperCase() !== 'SDE_STATE_ID');
}

function requireRegistrationId(tableInfo: TableInfo): number {
  if (!tableInfo.registrationId) {
    throw new Error(`Table ${tableInfo.name} is not registered (no registrationId)`);
  }
  return tableInfo.registrationId;
}

/**
 * OBJECTIDs whose rows in `childStates` are NOT byte-identical to any row in
 * `parentStates`. An identical row means a previous reconcile copied the parent's
 * row into the child, so it carries no information and must not be replayed.
 *
 * Returns [] when either state set is empty (nothing to compare / nothing to keep).
 */
export async function selectChangedObjectIds(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  childStates: number[],
  parentStates: number[],
): Promise<number[]> {
  if (childStates.length === 0) return [];
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const oidCol = quoteId(driver, 'OBJECTID');
  const stateCol = quoteId(driver, 'SDE_STATE_ID');

  const cols = payloadColumns(await getTableColumnsCached(connection, tableInfo.schema, `a${regId}`));
  const cmp = cols.map((c) => comparableExpr(driver, c)).join(', ');
  const childList = buildIntegerList(childStates, 'selectChangedObjectIds.child');

  // No parent rows to compare against => every child row is a change.
  if (parentStates.length === 0) {
    const rows = await connection.query<{ OBJECTID: number | string }>(
      `SELECT DISTINCT ${oidCol} AS OBJECTID FROM ${aTable} WHERE ${stateCol} IN (${childList})`,
    );
    return rows.map((r) => Number(r.OBJECTID));
  }

  const parentList = buildIntegerList(parentStates, 'selectChangedObjectIds.parent');
  const plain = cols.map((c) => quoteId(driver, c.name)).join(', ');
  // Compare against the parent's TIP row per OBJECTID, never its whole history.
  // Matching ANY historical parent row would discard a legitimate edit that
  // restores a previous value (exactly what the per-op Reverse feature produces)
  // as though a reconcile had copied it in.
  //
  // Rows whose parent version lives only in the BASE table are simply not in
  // this set, so they come out as "changed" -- the safe direction: a redundant
  // replay is a no-op, whereas a missed change is lost work.
  const sql = `
    WITH parentTip AS (
      SELECT ${plain}, ROW_NUMBER() OVER (PARTITION BY ${oidCol} ORDER BY ${stateCol} DESC) AS rn
      FROM ${aTable} WHERE ${stateCol} IN (${parentList})
    )
    SELECT DISTINCT ${oidCol} AS OBJECTID FROM (
      SELECT ${cmp} FROM ${aTable} WHERE ${stateCol} IN (${childList})
      EXCEPT
      SELECT ${cmp} FROM parentTip WHERE rn = 1
    ) AS changed`;
  const rows = await connection.query<{ OBJECTID: number | string }>(sql);
  return rows.map((r) => Number(r.OBJECTID));
}

/**
 * A single column's value rendered as ONE comparable string, for hashing. Geometry
 * is not string-castable, so route it through varbinary; text is forced to a
 * binary collation for the same reason comparableExpr does. Every value is
 * COALESCEd to a sentinel so a NULL is distinct from an empty string.
 */
function hashValueExpr(driver: 'sqlserver' | 'postgresql', col: ColumnMeta, prefix: string): string {
  const q = prefix + quoteId(driver, col.name);
  const NUL = `'~egdb_null~'`;
  if (driver === 'sqlserver') {
    if (col.dataType === 'geometry' || col.dataType === 'geography') {
      return `COALESCE(CONVERT(varchar(max), CAST(${q} AS varbinary(max)), 1), ${NUL})`;
    }
    if (TEXT_TYPES.has(col.dataType)) {
      return `COALESCE(CAST(${q} AS nvarchar(max)) COLLATE Latin1_General_BIN2, ${NUL})`;
    }
    return `COALESCE(CAST(${q} AS nvarchar(max)), ${NUL})`;
  }
  return `COALESCE(CAST(${q} AS text), ${NUL})`;
}

/**
 * One column rendered as a LENGTH-PREFIXED part: `<byteLen>:<value>`. Prefixing
 * makes the row serialization injective, so a delimiter character inside a value
 * cannot shift across a column boundary and collide two different rows into the
 * same hash (which would silently drop a genuine edit). Byte length (DATALENGTH,
 * not LEN -- LEN ignores trailing spaces) so 'MAIN ST ' and 'MAIN ST' differ.
 */
function hashPartExpr(driver: 'sqlserver' | 'postgresql', col: ColumnMeta, prefix: string): string {
  const v = hashValueExpr(driver, col, prefix);
  return driver === 'sqlserver'
    ? `CONCAT(DATALENGTH(${v}), ':', ${v})`
    : `CONCAT(octet_length(${v}), ':', ${v})`;
}

/** Row hash over the payload columns (never SDE_STATE_ID). */
function rowHashExpr(driver: 'sqlserver' | 'postgresql', cols: ColumnMeta[], prefix: string): string {
  const parts = cols.map((c) => hashPartExpr(driver, c, prefix));
  return driver === 'sqlserver'
    ? `HASHBYTES('SHA2_256', CONCAT_WS('|', ${parts.join(', ')}))`
    : `md5(CONCAT_WS('|', ${parts.join(', ')}))`;
}

export interface ChildChangeClassification {
  /** Editor's genuine adds/updates to REPLAY (copy the child tip A-row). */
  replayAdds: number[];
  /** Rows the editor DELETED that the parent still has -- emit a supersede marker. */
  deletes: number[];
  /** OIDs both sides changed differently (incl. delete/update). Rebase refuses. */
  conflicts: number[];
  /** Conflicts whose child value is PRESENT (favour-edit replays these as adds). */
  conflictAdds: number[];
  /** Conflicts whose child value is ABSENT (favour-edit replays these as deletes). */
  conflictDeletes: number[];
  /** Count of child-touched OIDs that resolved to no net change (dropped). */
  dropped: number;
}

/**
 * THREE-WAY, DELETE-AWARE classification of a child version's own edits, for rebase.
 *
 * `selectChangedObjectIds` compared a child row against the parent's TIP only.
 * That was wrong in ways a rebase must not get wrong:
 *   - False keep (defect D): stale reconcile residue the parent has since changed
 *     again differs from the parent's tip and gets replayed -- reverting the
 *     parent's newer edit on post.
 *   - No conflict signal: a row BOTH sides changed differently is a genuine
 *     conflict a human must resolve, not a silent overwrite.
 *   - Delete blindness (defect E / vet #4): a create-then-delete resurrects; a
 *     delete-after-reconcile vanishes; a row the PARENT deleted but the child
 *     edited is silently resurrected.
 *
 * The correct question is the reconcile three-way over the RESOLVED value (adds
 * AND deletes) at three points: the child tip, the common ANCESTOR (where the two
 * diverged), and the parent tip. Resolution matches the reader (dbVisible): the
 * MAX-state add unless a later delete supersedes it, else the base row unless a
 * delete marker's DELETED_AT falls in the state set, else ABSENT. Each leg is thus
 * present-with-value or absent. For every OID the editor touched (add or delete):
 *   - child == ancestor                     -> no net editor change; DROP.
 *   - child != ancestor, parent == ancestor -> editor-only change:
 *       child PRESENT -> REPLAY the add; child ABSENT -> emit a DELETE marker.
 *   - child != ancestor, parent != ancestor, child == parent -> both same; DROP.
 *   - child != ancestor, parent != ancestor, child != parent -> CONFLICT
 *       (covers value/value, delete/update, and update/delete).
 *
 * Values compare by row hash so an arbitrary column set (incl. geometry) collapses
 * to one comparison; ABSENT is a distinct value from any present row.
 */
export async function classifyChildChanges(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  childStates: number[],
  parentTip: number,
  ancestorState: number,
): Promise<ChildChangeClassification> {
  const empty: ChildChangeClassification = {
    replayAdds: [], deletes: [], conflicts: [], conflictAdds: [], conflictDeletes: [], dropped: 0,
  };
  if (childStates.length === 0) return empty;
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;
  const baseTable = `${qSchema}.${quoteId(driver, tableInfo.name)}`;
  const oidCol = quoteId(driver, 'OBJECTID');
  const stateCol = quoteId(driver, 'SDE_STATE_ID');
  const dOid = driver === 'sqlserver' ? 'SDE_DELETES_ROW_ID' : 'sde_deletes_row_id';
  const dState = driver === 'sqlserver' ? 'SDE_STATE_ID' : 'sde_state_id';
  const dDelAt = driver === 'sqlserver' ? 'DELETED_AT' : 'deleted_at';

  // The A-table's payload columns also hash the BASE row (aliased b.). Standard
  // SDE registration makes the base table = business columns + no SDE_STATE_ID, so
  // every payload column exists on both by name; an adds-only column would make
  // baseHash reference a missing b.<col>. (PG geometry hashes via CAST-as-text and
  // md5, an untested path -- Putnam is SQL Server; see the rebase defect list.)
  const cols = payloadColumns(await getTableColumnsCached(connection, tableInfo.schema, `a${regId}`));
  const aHash = rowHashExpr(driver, cols, '');
  const baseHash = rowHashExpr(driver, cols, 'b.');

  const childList = buildIntegerList(childStates, 'classify.child');
  // Parent and ancestor state sets are derived IN-SQL by walking parent_state_id
  // from their tips, NOT inlined as thousands of ids: a pre-compress DEFAULT
  // ancestry can be 10k+, which would blow the query text / expression limits.
  // Base 0 is excluded (the base-row fallback covers it); an ancestorState of 0
  // yields an EMPTY walk, so the ancestor value IS the base row -- exactly the
  // compress-orphan case. `list` interpolates as a subquery, so every `IN (list)`
  // below becomes `IN (SELECT s FROM ...)`.
  const intId = (n: number, label: string): number => {
    if (!Number.isInteger(n)) throw new Error(`classifyChildChanges: ${label} must be an integer (got ${n})`);
    return n;
  };
  const statesTbl = driver === 'sqlserver' ? 'sde.SDE_states' : 'sde.sde_states';
  // UNION (not UNION ALL) on Postgres so a corrupt parent_state_id CYCLE
  // terminates -- PG has no MAXRECURSION, so a duplicate row is the only stop
  // signal (matches getStatesInRange). SQL Server bounds recursion via
  // OPTION(MAXRECURSION 0) + request timeout and requires UNION ALL. On valid
  // acyclic chains the two are identical.
  const setOp = driver === 'sqlserver' ? 'UNION ALL' : 'UNION';
  const walkCte = (name: string, tip: number): string => `
    ${name} AS (
      SELECT state_id AS s, parent_state_id AS p FROM ${statesTbl}
        WHERE state_id = ${intId(tip, name)} AND ${intId(tip, name)} <> 0
      ${setOp}
      SELECT st.state_id, st.parent_state_id FROM ${statesTbl} st
        JOIN ${name} x ON st.state_id = x.p WHERE x.p <> 0
    )`;
  const parentList = 'SELECT s FROM pstates';
  const ancList = 'SELECT s FROM astates';
  const recursive = driver === 'sqlserver' ? '' : 'RECURSIVE ';
  const maxrec = driver === 'sqlserver' ? '\n    OPTION (MAXRECURSION 0)' : '';

  // Resolved value (present + row hash) for the cand OIDs at a state set, matching
  // the reader's delete semantics:
  //   surviving add = MAX-state add NOT superseded by a delete at a strictly later
  //   state (SDE_STATE_ID > that add's state); else the base row UNLESS a marker's
  //   DELETED_AT is in the set; else absent.
  const addSuppressed = (list: string): string =>
    `EXISTS (SELECT 1 FROM ${dTable} d WHERE d.${dOid} = c.oid
             AND d.${dState} IN (${list}) AND d.${dState} > mx.am)`;
  const baseDeleted = (list: string): string =>
    `EXISTS (SELECT 1 FROM ${dTable} d WHERE d.${dOid} = c.oid AND d.${dDelAt} IN (${list}))`;
  const resolved = (name: string, list: string): string => `
    ${name} AS (
      SELECT c.oid,
        CASE WHEN mx.am IS NOT NULL AND NOT ${addSuppressed(list)} THEN 1
             WHEN mx.am IS NOT NULL THEN 0
             WHEN b.${oidCol} IS NOT NULL AND NOT ${baseDeleted(list)} THEN 1
             ELSE 0 END AS present,
        CASE WHEN mx.am IS NOT NULL AND NOT ${addSuppressed(list)} THEN at.h
             WHEN mx.am IS NULL AND b.${oidCol} IS NOT NULL AND NOT ${baseDeleted(list)} THEN ${baseHash}
             ELSE NULL END AS h
      FROM cand c
      LEFT JOIN (
        SELECT ${oidCol} AS oid, MAX(${stateCol}) AS am
        FROM ${aTable} WHERE ${stateCol} IN (${list}) GROUP BY ${oidCol}
      ) mx ON mx.oid = c.oid
      LEFT JOIN (
        SELECT ${oidCol} AS oid, ${stateCol} AS st, ${aHash} AS h
        FROM ${aTable} WHERE ${stateCol} IN (${list})
      ) at ON at.oid = c.oid AND at.st = mx.am
      LEFT JOIN ${baseTable} b ON b.${oidCol} = c.oid
    )`;

  // cand = every OID the editor touched: an add OR a delete marker (by either
  // column) in the child's own states. The delete-only OIDs catch pure base
  // deletes that have no A-row at all.
  const sql = `
    WITH ${recursive}${walkCte('pstates', parentTip)},
    ${walkCte('astates', ancestorState)},
    cand AS (
      SELECT DISTINCT ${oidCol} AS oid FROM ${aTable} WHERE ${stateCol} IN (${childList})
      UNION
      SELECT DISTINCT ${dOid} AS oid FROM ${dTable}
        WHERE ${dState} IN (${childList}) OR ${dDelAt} IN (${childList})
    ),
    ${resolved('child', childList)},
    ${resolved('anc', ancList)},
    ${resolved('par', parentList)}
    SELECT c.oid AS OBJECTID, ch.present AS childPresent,
      CASE WHEN ch.present = a.present AND (ch.present = 0 OR ch.h = a.h) THEN 1 ELSE 0 END AS childEqAnc,
      CASE WHEN p.present = a.present AND (a.present = 0 OR p.h = a.h) THEN 1 ELSE 0 END AS parentEqAnc,
      CASE WHEN ch.present = p.present AND (ch.present = 0 OR ch.h = p.h) THEN 1 ELSE 0 END AS childEqParent
    FROM cand c
    JOIN child ch ON ch.oid = c.oid
    JOIN anc a ON a.oid = c.oid
    JOIN par p ON p.oid = c.oid${maxrec}`;

  const rows = await connection.query<{
    OBJECTID: number | string; childPresent: number;
    childEqAnc: number; parentEqAnc: number; childEqParent: number;
  }>(sql);

  const out: ChildChangeClassification = {
    replayAdds: [], deletes: [], conflicts: [], conflictAdds: [], conflictDeletes: [], dropped: 0,
  };
  for (const r of rows) {
    const oid = Number(r.OBJECTID);
    const present = Number(r.childPresent) === 1;
    if (Number(r.childEqAnc) === 1) { out.dropped++; continue; } // no net editor change
    if (Number(r.parentEqAnc) === 1) {                            // editor-only change
      if (present) out.replayAdds.push(oid);
      else out.deletes.push(oid);
      continue;
    }
    if (Number(r.childEqParent) === 1) { out.dropped++; continue; } // both made the same change
    out.conflicts.push(oid);                                      // both changed, differently
    if (present) out.conflictAdds.push(oid);
    else out.conflictDeletes.push(oid);
  }
  return out;
}

/**
 * Copy, in ONE statement, the tip row for each of `objectIds` from `fromStates`
 * into `toState`.
 *
 * "Tip" = the row at the highest SDE_STATE_ID for that OBJECTID. This mirrors the
 * existing change-detection contract (get-changes keeps MAX(state) per OID): a
 * feature edited across several states must land in the target exactly once, with
 * its latest content. Copying every intermediate row instead would put duplicate
 * rows for one OBJECTID in a single state, which is invalid.
 */
export async function copyTipRows(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  fromStates: number[],
  toState: number,
  objectIds: number[],
): Promise<number> {
  if (fromStates.length === 0 || objectIds.length === 0) return 0;
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const stateCol = quoteId(driver, 'SDE_STATE_ID');
  const oidCol = quoteId(driver, 'OBJECTID');

  const cols = payloadColumns(await getTableColumnsCached(connection, tableInfo.schema, `a${regId}`));
  const list = cols.map((c) => quoteId(driver, c.name)).join(', ');
  const fromList = buildIntegerList(fromStates, 'copyTipRows.from');
  const oidList = buildIntegerList(objectIds, 'copyTipRows.oids');
  const param = driver === 'sqlserver' ? '@p0' : '$1';

  const sql = `
    INSERT INTO ${aTable} (${list}, ${stateCol})
    SELECT ${list}, ${param}
    FROM (
      SELECT ${list}, ROW_NUMBER() OVER (PARTITION BY ${oidCol} ORDER BY ${stateCol} DESC) AS rn
      FROM ${aTable}
      WHERE ${stateCol} IN (${fromList}) AND ${oidCol} IN (${oidList})
    ) AS tip
    WHERE tip.rn = 1`;

  const res = await connection.execute(sql, [toState]);
  return res.rowsAffected;
}

/**
 * Insert delete markers for `objectIds` at `toState`, in one statement.
 * Mirrors insertDeleteMarker's shape: (SDE_STATE_ID, SDE_DELETES_ROW_ID,
 * DELETED_AT) = (toState, objectId, toState).
 */
export async function insertDeleteMarkers(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectIds: number[],
  toState: number,
): Promise<number> {
  if (objectIds.length === 0) return 0;
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;
  // Validate FIRST, then build the VALUES list from the validated integers, so
  // the guard is load-bearing rather than a discarded call a cleanup could drop.
  const validated = buildIntegerList(objectIds, 'insertDeleteMarkers.oids')
    .split(',')
    .map((s) => `(${s.trim()})`)
    .join(',');
  const param = driver === 'sqlserver' ? '@p0' : '$1';

  const sql = driver === 'sqlserver'
    ? `INSERT INTO ${dTable} (SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT)
       SELECT ${param}, v.oid, ${param} FROM (VALUES ${validated}) AS v(oid)`
    : `INSERT INTO ${dTable} (sde_state_id, sde_deletes_row_id, deleted_at)
       SELECT ${param}, v.oid, ${param} FROM (VALUES ${validated}) AS v(oid)`;

  const res = await connection.execute(sql, [toState]);
  return res.rowsAffected;
}

/**
 * Insert delete markers that supersede the row a version currently resolves to.
 *
 * A marker's SDE_STATE_ID must be the state of the row being SUPERSEDED (0 when
 * that row lives in the base table) and DELETED_AT the state doing the
 * superseding. Writing (newState, newState) instead -- i.e. "delete the row at
 * newState" -- targets the A-row just written there, and Esri's *_evw readers
 * suppress on the add's own state, so the feature disappears from the version
 * when read through ArcGIS even though egdb's own reader still shows it.
 *
 * `supersededFromStates` is the parent's state set: the superseded row is that
 * OBJECTID's tip within it, or the base table if it has none.
 */
export async function insertSupersedeMarkers(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectIds: number[],
  supersededFromStates: number[],
  atState: number,
): Promise<number> {
  if (objectIds.length === 0) return 0;
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const oidCol = quoteId(driver, 'OBJECTID');
  const stateCol = quoteId(driver, 'SDE_STATE_ID');

  const validated = buildIntegerList(objectIds, 'insertSupersedeMarkers.oids')
    .split(',').map((s) => `(${s.trim()})`).join(',');
  const param = driver === 'sqlserver' ? '@p0' : '$1';
  const dCols = driver === 'sqlserver'
    ? '(SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT)'
    : '(sde_state_id, sde_deletes_row_id, deleted_at)';

  // COALESCE(..., 0): no parent A-row => the superseded row is the base row.
  const from = supersededFromStates.length > 0
    ? `LEFT JOIN (SELECT ${oidCol} AS oid, MAX(${stateCol}) AS st FROM ${aTable}
         WHERE ${stateCol} IN (${buildIntegerList(supersededFromStates, 'insertSupersedeMarkers.states')})
         GROUP BY ${oidCol}) p ON p.oid = v.oid`
    : '';
  const stExpr = supersededFromStates.length > 0 ? 'COALESCE(p.st, 0)' : '0';

  const sql = `INSERT INTO ${dTable} ${dCols}
    SELECT ${stExpr}, v.oid, ${param}
    FROM (VALUES ${validated}) AS v(oid)
    ${from}`;

  const res = await connection.execute(sql, [atState]);
  return res.rowsAffected;
}

/**
 * Every OBJECTID that has an A-row in the given states.
 *
 * Used to separate a genuine deletion from reconcile residue: a reconcile writes
 * a delete marker AND a copied A-row for each parent change, so a D-row that has
 * a paired A-row is residue, never the editor deleting something. A real deletion
 * leaves a D-row with no A-row anywhere in the version's states.
 */
export async function selectObjectIdsWithARows(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  states: number[],
): Promise<number[]> {
  if (states.length === 0) return [];
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const oidCol = quoteId(driver, 'OBJECTID');
  const stateCol = quoteId(driver, 'SDE_STATE_ID');
  const list = buildIntegerList(states, 'selectObjectIdsWithARows');
  const rows = await connection.query<{ OBJECTID: number | string }>(
    `SELECT DISTINCT ${oidCol} AS OBJECTID FROM ${aTable} WHERE ${stateCol} IN (${list})`,
  );
  return rows.map((r) => Number(r.OBJECTID));
}

/**
 * Of `objectIds`, those that already exist in the PARENT's view - either as a
 * base-table row or an A-row in the parent's states.
 *
 * This separates an UPDATE from an INSERT when replaying. Superseding a row the
 * parent has is an update and must carry a delete marker (that is exactly how the
 * editor's original edit state represented it); a feature that exists only in the
 * child is a plain insert and must NOT get a marker - a marker at the same state
 * as the A-row makes Esri's *_evw readers hide the feature entirely.
 */
export async function selectObjectIdsPresentInParent(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectIds: number[],
  parentStates: number[],
): Promise<number[]> {
  if (objectIds.length === 0) return [];
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const baseTable = `${qSchema}.${quoteId(driver, tableInfo.name)}`;
  const oidCol = quoteId(driver, 'OBJECTID');
  const stateCol = quoteId(driver, 'SDE_STATE_ID');
  const oidList = buildIntegerList(objectIds, 'selectObjectIdsPresentInParent');

  let sql = `SELECT ${oidCol} AS OBJECTID FROM ${baseTable} WHERE ${oidCol} IN (${oidList})`;
  if (parentStates.length > 0) {
    const st = buildIntegerList(parentStates, 'selectObjectIdsPresentInParent.states');
    sql += ` UNION SELECT ${oidCol} AS OBJECTID FROM ${aTable} WHERE ${oidCol} IN (${oidList}) AND ${stateCol} IN (${st})`;
  }
  const rows = await connection.query<{ OBJECTID: number | string }>(sql);
  return rows.map((r) => Number(r.OBJECTID));
}

/**
 * OBJECTIDs the child version deleted/superseded (its D-table rows), excluding
 * any that the parent already has markers for at the same states.
 */
export async function selectDeletedObjectIds(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  childStates: number[],
): Promise<number[]> {
  if (childStates.length === 0) return [];
  const regId = requireRegistrationId(tableInfo);
  const driver = connection.driver;
  const qSchema = quoteId(driver, tableInfo.schema);
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;
  const stateCol = driver === 'sqlserver' ? 'SDE_STATE_ID' : 'sde_state_id';
  const oidCol = driver === 'sqlserver' ? 'SDE_DELETES_ROW_ID' : 'sde_deletes_row_id';
  const list = buildIntegerList(childStates, 'selectDeletedObjectIds');
  const rows = await connection.query<{ OID: number | string }>(
    `SELECT DISTINCT ${oidCol} AS OID FROM ${dTable} WHERE ${stateCol} IN (${list})`,
  );
  return rows.map((r) => Number(r.OID));
}
