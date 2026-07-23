/**
 * Functions for applying changes during reconcile
 */

import type { IDatabaseConnection } from '../connections/connection';
import type {
  TableInfo,
  VersionChanges,
  FeatureChange,
  DetailedConflict,
  ReconcileOptions,
  ConflictResolution,
} from '../types';
import { readATableRow } from './read-row-data';
import { requireRegistrationId } from '../utils/guards';
import { copyTipRows, insertDeleteMarkers, selectObjectIdsWithARows } from './set-copy';

/**
 * Quote an identifier based on database driver.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Get column names from a table (excluding internal columns).
 */
async function getTableColumns(
  connection: IDatabaseConnection,
  schema: string,
  tableName: string
): Promise<string[]> {
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1
      ORDER BY ORDINAL_POSITION
    `
    : `
      SELECT column_name as "COLUMN_NAME"
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;

  const columns = await connection.query<{ COLUMN_NAME: string }>(sql, [schema, tableName]);
  return columns.map(c => c.COLUMN_NAME);
}

/**
 * Copy a row from A table with one state_id to another state_id.
 */
export async function copyATableRow(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  fromStateId: number,
  toStateId: number
): Promise<number> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  // Get column names (excluding SDE_STATE_ID which we'll set)
  const allColumns = await getTableColumns(connection, schema, `a${regId}`);
  const columnNames = allColumns.filter(c => c.toUpperCase() !== 'SDE_STATE_ID');

  const quotedColumns = columnNames.map(c => quoteId(driver, c));

  const qSchema = quoteId(driver, schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;

  // Build INSERT...SELECT statement
  const sql = driver === 'sqlserver'
    ? `
      INSERT INTO ${aTable} (${quotedColumns.join(', ')}, [SDE_STATE_ID])
      SELECT ${quotedColumns.join(', ')}, @p0
      FROM ${aTable}
      WHERE [OBJECTID] = @p1 AND [SDE_STATE_ID] = @p2
    `
    : `
      INSERT INTO ${aTable} (${quotedColumns.join(', ')}, "sde_state_id")
      SELECT ${quotedColumns.join(', ')}, $1
      FROM ${aTable}
      WHERE "objectid" = $2 AND "sde_state_id" = $3
    `;

  const res = await connection.execute(sql, [toStateId, objectId, fromStateId]);
  return res.rowsAffected;
}

/**
 * Insert a delete marker into the D table.
 */
export async function insertDeleteMarker(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  stateId: number
): Promise<void> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

  const sql = driver === 'sqlserver'
    ? `INSERT INTO ${dTable} (SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT) VALUES (@p0, @p1, @p2)`
    : `INSERT INTO ${dTable} (sde_state_id, sde_deletes_row_id, deleted_at) VALUES ($1, $2, $3)`;

  await connection.execute(sql, [stateId, objectId, stateId]);
}

/**
 * Remove a row from the A table.
 */
export async function removeFromATable(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  stateId: number
): Promise<void> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;

  const sql = driver === 'sqlserver'
    ? `DELETE FROM ${aTable} WHERE [OBJECTID] = @p0 AND [SDE_STATE_ID] = @p1`
    : `DELETE FROM ${aTable} WHERE "objectid" = $1 AND "sde_state_id" = $2`;

  await connection.execute(sql, [objectId, stateId]);
}

/**
 * Remove a row from the D table.
 */
export async function removeFromDTable(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  stateId: number
): Promise<void> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

  const sql = driver === 'sqlserver'
    ? `DELETE FROM ${dTable} WHERE [SDE_DELETES_ROW_ID] = @p0 AND [SDE_STATE_ID] = @p1`
    : `DELETE FROM ${dTable} WHERE "sde_deletes_row_id" = $1 AND "sde_state_id" = $2`;

  await connection.execute(sql, [objectId, stateId]);
}

/**
 * Apply merged values to a row in the A table.
 */
export async function applyMergedRow(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  stateId: number,
  mergedValues: Record<string, unknown>
): Promise<void> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;

  // Build SET clauses
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 0;

  for (const [key, value] of Object.entries(mergedValues)) {
    const keyUpper = key.toUpperCase();
    if (keyUpper === 'OBJECTID' || keyUpper === 'SDE_STATE_ID') continue;

    const quotedKey = quoteId(driver, key);
    const param = driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`;
    setClauses.push(`${quotedKey} = ${param}`);
    values.push(value);
    paramIndex++;
  }

  if (setClauses.length === 0) return;

  values.push(objectId, stateId);
  const oidParam = driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`;
  const stateParam = driver === 'sqlserver' ? `@p${paramIndex + 1}` : `$${paramIndex + 2}`;

  const sql = driver === 'sqlserver'
    ? `UPDATE ${aTable} SET ${setClauses.join(', ')} WHERE [OBJECTID] = ${oidParam} AND [SDE_STATE_ID] = ${stateParam}`
    : `UPDATE ${aTable} SET ${setClauses.join(', ')} WHERE "objectid" = ${oidParam} AND "sde_state_id" = ${stateParam}`;

  await connection.execute(sql, values);
}

