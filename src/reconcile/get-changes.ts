/**
 * Functions for detecting changes in versioned tables
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo, FeatureChange, VersionChanges } from '../types';

/**
 * Quote an identifier based on database driver.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Get all changes for a single versioned table within the given states.
 *
 * Changes are categorized as:
 * - INSERT: Row in A table but NOT in D table (new feature)
 * - UPDATE: Row in BOTH A and D tables (delete old + add new = update)
 * - DELETE: Row in D table but NOT in A table (just deleted)
 *
 * @param connection Database connection
 * @param table Table info
 * @param stateIds State IDs to check for changes
 * @returns Changes found in the table
 */
export async function getTableChanges(
  connection: IDatabaseConnection,
  table: TableInfo,
  stateIds: number[]
): Promise<VersionChanges> {
  if (!table.isVersioned || !table.registrationId) {
    return { inserts: [], updates: [], deletes: [] };
  }

  if (stateIds.length === 0) {
    return { inserts: [], updates: [], deletes: [] };
  }

  const regId = table.registrationId;
  const schema = table.schema;
  const stateIdList = stateIds.join(',');
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

  // Get all rows in A table (adds) for these states
  const addsSql = driver === 'sqlserver'
    ? `SELECT OBJECTID, SDE_STATE_ID FROM ${aTable} WHERE SDE_STATE_ID IN (${stateIdList})`
    : `SELECT objectid as "OBJECTID", sde_state_id as "SDE_STATE_ID" FROM ${aTable} WHERE sde_state_id IN (${stateIdList})`;

  const addsRows = await connection.query<{ OBJECTID: number; SDE_STATE_ID: number }>(addsSql);

  // Get all rows in D table (deletes) for these states
  const deletesSql = driver === 'sqlserver'
    ? `SELECT SDE_DELETES_ROW_ID as OBJECTID, SDE_STATE_ID FROM ${dTable} WHERE SDE_STATE_ID IN (${stateIdList})`
    : `SELECT sde_deletes_row_id as "OBJECTID", sde_state_id as "SDE_STATE_ID" FROM ${dTable} WHERE sde_state_id IN (${stateIdList})`;

  const deletesRows = await connection.query<{ OBJECTID: number; SDE_STATE_ID: number }>(deletesSql);

  // Build sets for analysis
  const addedIds = new Map<number, number>(); // objectId -> stateId
  const deletedIds = new Map<number, number>(); // objectId -> stateId

  for (const row of addsRows) {
    addedIds.set(row.OBJECTID, row.SDE_STATE_ID);
  }

  for (const row of deletesRows) {
    deletedIds.set(row.OBJECTID, row.SDE_STATE_ID);
  }

  const changes: VersionChanges = { inserts: [], updates: [], deletes: [] };

  // Categorize changes
  for (const [objectId, stateId] of addedIds) {
    if (deletedIds.has(objectId)) {
      // UPDATE: appears in both A and D
      changes.updates.push({
        table: table.name,
        registrationId: regId,
        objectId,
        stateId,
        changeType: 'update'
      });
    } else {
      // INSERT: only in A
      changes.inserts.push({
        table: table.name,
        registrationId: regId,
        objectId,
        stateId,
        changeType: 'insert'
      });
    }
  }

  for (const [objectId, stateId] of deletedIds) {
    if (!addedIds.has(objectId)) {
      // DELETE: only in D
      changes.deletes.push({
        table: table.name,
        registrationId: regId,
        objectId,
        stateId,
        changeType: 'delete'
      });
    }
    // If also in A, it's an UPDATE (already handled above)
  }

  return changes;
}

/**
 * Get changes across all versioned tables.
 *
 * @param connection Database connection
 * @param tables All tables in the geodatabase
 * @param stateIds State IDs to check for changes
 * @returns Combined changes from all tables
 */
export async function getAllChanges(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  stateIds: number[]
): Promise<VersionChanges> {
  const allChanges: VersionChanges = { inserts: [], updates: [], deletes: [] };

  for (const table of tables) {
    if (!table.isVersioned) continue;

    const tableChanges = await getTableChanges(connection, table, stateIds);
    allChanges.inserts.push(...tableChanges.inserts);
    allChanges.updates.push(...tableChanges.updates);
    allChanges.deletes.push(...tableChanges.deletes);
  }

  return allChanges;
}

/**
 * Get a summary of changes (counts only, no details).
 *
 * @param changes Version changes
 * @returns Summary object with counts
 */
export function getChangesSummary(changes: VersionChanges): {
  totalChanges: number;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  tablesAffected: string[];
} {
  const tablesAffected = new Set<string>();

  for (const c of [...changes.inserts, ...changes.updates, ...changes.deletes]) {
    tablesAffected.add(c.table);
  }

  return {
    totalChanges: changes.inserts.length + changes.updates.length + changes.deletes.length,
    insertCount: changes.inserts.length,
    updateCount: changes.updates.length,
    deleteCount: changes.deletes.length,
    tablesAffected: Array.from(tablesAffected)
  };
}
