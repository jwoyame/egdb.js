/**
 * Functions for posting changes from child to parent version
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';

/**
 * Quote an identifier based on database driver.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Check if a child version has been reconciled with its parent.
 * The child's lineage must include the parent's current state.
 *
 * @param connection Database connection
 * @param childStateId Child version's state ID
 * @param parentStateId Parent version's state ID
 * @returns True if reconciled
 */
export async function isReconciled(
  connection: IDatabaseConnection,
  childStateId: number,
  parentStateId: number
): Promise<boolean> {
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT 1 FROM sde.SDE_state_lineages
      WHERE lineage_name = (SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0)
        AND lineage_id = @p1
    `
    : `
      SELECT 1 FROM sde.sde_state_lineages
      WHERE lineage_name = (SELECT lineage_name FROM sde.sde_states WHERE state_id = $1)
        AND lineage_id = $2
    `;

  const result = await connection.query(sql, [childStateId, parentStateId]);
  return result.length > 0;
}

/**
 * Post changes from child version to parent.
 * Moves all A/D table entries from child's states to parent's state.
 *
 * @param connection Database connection
 * @param tables All tables in geodatabase
 * @param childStateIds State IDs that belong to the child version
 * @param parentStateId Parent version's state ID
 * @returns Number of changes posted
 */
export async function postChangesToParent(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  childStateIds: number[],
  parentStateId: number
): Promise<number> {
  if (childStateIds.length === 0) {
    return 0;
  }

  const driver = connection.driver;
  const childStateList = childStateIds.join(',');
  let postedCount = 0;

  for (const table of tables) {
    if (!table.isVersioned || !table.registrationId) continue;

    const regId = table.registrationId;
    const schema = table.schema;

    const qSchema = quoteId(driver, schema);
    const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
    const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

    // Move A table entries: change SDE_STATE_ID from child states to parent state
    const moveASql = driver === 'sqlserver'
      ? `UPDATE ${aTable} SET [SDE_STATE_ID] = @p0 WHERE [SDE_STATE_ID] IN (${childStateList})`
      : `UPDATE ${aTable} SET "sde_state_id" = $1 WHERE "sde_state_id" IN (${childStateList})`;

    const aResult = await connection.execute(moveASql, [parentStateId]);
    postedCount += aResult.rowsAffected;

    // Move D table entries similarly
    const moveDSql = driver === 'sqlserver'
      ? `UPDATE ${dTable} SET [SDE_STATE_ID] = @p0, [DELETED_AT] = @p0 WHERE [SDE_STATE_ID] IN (${childStateList})`
      : `UPDATE ${dTable} SET "sde_state_id" = $1, "deleted_at" = $1 WHERE "sde_state_id" IN (${childStateList})`;

    await connection.execute(moveDSql, [parentStateId]);
  }

  return postedCount;
}

/**
 * Update a version's state_id in the versions table.
 *
 * @param connection Database connection
 * @param versionOwner Version owner
 * @param versionName Version name
 * @param newStateId New state ID
 */
export async function updateVersionState(
  connection: IDatabaseConnection,
  versionOwner: string,
  versionName: string,
  newStateId: number
): Promise<void> {
  const sql = connection.driver === 'sqlserver'
    ? `UPDATE sde.SDE_versions SET state_id = @p0 WHERE owner = @p1 AND name = @p2`
    : `UPDATE sde.sde_versions SET state_id = $1 WHERE owner = $2 AND name = $3`;

  await connection.execute(sql, [newStateId, versionOwner, versionName]);
}

/**
 * Delete states from the states table.
 * Used after posting to clean up child-only states.
 *
 * @param connection Database connection
 * @param stateIds State IDs to delete
 */
export async function deleteStates(
  connection: IDatabaseConnection,
  stateIds: number[]
): Promise<void> {
  if (stateIds.length === 0) return;

  const stateList = stateIds.join(',');

  // First remove from state_lineages
  const deleteLineagesSql = connection.driver === 'sqlserver'
    ? `DELETE FROM sde.SDE_state_lineages WHERE lineage_id IN (${stateList})`
    : `DELETE FROM sde.sde_state_lineages WHERE lineage_id IN (${stateList})`;

  await connection.execute(deleteLineagesSql, []);

  // Then remove from states
  const deleteStatesSql = connection.driver === 'sqlserver'
    ? `DELETE FROM sde.SDE_states WHERE state_id IN (${stateList})`
    : `DELETE FROM sde.sde_states WHERE state_id IN (${stateList})`;

  await connection.execute(deleteStatesSql, []);
}

/**
 * Get child version's unique states (states not in parent's lineage).
 *
 * @param connection Database connection
 * @param childStateId Child version's current state
 * @param parentStateId Parent version's current state
 * @returns Array of state IDs unique to child
 */
export async function getChildUniqueStates(
  connection: IDatabaseConnection,
  childStateId: number,
  parentStateId: number
): Promise<number[]> {
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT lineage_id as state_id
      FROM sde.SDE_state_lineages
      WHERE lineage_name = (SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0)
        AND lineage_id NOT IN (
          SELECT lineage_id FROM sde.SDE_state_lineages
          WHERE lineage_name = (SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p1)
        )
      ORDER BY lineage_id
    `
    : `
      SELECT lineage_id as state_id
      FROM sde.sde_state_lineages
      WHERE lineage_name = (SELECT lineage_name FROM sde.sde_states WHERE state_id = $1)
        AND lineage_id NOT IN (
          SELECT lineage_id FROM sde.sde_state_lineages
          WHERE lineage_name = (SELECT lineage_name FROM sde.sde_states WHERE state_id = $2)
        )
      ORDER BY lineage_id
    `;

  const result = await connection.query<{ state_id: number }>(sql, [childStateId, parentStateId]);
  return result.map(r => r.state_id);
}
