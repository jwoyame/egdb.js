/**
 * Functions for compressing versioned tables (removing redundant A/D entries)
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo, CompressResult } from '../types';
import { buildIntegerList } from '../utils/sql-helpers';

/**
 * Quote an identifier based on database driver.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Remove redundant entries from A/D tables for specific states.
 *
 * Redundant entries:
 * 1. Insert + Delete of same OBJECTID = remove both (net effect: nothing)
 * 2. Multiple A table entries for same OBJECTID = keep only latest state
 * 3. D table entry for OBJECTID not in base table and not in earlier A = remove
 *
 * @param connection Database connection
 * @param tables All tables in geodatabase
 * @param stateIds State IDs to compress
 * @returns Compression result
 */
export async function compressStates(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  stateIds: number[]
): Promise<CompressResult> {
  if (stateIds.length === 0) {
    return { addsRemoved: 0, deletesRemoved: 0, statesRemoved: 0 };
  }

  const driver = connection.driver;
  const stateList = buildIntegerList(stateIds, 'compressStates');
  let addsRemoved = 0;
  let deletesRemoved = 0;

  for (const table of tables) {
    if (!table.isVersioned || !table.registrationId) continue;

    const regId = table.registrationId;
    const schema = table.schema;

    const qSchema = quoteId(driver, schema);
    const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
    const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

    // 1. Find insert+delete pairs within these states
    // These are OBJECTIDs that appear in both A and D tables
    // where the feature was inserted then deleted (or vice versa) in this version
    const pairsSql = driver === 'sqlserver'
      ? `
        SELECT DISTINCT a.OBJECTID
        FROM ${aTable} a
        INNER JOIN ${dTable} d ON a.OBJECTID = d.SDE_DELETES_ROW_ID
        WHERE a.SDE_STATE_ID IN (${stateList})
          AND d.SDE_STATE_ID IN (${stateList})
      `
      : `
        SELECT DISTINCT a.objectid as "OBJECTID"
        FROM ${aTable} a
        INNER JOIN ${dTable} d ON a.objectid = d.sde_deletes_row_id
        WHERE a.sde_state_id IN (${stateList})
          AND d.sde_state_id IN (${stateList})
      `;

    const pairs = await connection.query<{ OBJECTID: number }>(pairsSql);

    for (const pair of pairs) {
      const oid = pair.OBJECTID;

      // Check if this OBJECTID exists in base table or in A table for earlier states
      // If it doesn't exist anywhere else, this is a "phantom" - inserted then deleted
      const existsInBaseSql = driver === 'sqlserver'
        ? `SELECT 1 FROM ${qSchema}.${quoteId(driver, table.name)} WHERE [OBJECTID] = @p0`
        : `SELECT 1 FROM ${qSchema}.${quoteId(driver, table.name)} WHERE "objectid" = $1`;

      const existsInBase = await connection.query(existsInBaseSql, [oid]);

      const existsInOtherStatesSql = driver === 'sqlserver'
        ? `SELECT 1 FROM ${aTable} WHERE [OBJECTID] = @p0 AND [SDE_STATE_ID] NOT IN (${stateList})`
        : `SELECT 1 FROM ${aTable} WHERE "objectid" = $1 AND "sde_state_id" NOT IN (${stateList})`;

      const existsInOtherStates = await connection.query(existsInOtherStatesSql, [oid]);

      if (existsInBase.length === 0 && existsInOtherStates.length === 0) {
        // This is a phantom - remove from both A and D
        const delASql = driver === 'sqlserver'
          ? `DELETE FROM ${aTable} WHERE [OBJECTID] = @p0 AND [SDE_STATE_ID] IN (${stateList})`
          : `DELETE FROM ${aTable} WHERE "objectid" = $1 AND "sde_state_id" IN (${stateList})`;
        const aResult = await connection.execute(delASql, [oid]);
        addsRemoved += aResult.rowsAffected;

        const delDSql = driver === 'sqlserver'
          ? `DELETE FROM ${dTable} WHERE [SDE_DELETES_ROW_ID] = @p0 AND [SDE_STATE_ID] IN (${stateList})`
          : `DELETE FROM ${dTable} WHERE "sde_deletes_row_id" = $1 AND "sde_state_id" IN (${stateList})`;
        const dResult = await connection.execute(delDSql, [oid]);
        deletesRemoved += dResult.rowsAffected;
      }
    }

    // 2. Remove duplicate A table entries (keep only the one with highest state_id)
    // This handles cases where the same feature was updated multiple times
    if (stateIds.length > 1) {
      const dupsSql = driver === 'sqlserver'
        ? `
          DELETE a1 FROM ${aTable} a1
          WHERE a1.SDE_STATE_ID IN (${stateList})
            AND EXISTS (
              SELECT 1 FROM ${aTable} a2
              WHERE a2.OBJECTID = a1.OBJECTID
                AND a2.SDE_STATE_ID IN (${stateList})
                AND a2.SDE_STATE_ID > a1.SDE_STATE_ID
            )
        `
        : `
          DELETE FROM ${aTable}
          WHERE ctid IN (
            SELECT a1.ctid FROM ${aTable} a1
            WHERE a1.sde_state_id IN (${stateList})
              AND EXISTS (
                SELECT 1 FROM ${aTable} a2
                WHERE a2.objectid = a1.objectid
                  AND a2.sde_state_id IN (${stateList})
                  AND a2.sde_state_id > a1.sde_state_id
              )
          )
        `;
      const dupsResult = await connection.execute(dupsSql, []);
      addsRemoved += dupsResult.rowsAffected;
    }
  }

  return { addsRemoved, deletesRemoved, statesRemoved: 0 };
}

