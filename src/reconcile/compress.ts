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
 * Excludes states currently held by an active EditSession (via SDE_state_locks).
 * The locks subquery is embedded in each DELETE statement so the lock check
 * is evaluated atomically with the delete: a lock that becomes visible after
 * our orphan-find SELECT but before our DELETE will still be honored, because
 * the DELETE re-evaluates the subquery at execution time.
 *
 * What this still cannot prevent: a session that COMMITS its lock insert
 * between when we read the orphan list and when the database executes the
 * DELETE — the new lock will be re-checked by the embedded subquery and the
 * row stays. The genuinely missed case would be a session whose lock insert
 * isn't yet committed at DELETE time; that lock isn't visible to our
 * statement, but its child state was created in the same uncommitted
 * transaction so it won't appear in our orphan list either. Net result:
 * concurrent EditSession.start is safe.
 *
 * Caveat (pre-existing, not in scope for this commit): every state has a
 * self-row in SDE_state_lineages (lineage_name = lineage_id = state_id),
 * which means the `NOT IN (SELECT lineage_id ...)` clause excludes a state
 * from the orphan list as long as its self-lineage row exists. So this
 * function is best understood as a safety net for partial-cleanup scenarios
 * (e.g. a discard that died between deleting lineage rows and deleting the
 * state row), not the primary state-deletion path.
 *
 * The multi-table cleanup is wrapped in a transaction so lineage and state
 * deletes commit together.
 *
 * @returns Number of states removed
 */
export async function removeOrphanedStates(
  connection: IDatabaseConnection
): Promise<number> {
  const wasInTx = connection.inTransaction();
  if (!wasInTx) await connection.beginTransaction();

  try {
    const findOrphansSql = connection.driver === 'sqlserver'
      ? `
        SELECT state_id
        FROM sde.SDE_states
        WHERE state_id != 0
          AND state_id NOT IN (SELECT state_id FROM sde.SDE_versions WHERE state_id IS NOT NULL)
          AND state_id NOT IN (SELECT DISTINCT lineage_id FROM sde.SDE_state_lineages)
          AND state_id NOT IN (SELECT DISTINCT state_id FROM sde.SDE_state_locks)
      `
      : `
        SELECT state_id
        FROM sde.sde_states
        WHERE state_id != 0
          AND state_id NOT IN (SELECT state_id FROM sde.sde_versions WHERE state_id IS NOT NULL)
          AND state_id NOT IN (SELECT DISTINCT lineage_id FROM sde.sde_state_lineages)
          AND state_id NOT IN (SELECT DISTINCT state_id FROM sde.sde_state_locks)
      `;

    const orphans = await connection.query<{ state_id: number }>(findOrphansSql);
    if (orphans.length === 0) {
      if (!wasInTx) await connection.commitTransaction();
      return 0;
    }

    const orphanIds = orphans.map((o) => o.state_id);
    const orphanList = buildIntegerList(orphanIds, 'removeOrphanedStates');

    // Each DELETE re-checks SDE_state_locks atomically. Lineages first because
    // SDE_state_lineages.lineage_name has an FK to SDE_states.state_id.
    const deleteLineagesSql = connection.driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_state_lineages
         WHERE lineage_name IN (${orphanList})
           AND lineage_name NOT IN (SELECT DISTINCT state_id FROM sde.SDE_state_locks)`
      : `DELETE FROM sde.sde_state_lineages
         WHERE lineage_name IN (${orphanList})
           AND lineage_name NOT IN (SELECT DISTINCT state_id FROM sde.sde_state_locks)`;
    await connection.execute(deleteLineagesSql);

    const deleteStatesSql = connection.driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_states
         WHERE state_id IN (${orphanList})
           AND state_id NOT IN (SELECT DISTINCT state_id FROM sde.SDE_state_locks)`
      : `DELETE FROM sde.sde_states
         WHERE state_id IN (${orphanList})
           AND state_id NOT IN (SELECT DISTINCT state_id FROM sde.sde_state_locks)`;
    const result = await connection.execute(deleteStatesSql);

    if (!wasInTx) await connection.commitTransaction();
    return result.rowsAffected;
  } catch (error) {
    if (!wasInTx) await connection.rollbackTransaction();
    throw error;
  }
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
