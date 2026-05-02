/**
 * State management for EditSession isolation.
 *
 * Each EditSession creates a child state branching from the version's current
 * state. Compress respects state locks (SDE_state_locks) to avoid deleting
 * states that active sessions still reference.
 */

import type { IDatabaseConnection } from '../connections/connection';

/**
 * Create a child state branching from parentStateId.
 *
 * The caller MUST hold an open transaction. The three writes (allocate id,
 * insert state row, copy lineage) must commit or roll back together — without
 * a transaction, a partial failure leaves the state generator advanced and
 * the lineage table inconsistent.
 *
 * @returns the new state_id
 */
export async function createChildState(
  connection: IDatabaseConnection,
  parentStateId: number
): Promise<number> {
  if (!connection.inTransaction()) {
    throw new Error('createChildState must be called inside a transaction');
  }

  const driver = connection.driver;

  const nextIdSql =
    driver === 'sqlserver'
      ? `UPDATE sde.SDE_state_id_generator SET id_value = id_value + 1 OUTPUT DELETED.id_value`
      : `UPDATE sde.sde_state_id_generator SET id_value = id_value + 1 RETURNING id_value - 1 AS new_id`;

  const idResult = await connection.query<{ id_value?: number; new_id?: number }>(nextIdSql);
  const newStateId = idResult[0]?.id_value ?? idResult[0]?.new_id;
  if (newStateId === undefined) {
    throw new Error('Failed to allocate state ID from SDE_state_id_generator');
  }

  const insertStateSql =
    driver === 'sqlserver'
      ? `INSERT INTO sde.SDE_states (state_id, owner, creation_time, lineage_name, parent_state_id)
         VALUES (@p0, SYSTEM_USER, GETDATE(), @p0, @p1)`
      : `INSERT INTO sde.sde_states (state_id, owner, creation_time, lineage_name, parent_state_id)
         VALUES ($1, current_user, now(), $1, $2)`;
  await connection.execute(insertStateSql, [newStateId, parentStateId]);

  const copyLineageSql =
    driver === 'sqlserver'
      ? `INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id)
         SELECT @p0, lineage_id FROM sde.SDE_state_lineages
         WHERE lineage_name = (SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p1)
         UNION ALL
         SELECT @p0, @p0`
      : `INSERT INTO sde.sde_state_lineages (lineage_name, lineage_id)
         SELECT $1, lineage_id FROM sde.sde_state_lineages
         WHERE lineage_name = (SELECT lineage_name FROM sde.sde_states WHERE state_id = $2)
         UNION ALL
         SELECT $1, $1`;
  await connection.execute(copyLineageSql, [newStateId, parentStateId]);

  return newStateId;
}

/**
 * Delete a child state and its A/D table entries.
 *
 * Order matters: SDE_state_locks rows referencing the state must be removed
 * before the state row itself, because the schema typically has a foreign
 * key from SDE_state_locks.state_id to SDE_states.state_id.
 */
export async function deleteChildState(
  connection: IDatabaseConnection,
  stateId: number,
  registeredTables: Array<{ schema: string; registrationId: number }>
): Promise<void> {
  const driver = connection.driver;
  const quoteId = (name: string): string => (driver === 'sqlserver' ? `[${name}]` : `"${name}"`);

  for (const table of registeredTables) {
    const qSchema = quoteId(table.schema);
    const aTable = `${qSchema}.${quoteId(`a${table.registrationId}`)}`;
    const dTable = `${qSchema}.${quoteId(`D${table.registrationId}`)}`;

    await connection.execute(
      driver === 'sqlserver'
        ? `DELETE FROM ${aTable} WHERE SDE_STATE_ID = @p0`
        : `DELETE FROM ${aTable} WHERE sde_state_id = $1`,
      [stateId]
    );
    await connection.execute(
      driver === 'sqlserver'
        ? `DELETE FROM ${dTable} WHERE SDE_STATE_ID = @p0`
        : `DELETE FROM ${dTable} WHERE sde_state_id = $1`,
      [stateId]
    );
  }

  // Locks first (FK from SDE_state_locks.state_id -> SDE_states.state_id)
  await connection.execute(
    driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_state_locks WHERE state_id = @p0`
      : `DELETE FROM sde.sde_state_locks WHERE state_id = $1`,
    [stateId]
  );

  await connection.execute(
    driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_state_lineages WHERE lineage_name = @p0`
      : `DELETE FROM sde.sde_state_lineages WHERE lineage_name = $1`,
    [stateId]
  );

  await connection.execute(
    driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_states WHERE state_id = @p0`
      : `DELETE FROM sde.sde_states WHERE state_id = $1`,
    [stateId]
  );
}

/**
 * Acquire an exclusive lock on a state via SDE_state_locks.
 *
 * @returns the sde_id used for the lock — pass it to releaseStateLock to free
 */
export async function acquireStateLock(
  connection: IDatabaseConnection,
  stateId: number
): Promise<number> {
  const driver = connection.driver;
  const sdeId = await getConnectionSdeId(connection);

  const sql =
    driver === 'sqlserver'
      ? `INSERT INTO sde.SDE_state_locks (sde_id, state_id, lock_type, lock_time)
         VALUES (@p0, @p1, 'E', GETDATE())`
      : `INSERT INTO sde.sde_state_locks (sde_id, state_id, lock_type, lock_time)
         VALUES ($1, $2, 'E', now())`;

  await connection.execute(sql, [sdeId, stateId]);
  return sdeId;
}

export async function releaseStateLock(
  connection: IDatabaseConnection,
  stateId: number,
  sdeId: number
): Promise<void> {
  const sql =
    connection.driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_state_locks WHERE sde_id = @p0 AND state_id = @p1`
      : `DELETE FROM sde.sde_state_locks WHERE sde_id = $1 AND state_id = $2`;
  await connection.execute(sql, [sdeId, stateId]);
}

/**
 * Get the SDE connection id used as sde_id in the lock tables.
 *
 * Uses @@SPID (SQL Server) / pg_backend_pid() (PostgreSQL). The SDE_state_locks
 * unique key is (sde_id, state_id), so two sessions sharing a connection can
 * still lock different states. They cannot both lock the same state — but
 * that would also be a programming bug, since EditSession.start creates a
 * fresh state per session.
 */
async function getConnectionSdeId(connection: IDatabaseConnection): Promise<number> {
  const sql =
    connection.driver === 'sqlserver'
      ? `SELECT @@SPID AS sde_id`
      : `SELECT pg_backend_pid() AS sde_id`;
  const result = await connection.query<{ sde_id: number }>(sql);
  const sdeId = result[0]?.sde_id;
  if (sdeId === undefined || sdeId === null || sdeId <= 0) {
    throw new Error(
      `Failed to obtain connection SDE id (got ${sdeId}). ` +
        `SDE_state_locks requires a positive sde_id; refusing to use 0 fallback.`
    );
  }
  return sdeId;
}

/**
 * Get the set of state ids currently locked.
 * Used by compress to avoid deleting locked states.
 */
export async function getLockedStateIds(connection: IDatabaseConnection): Promise<Set<number>> {
  const sql =
    connection.driver === 'sqlserver'
      ? `SELECT DISTINCT state_id FROM sde.SDE_state_locks`
      : `SELECT DISTINCT state_id FROM sde.sde_state_locks`;
  const result = await connection.query<{ state_id: number }>(sql);
  return new Set(result.map((r) => r.state_id));
}