/**
 * Remove orphaned states (states not referenced by any version or lineage).
 *
 * @param connection Database connection
 * @returns Number of states removed
 */
export async function removeOrphanedStates(
  connection: IDatabaseConnection
): Promise<number> {
  // Find states that:
  // 1. Are not the current state of any version
  // 2. Are not in any lineage
  // 3. Are not state 0 (initial state)
  const findOrphansSql = connection.driver === 'sqlserver'
    ? `
      SELECT state_id
      FROM sde.SDE_states
      WHERE state_id != 0
        AND state_id NOT IN (SELECT state_id FROM sde.SDE_versions WHERE state_id IS NOT NULL)
        AND state_id NOT IN (SELECT DISTINCT lineage_id FROM sde.SDE_state_lineages)
    `
    : `
      SELECT state_id
      FROM sde.sde_states
      WHERE state_id != 0
        AND state_id NOT IN (SELECT state_id FROM sde.sde_versions WHERE state_id IS NOT NULL)
        AND state_id NOT IN (SELECT DISTINCT lineage_id FROM sde.sde_state_lineages)
    `;

  const orphans = await connection.query<{ state_id: number }>(findOrphansSql);

  if (orphans.length === 0) {
    return 0;
  }

  const orphanIds = orphans.map(o => o.state_id);
  const orphanList = buildIntegerList(orphanIds, 'removeOrphanedStates');

  // Delete orphaned states
  const deleteSql = connection.driver === 'sqlserver'
    ? `DELETE FROM sde.SDE_states WHERE state_id IN (${orphanList})`
    : `DELETE FROM sde.sde_states WHERE state_id IN (${orphanList})`;

  const result = await connection.execute(deleteSql, []);
  return result.rowsAffected;
}

/**
 * Get statistics about A/D table sizes for a version.
 *
 * @param connection Database connection
 * @param tables All tables in geodatabase
 * @param stateIds State IDs to analyze
 * @returns Statistics per table
 */
export async function getVersionStats(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  stateIds: number[]
): Promise<Map<string, { adds: number; deletes: number }>> {
  const stats = new Map<string, { adds: number; deletes: number }>();

  if (stateIds.length === 0) {
    return stats;
  }

  const stateList = buildIntegerList(stateIds, 'getVersionStats');
  const driver = connection.driver;

  for (const table of tables) {
    if (!table.isVersioned || !table.registrationId) continue;

    const regId = table.registrationId;
    const schema = table.schema;

    const qSchema = quoteId(driver, schema);
    const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
    const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

    const addCountSql = driver === 'sqlserver'
      ? `SELECT COUNT(*) as cnt FROM ${aTable} WHERE SDE_STATE_ID IN (${stateList})`
      : `SELECT COUNT(*) as cnt FROM ${aTable} WHERE sde_state_id IN (${stateList})`;

    const deleteCountSql = driver === 'sqlserver'
      ? `SELECT COUNT(*) as cnt FROM ${dTable} WHERE SDE_STATE_ID IN (${stateList})`
      : `SELECT COUNT(*) as cnt FROM ${dTable} WHERE sde_state_id IN (${stateList})`;

    const [addResult, deleteResult] = await Promise.all([
      connection.query<{ cnt: number }>(addCountSql),
      connection.query<{ cnt: number }>(deleteCountSql)
    ]);

    const adds = addResult[0]?.cnt ?? 0;
    const deletes = deleteResult[0]?.cnt ?? 0;

    if (adds > 0 || deletes > 0) {
      stats.set(table.name, { adds, deletes });
    }
  }

  return stats;
}
