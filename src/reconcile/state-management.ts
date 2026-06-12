/**
 * State management for EditSession isolation.
 *
 * Each EditSession creates a child state branching from the version's current
 * state. Compress respects state locks (SDE_state_locks) to avoid deleting
 * states that active sessions still reference.
 */

import type { IDatabaseConnection } from '../connections/connection';
import { buildIntegerList } from '../utils/sql-helpers';

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

  // `autolock` is a NOT NULL column in some SDE schema versions (no
  // default). Always emit 'N' (manual lock) so the INSERT works on
  // every variant we have seen.
  const sql =
    driver === 'sqlserver'
      ? `INSERT INTO sde.SDE_state_locks (sde_id, state_id, lock_type, autolock, lock_time)
         VALUES (@p0, @p1, 'E', 'N', GETDATE())`
      : `INSERT INTO sde.sde_state_locks (sde_id, state_id, lock_type, autolock, lock_time)
         VALUES ($1, $2, 'E', 'N', now())`;

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

export interface StaleLockCleanupResult {
  /** sde_ids found in SDE_state_locks but not in any live database session */
  staleSdeIds: number[];
  /** number of lock rows deleted */
  removedLocks: number;
}

export class InsufficientPrivilegeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientPrivilegeError';
  }
}

/**
 * Verify the connection can see all live database sessions.
 *
 * cleanupStaleLocks is dangerous without this: SQL Server's
 * sys.dm_exec_sessions returns ONLY the calling session unless the user has
 * VIEW SERVER STATE; PostgreSQL's pg_stat_activity hides other backends'
 * pids unless the user is a superuser or member of pg_read_all_stats /
 * pg_monitor. Without the right grants, every other live session's locks
 * would be misclassified as stale and reaped.
 */
async function assertCanSeeAllSessions(connection: IDatabaseConnection): Promise<void> {
  if (connection.driver === 'sqlserver') {
    const result = await connection.query<{ has_perm: number | null }>(
      `SELECT HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS has_perm`
    );
    if (result[0]?.has_perm !== 1) {
      throw new InsufficientPrivilegeError(
        'cleanupStaleLocks requires VIEW SERVER STATE on SQL Server. ' +
          'Without it, sys.dm_exec_sessions returns only the calling session, ' +
          'so every other live session would be misclassified as stale. ' +
          'Run: GRANT VIEW SERVER STATE TO [<your_login>]'
      );
    }
  } else {
    const result = await connection.query<{ has_perm: boolean }>(
      `SELECT (
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
        OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')
        OR pg_has_role(current_user, 'pg_monitor', 'MEMBER')
      ) AS has_perm`
    );
    if (result[0]?.has_perm !== true) {
      throw new InsufficientPrivilegeError(
        'cleanupStaleLocks requires permission to see all backends in pg_stat_activity. ' +
          'Without superuser or pg_read_all_stats / pg_monitor membership, other backends\' ' +
          'pids are hidden, so every other live session would be misclassified as stale. ' +
          'Run: GRANT pg_read_all_stats TO <your_role>'
      );
    }
  }
}

/**
 * Remove lock rows whose owning session no longer exists.
 *
 * SDE_state_locks rows leak when a process holding a lock dies before
 * EditSession.close() runs (e.g. crash, OOM, kill -9). The orphaned row
 * keeps compress away from a state that nothing else references, so
 * the state and its A/D entries linger forever. ArcGIS itself addresses
 * this with SDE_process_information heartbeats; we cross-check the
 * live session list instead, which works for the typical egdb.js
 * deployment shape (one Node process per connection).
 *
 * Liveness is judged against:
 *   SQL Server — sys.dm_exec_sessions.session_id (requires VIEW SERVER STATE)
 *   PostgreSQL — pg_stat_activity.pid       (requires pg_read_all_stats /
 *                                            pg_monitor / superuser)
 *
 * Without those grants this throws InsufficientPrivilegeError rather than
 * doing damage — see assertCanSeeAllSessions for why.
 *
 * Race protection: a database SPID/pid can be recycled to a brand-new
 * connection between when we read the lock list and when we run the DELETE.
 * If that new connection is itself starting an EditSession, it will INSERT a
 * fresh lock row under the recycled id. To avoid killing it, we capture a
 * timestamp at the start and constrain the DELETE to lock_time <= cutoff.
 *
 * This only removes lock rows. Any orphaned child states they were
 * protecting will still have their self-row in SDE_state_lineages, so
 * removeOrphanedStates won't collect them either; a deeper cleanup would
 * need to also drop those states' lineage and A/D rows. That's out of
 * scope here — this function fixes the lock-leak symptom that blocks
 * compress, not the full state-leak.
 *
 * Safe to call against an empty SDE_state_locks (returns 0).
 *
 * @throws InsufficientPrivilegeError if the connection lacks the grants
 *         required to see all live sessions
 */
export async function cleanupStaleLocks(
  connection: IDatabaseConnection
): Promise<StaleLockCleanupResult> {
  const driver = connection.driver;

  await assertCanSeeAllSessions(connection);

  // Capture a cutoff timestamp BEFORE reading locks. Any lock inserted
  // after this point — including locks under a recycled sde_id — must not
  // be deleted on this run.
  const cutoffResult = await connection.query<{ cutoff: Date }>(
    driver === 'sqlserver' ? `SELECT GETDATE() AS cutoff` : `SELECT now() AS cutoff`
  );
  const cutoff = cutoffResult[0]?.cutoff;
  if (cutoff === undefined) {
    throw new Error('Failed to read database server time for cleanupStaleLocks cutoff');
  }

  // Strict `<` (not `<=`) so locks inserted within the same database tick as
  // our cutoff are excluded. SQL Server GETDATE() has ~3.33ms resolution, so
  // a fresh insert can share a timestamp with our cutoff; with `<=` we'd
  // misclassify it.
  const lockSdeRows = await connection.query<{ sde_id: number }>(
    driver === 'sqlserver'
      ? `SELECT DISTINCT sde_id FROM sde.SDE_state_locks WHERE lock_time < @p0`
      : `SELECT DISTINCT sde_id FROM sde.sde_state_locks WHERE lock_time < $1`,
    [cutoff]
  );
  if (lockSdeRows.length === 0) {
    return { staleSdeIds: [], removedLocks: 0 };
  }

  const liveRows = await connection.query<{ sde_id: number }>(
    driver === 'sqlserver'
      ? `SELECT session_id AS sde_id FROM sys.dm_exec_sessions`
      : `SELECT pid AS sde_id FROM pg_stat_activity WHERE pid IS NOT NULL`
  );
  const liveSet = new Set(liveRows.map((r) => r.sde_id));

  const staleSdeIds = lockSdeRows
    .map((r) => r.sde_id)
    .filter((id) => !liveSet.has(id));

  if (staleSdeIds.length === 0) {
    return { staleSdeIds: [], removedLocks: 0 };
  }

  const idList = buildIntegerList(staleSdeIds, 'cleanupStaleLocks');

  // The lock_time predicate is critical for sde_id recycling: a brand-new
  // session that grabs the recycled id between our snapshot and this DELETE
  // will have lock_time >= cutoff and so survives.
  const result = await connection.execute(
    driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_state_locks WHERE sde_id IN (${idList}) AND lock_time < @p0`
      : `DELETE FROM sde.sde_state_locks WHERE sde_id IN (${idList}) AND lock_time < $1`,
    [cutoff]
  );

  return { staleSdeIds, removedLocks: result.rowsAffected };
}