/**
 * Apply parent changes to the child version during reconcile.
 *
 * @param connection Database connection
 * @param tables All tables in geodatabase
 * @param parentChanges Changes from parent version
 * @param conflicts Detected conflicts
 * @param childStateId Child version's state ID
 * @param options Reconcile options
 * @returns Count of applied and merged changes
 */
export async function applyParentChanges(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  parentChanges: VersionChanges,
  conflicts: DetailedConflict[],
  childStateId: number,
  options: ReconcileOptions
): Promise<{ appliedCount: number; mergedCount: number }> {
  const defaultResolution = options.conflictResolution ?? 'favor_edit';
  const autoMerge = options.autoMerge ?? true;

  // Build conflict lookup
  const conflictMap = new Map<string, DetailedConflict>();
  for (const c of conflicts) {
    conflictMap.set(`${c.table}:${c.objectId}`, c);
  }

  let appliedCount = 0;
  let mergedCount = 0;

  // Process all parent changes
  const allChanges = [...parentChanges.inserts, ...parentChanges.updates, ...parentChanges.deletes];

  // ------------------------------------------------------------------
  // Fast path: every change WITHOUT a conflict is applied set-based.
  //
  // Catching a version up to DEFAULT on a real fabric means tens of thousands of
  // features. Doing that one row at a time -- each copy re-reading
  // INFORMATION_SCHEMA -- is minutes of sequential round-trips, which is what
  // made Submit time out. Conflicts are rare and need a per-row decision, so
  // they keep the original loop below.
  // ------------------------------------------------------------------
  const isConflicted = (c: FeatureChange) => conflictMap.has(`${c.table}:${c.objectId}`);
  const plain = allChanges.filter((c) => !isConflicted(c));
  const conflicted = allChanges.filter(isConflicted);

  const byTable = new Map<string, FeatureChange[]>();
  for (const c of plain) {
    const list = byTable.get(c.table) ?? [];
    list.push(c);
    byTable.set(c.table, list);
  }

  const uniq = (ns: number[]) => [...new Set(ns)];
  // Chunk the IN-lists: one statement per chunk still collapses thousands of
  // round-trips while keeping any single statement a sane size.
  const CHUNK = 2000;
  function chunk<T>(arr: T[]): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK));
    return out;
  }

  for (const [tableName, changes] of byTable) {
    const tableInfo = tables.find((t) => t.name === tableName);
    if (!tableInfo) continue;

    const ins = changes.filter((c) => c.changeType === 'insert');
    const upd = changes.filter((c) => c.changeType === 'update');
    const del = changes.filter((c) => c.changeType === 'delete');

    // Every copy MUST move exactly one row per OBJECTID. A short copy would leave
    // a delete marker with no A-row behind it -- a feature that silently vanishes
    // from the version -- so fail loudly and roll back rather than report a
    // success that quietly dropped data. trim-post asserts the same thing per
    // row; the bulk path must not lose that guarantee.
    const copyOrThrow = async (fromStates: number[], oids: number[]) => {
      const moved = await copyTipRows(connection, tableInfo, fromStates, childStateId, oids);
      if (moved !== oids.length) {
        throw new Error(
          `Reconcile failed to copy A-rows for ${tableInfo.name}: moved ${moved} of ${oids.length} ` +
          `expected rows into state ${childStateId}. The reconcile was NOT applied.`,
        );
      }
    };

    // Inserts: copy the parent's tip row per OBJECTID straight in.
    for (const part of chunk(ins)) {
      await copyOrThrow(uniq(part.map((c) => c.stateId)), uniq(part.map((c) => c.objectId)));
    }
    appliedCount += ins.length;

    // Updates: skip any OBJECTID the child already modified in its own state --
    // the same guard the row-by-row path applied via readATableRow, so the
    // child's edit is never clobbered. The rest get delete-marker + A-row.
    //
    // NOTE (load-bearing): `alreadyMine` is read AFTER this table's inserts have
    // written A-rows at childStateId. That is only safe because get-changes emits
    // each OBJECTID exactly once per table, so the insert and update OID sets are
    // disjoint and an insert can never make an update look "already mine".
    if (upd.length > 0) {
      const alreadyMine = new Set(
        await selectObjectIdsWithARows(connection, tableInfo, [childStateId]),
      );
      const todo = upd.filter((c) => !alreadyMine.has(c.objectId));
      for (const part of chunk(todo)) {
        const oids = uniq(part.map((c) => c.objectId));
        await insertDeleteMarkers(connection, tableInfo, oids, childStateId);
        await copyOrThrow(uniq(part.map((c) => c.stateId)), oids);
      }
      // Count matches the previous behaviour: an update is "applied" even when
      // the child's own edit caused it to be skipped.
      appliedCount += upd.length;
    }

    // Deletes: markers only.
    for (const part of chunk(del)) {
      await insertDeleteMarkers(connection, tableInfo, uniq(part.map((c) => c.objectId)), childStateId);
    }
    appliedCount += del.length;
  }

  // ------------------------------------------------------------------
  // Conflicts keep the original per-row handling (few, each needs a decision).
  // ------------------------------------------------------------------
  for (const change of conflicted) {
    const key = `${change.table}:${change.objectId}`;
    const conflict = conflictMap.get(key);
    const tableInfo = tables.find(t => t.name === change.table);

    if (!tableInfo) continue;

    if (conflict) {
      // Handle conflict
      let resolution: ConflictResolution;

      if (options.resolveConflictAuthoritative) {
        // Callback-first mode: the caller's resolveConflict is the
        // single decision point for every conflict, including auto-
        // mergeable ones. Without a callback this option is a
        // misconfiguration because there is no resolution policy.
        if (!options.resolveConflict) {
          throw new Error(
            'resolveConflictAuthoritative requires a resolveConflict callback'
          );
        }
        resolution = await options.resolveConflict(conflict);
      } else if (autoMerge && conflict.autoMergeable) {
        resolution = 'merge';
      } else if (options.resolveConflict) {
        resolution = await options.resolveConflict(conflict);
      } else {
        resolution = defaultResolution;
      }

      if (resolution === 'favor_edit') {
        // Keep child's version - skip parent's change
        continue;
      } else if (resolution === 'favor_target') {
        // Remove child's changes first
        await removeFromATable(connection, tableInfo, change.objectId, childStateId);
        await removeFromDTable(connection, tableInfo, change.objectId, childStateId);
        // Then apply parent's change (fall through to below)
      } else if (resolution === 'merge') {
        // Get merged values. In authoritative mode the caller's
        // getMergedValues wins over the conflict's suggestedMerge, so
        // a caller that wants to override an auto-mergeable suggestion
        // can do so. In the default mode the suggestedMerge wins to
        // preserve existing behaviour.
        let mergedValues: Record<string, unknown>;
        if (options.resolveConflictAuthoritative && options.getMergedValues) {
          mergedValues = await options.getMergedValues(conflict);
        } else if (conflict.suggestedMerge) {
          mergedValues = conflict.suggestedMerge;
        } else if (options.getMergedValues) {
          mergedValues = await options.getMergedValues(conflict);
        } else {
          throw new Error(`Cannot merge conflict on ${key}: no merged values provided`);
        }

        await applyMergedRow(connection, tableInfo, change.objectId, childStateId, mergedValues);
        mergedCount++;
        continue;
      }
    }

    // Apply parent's change to child
    if (change.changeType === 'insert') {
      // Copy the inserted row from parent's state to child's state
      await copyATableRow(connection, tableInfo, change.objectId, change.stateId, childStateId);
      appliedCount++;
    } else if (change.changeType === 'update') {
      // For updates, we need both the D and A table entries
      // First, check if child already has this objectId in its A table
      const existingRow = await readATableRow(connection, tableInfo, change.objectId, childStateId);

      if (!existingRow) {
        // Child doesn't have this row modified - copy both D and A entries
        await insertDeleteMarker(connection, tableInfo, change.objectId, childStateId);
        await copyATableRow(connection, tableInfo, change.objectId, change.stateId, childStateId);
      }
      // If child already has modified this row, we've either skipped (favor_edit) or removed it (favor_target)
      appliedCount++;
    } else if (change.changeType === 'delete') {
      // Add delete marker
      await insertDeleteMarker(connection, tableInfo, change.objectId, childStateId);
      appliedCount++;
    }
  }

  return { appliedCount, mergedCount };
}
