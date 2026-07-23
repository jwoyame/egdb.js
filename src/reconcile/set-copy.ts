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
function comparableExpr(driver: 'sqlserver' | 'postgresql', col: ColumnMeta): string {
  const q = quoteId(driver, col.name);
  if (driver === 'sqlserver' && (col.dataType === 'geometry' || col.dataType === 'geography')) {
    return `CAST(${q} AS varbinary(max)) AS ${q}`;
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
  const sql = `
    SELECT DISTINCT ${oidCol} AS OBJECTID FROM (
      SELECT ${cmp} FROM ${aTable} WHERE ${stateCol} IN (${childList})
      EXCEPT
      SELECT ${cmp} FROM ${aTable} WHERE ${stateCol} IN (${parentList})
    ) AS changed`;
  const rows = await connection.query<{ OBJECTID: number | string }>(sql);
  return rows.map((r) => Number(r.OBJECTID));
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
