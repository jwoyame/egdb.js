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
  // The common ancestor is the deepest state that is an ancestor of BOTH.
  // Compute each state's bounded, tip-inclusive ancestor closure (the same
  // primitive getStatesInRange/getVersionStateLineage use), intersect, take
  // the max.
  //
  // The previous implementation took MAX(lineage_id) over states sharing the
  // child's lineage_name that were also in the parent's lineage_name set. But
  // `lineage_name` identifies a whole lineage TREE, not an ancestry path, and a
  // version's edit states share DEFAULT's lineage_name (correct ArcSDE
  // behaviour). So when the parent hadn't branched away (the normal case —
  // e.g. DEFAULT at 25066, an un-reconciled version's tip at 25070, all on
  // lineage_name 24542), the "intersection" was the whole chain and MAX
  // returned the child's own tip. That made childOnlyStates empty, so
  // Reconcile & Post and conflict detection saw zero changes. Bounding each
  // closure by its own state_id (via getStatesInRange) fixes it for both the
  // same-lineage and branched-lineage cases.
  const [childClosure, parentClosure] = await Promise.all([
    getStatesInRange(connection, childStateId, 0),
    getStatesInRange(connection, parentStateId, 0),
  ]);

  const parentSet = new Set(parentClosure);
  let ancestor = -1;
  for (const s of childClosure) {
    if (parentSet.has(s) && s > ancestor) ancestor = s;
  }

  if (ancestor < 0) {
    throw new Error(
      `Could not find common ancestor between states ${childStateId} and ${parentStateId}`
    );
  }

  return ancestor;
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
  // The tip itself (versionStateId) must be UNIONed in: ArcGIS-authored
  // states don't have self-rows in SDE_state_lineages, so the tip's own
  // A/D rows would be missed by the closure-table-only query. Verified
  // empirically against Putnam parcel_fabric_test where 161/163 states
  // had no self-row. See SDE_COMPRESS_SPEC.md Section 4.1.
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT lineage_id as state_id
      FROM sde.SDE_state_lineages
      WHERE lineage_name = (
        SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0
      )
      AND lineage_id > @p1
      AND lineage_id <= @p0
      UNION
      SELECT @p0 AS state_id WHERE @p0 > @p1
      ORDER BY state_id
    `
    : `
      SELECT lineage_id as state_id
      FROM sde.sde_state_lineages
      WHERE lineage_name = (
        SELECT lineage_name FROM sde.sde_states WHERE state_id = $1
      )
      AND lineage_id > $2
      AND lineage_id <= $1
      UNION
      SELECT $1 AS state_id WHERE $1 > $2
      ORDER BY state_id
    `;

  const result = await connection.query<{ state_id: number }>(
    sql,
    [versionStateId, ancestorStateId]
  );

  return result.map(r => r.state_id);
}

/**
 * Find which of `states` are NOT exclusive to the version (owner.name) -- i.e.
 * referenced by another version's lineage, or having a forked child that is not
 * part of this version's own edit chain. Editing those states in place would
 * corrupt the other version, so a caller (revertFeatures) must refuse.
 *
 * `states` is the version's child-only state set (its own edits since it
 * diverged from its parent). Two ways a state can be external:
 *   (a) another version's tip equals it, or its closure includes it; or
 *   (b) some state forks off it that is NOT itself one of these child-only
 *       states (a branch into another version / an orphan).
 * Branches off the COMMON ANCESTOR (e.g. other versions off DEFAULT) are fine
 * and are not flagged, because their fork point is below `states`.
 */
export async function findExternallyReferencedStates(
  connection: IDatabaseConnection,
  owner: string,
  name: string,
  states: number[],
): Promise<number[]> {
  if (states.length === 0) return [];
  const inStates = states.join(',');
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT DISTINCT sl.lineage_id AS state
      FROM sde.SDE_versions v
      JOIN sde.SDE_states vs ON vs.state_id = v.state_id
      JOIN sde.SDE_state_lineages sl
        ON sl.lineage_name = vs.lineage_name AND sl.lineage_id <= v.state_id
      WHERE NOT (LOWER(v.owner) = LOWER(@p0) AND LOWER(v.name) = LOWER(@p1))
        AND sl.lineage_id IN (${inStates})
      UNION
      SELECT v.state_id AS state
      FROM sde.SDE_versions v
      WHERE NOT (LOWER(v.owner) = LOWER(@p0) AND LOWER(v.name) = LOWER(@p1))
        AND v.state_id IN (${inStates})
      UNION
      SELECT s.parent_state_id AS state
      FROM sde.SDE_states s
      WHERE s.parent_state_id IN (${inStates})
        AND s.state_id NOT IN (${inStates})
    `
    : `
      SELECT DISTINCT sl.lineage_id AS state
      FROM sde.sde_versions v
      JOIN sde.sde_states vs ON vs.state_id = v.state_id
      JOIN sde.sde_state_lineages sl
        ON sl.lineage_name = vs.lineage_name AND sl.lineage_id <= v.state_id
      WHERE NOT (LOWER(v.owner) = LOWER($1) AND LOWER(v.name) = LOWER($2))
        AND sl.lineage_id IN (${inStates})
      UNION
      SELECT v.state_id AS state
      FROM sde.sde_versions v
      WHERE NOT (LOWER(v.owner) = LOWER($1) AND LOWER(v.name) = LOWER($2))
        AND v.state_id IN (${inStates})
      UNION
      SELECT s.parent_state_id AS state
      FROM sde.sde_states s
      WHERE s.parent_state_id IN (${inStates})
        AND s.state_id NOT IN (${inStates})
    `;
  const rows = await connection.query<{ state: number | bigint }>(sql, [owner, name]);
  return [...new Set(rows.map(r => Number(r.state)))];
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
  // Race semantics by driver:
  //   PostgreSQL — ON CONFLICT DO NOTHING is atomic at the row level, so
  //     two concurrent reconciles inserting the same (lineage_name,
  //     state_id) pair both succeed without error.
  //   SQL Server — `INSERT ... SELECT ... WHERE NOT EXISTS (...)` is NOT
  //     atomic under READ COMMITTED (the default). Two concurrent
  //     statements can both pass the NOT EXISTS check and then race in the
  //     INSERT; the loser raises a PK-violation error. We swallow that
  //     specific error (2627 / 2601) as "another reconcile already inserted
  //     it" — the desired post-condition holds either way. Callers who
  //     want strict isolation should wrap reconcile in SERIALIZABLE.
  for (const stateId of stateIds) {
    if (connection.driver === 'sqlserver') {
      const insertSql = `
        INSERT INTO sde.SDE_state_lineages (lineage_name, lineage_id)
        SELECT @p0, @p1
        WHERE NOT EXISTS (
          SELECT 1 FROM sde.SDE_state_lineages
          WHERE lineage_name = @p0 AND lineage_id = @p1
        )
      `;
      try {
        await connection.execute(insertSql, [lineageName, stateId]);
      } catch (e: unknown) {
        // mssql wraps the SQL Server error in RequestError; the original
        // PK-violation number lives on `number` or in `originalError`. Use
        // ONLY the numeric error codes — message text is locale-dependent
        // and a regex over the English wording would let a legitimate race
        // re-throw as a fatal error on a localized SQL Server.
        const err = e as { number?: number; originalError?: { number?: number } };
        const num = err?.number ?? err?.originalError?.number;
        const isPkViolation = num === 2627 || num === 2601;
        if (!isPkViolation) throw e;
        // Race lost to a concurrent reconcile inserting the same row.
        // Desired state is already present; continue.
      }
    } else {
      const insertSql = `
        INSERT INTO sde.sde_state_lineages (lineage_name, lineage_id)
        VALUES ($1, $2)
        ON CONFLICT (lineage_name, lineage_id) DO NOTHING
      `;
      await connection.execute(insertSql, [lineageName, stateId]);
    }
  }
}
