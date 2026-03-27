/**
 * Helper functions for finding common ancestors and state lineages
 */

import type { IDatabaseConnection } from '../connections/connection';

/**
 * Find the common ancestor state between two versions.
 * This is the highest state ID that appears in both lineages.
 *
 * @param connection Database connection
 * @param childStateId State ID of the child version
 * @param parentStateId State ID of the parent version
 * @returns The common ancestor state ID
 */
export async function findCommonAncestor(
  connection: IDatabaseConnection,
  childStateId: number,
  parentStateId: number
): Promise<number> {
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT MAX(child_lin.lineage_id) as ancestor_state_id
      FROM sde.SDE_state_lineages child_lin
      WHERE child_lin.lineage_name = (
        SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0
      )
      AND child_lin.lineage_id IN (
        SELECT lineage_id FROM sde.SDE_state_lineages
        WHERE lineage_name = (
          SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p1
        )
      )
    `
    : `
      SELECT MAX(child_lin.lineage_id) as ancestor_state_id
      FROM sde.sde_state_lineages child_lin
      WHERE child_lin.lineage_name = (
        SELECT lineage_name FROM sde.sde_states WHERE state_id = $1
      )
      AND child_lin.lineage_id IN (
        SELECT lineage_id FROM sde.sde_state_lineages
        WHERE lineage_name = (
          SELECT lineage_name FROM sde.sde_states WHERE state_id = $2
        )
      )
    `;

  const result = await connection.query<{ ancestor_state_id: number | null }>(
    sql,
    [childStateId, parentStateId]
  );

  const ancestorStateId = result[0]?.ancestor_state_id;
  if (ancestorStateId === null || ancestorStateId === undefined) {
    throw new Error(
      `Could not find common ancestor between states ${childStateId} and ${parentStateId}`
    );
  }

  return ancestorStateId;
}

/**
 * Get all state IDs in a version's lineage between ancestor and current state.
 * Returns states > ancestorStateId and <= versionStateId.
 *
 * @param connection Database connection
 * @param versionStateId Current state ID of the version
 * @param ancestorStateId Ancestor state ID (exclusive lower bound)
 * @returns Array of state IDs in ascending order
 */
export async function getStatesInRange(
  connection: IDatabaseConnection,
  versionStateId: number,
  ancestorStateId: number
): Promise<number[]> {
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT lineage_id as state_id
      FROM sde.SDE_state_lineages
      WHERE lineage_name = (
        SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0
      )
      AND lineage_id > @p1
      AND lineage_id <= @p0
      ORDER BY lineage_id
    `
    : `
      SELECT lineage_id as state_id
      FROM sde.sde_state_lineages
      WHERE lineage_name = (
        SELECT lineage_name FROM sde.sde_states WHERE state_id = $1
      )
      AND lineage_id > $2
      AND lineage_id <= $1
      ORDER BY lineage_id
    `;

  const result = await connection.query<{ state_id: number }>(
    sql,
    [versionStateId, ancestorStateId]
  );

  return result.map(r => r.state_id);
}

/**
 * Get the lineage name for a state.
 *
 * @param connection Database connection
 * @param stateId State ID
 * @returns Lineage name
 */
export async function getLineageName(
  connection: IDatabaseConnection,
  stateId: number
): Promise<number> {
  const sql = connection.driver === 'sqlserver'
    ? `SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0`
    : `SELECT lineage_name FROM sde.sde_states WHERE state_id = $1`;

  const result = await connection.query<{ lineage_name: number }>(sql, [stateId]);

  if (result.length === 0) {
    throw new Error(`State not found: ${stateId}`);
  }

  return result[0]!.lineage_name;
}

/**
 * Add state IDs to a lineage (used after reconcile to include parent's states).
 *
 * @param connection Database connection
 * @param lineageName Lineage name to update
 * @param stateIds State IDs to add
 */
export async function addStatesToLineage(
  connection: IDatabaseConnection,
  lineageName: number,
  stateIds: number[]
): Promise<void> {
  for (const stateId of stateIds) {
    // Check if already exists
    const checkSql = connection.driver === 'sqlserver'
      ? `SELECT 1 FROM sde.SDE_state_lineages WHERE lineage_name = @p0 AND lineage_id = @p1`
      : `SELECT 1 FROM sde.sde_state_lineages WHERE lineage_name = $1 AND lineage_id = $2`;

    const exists = await connection.query(checkSql, [lineageName, stateId]);

    if (exists.length === 0) {
      const insertSql = connection.driver === 'sqlserver'
        ? `INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id) VALUES (@p0, @p1)`
        : `INSERT INTO sde.sde_state_lineages (lineage_name, lineage_id) VALUES ($1, $2)`;

      await connection.execute(insertSql, [lineageName, stateId]);
    }
  }
}
