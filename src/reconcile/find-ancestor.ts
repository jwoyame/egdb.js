/**
 * Helper functions for finding common ancestors and state lineages
 */

import type { IDatabaseConnection } from '../connections/connection';
import { buildIntegerList, validateNonNegativeInteger } from '../utils/sql-helpers';

/** Coerce a DB state_id (SQL Server returns BIGINT as a string) to a checked integer. */
function toStateId(raw: number | bigint | string, context: string): number {
  const n = Number(raw);
  validateNonNegativeInteger(n, context); // throws if NaN / non-integer / precision-lost
  return n;
}

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
  // Sequential, NOT Promise.all: a single connection (e.g. inside a transaction,
  // as revertFeatures uses) cannot run two concurrent requests -- mssql throws
  // "request in progress". The two queries are cheap, so serial is fine.
  const childClosure = await getStatesInRange(connection, childStateId, 0);
  const parentClosure = await getStatesInRange(connection, parentStateId, 0);

  const parentSet = new Set(parentClosure);
  let ancestor = -1;
  for (const s of childClosure) {
    if (parentSet.has(s) && s > ancestor) ancestor = s;
  }

  if (ancestor < 0) {
    // No shared ancestor. Real-world cause: `childStateId` belongs to a version
    // created before a DEFAULT compress that trimmed the states they had in
    // common, orphaning the version's state tree. Consumers distinguish this
    // (recoverable, user-facing) case from an unexpected failure via `.code`.
    throw new NoCommonAncestorError(childStateId, parentStateId);
  }

  return ancestor;
}

/**
 * Thrown by {@link findCommonAncestor} when two states share no ancestor (e.g. a
 * version orphaned by a DEFAULT compress). Carries a stable `code` so callers can
 * branch on it without matching the message text.
 *
 * NOTE: the message wording is load-bearing for older consumers that still match
 * on it — do not reword it casually; prefer `err.code === 'NO_COMMON_ANCESTOR'`.
 */
export class NoCommonAncestorError extends Error {
  readonly code = 'NO_COMMON_ANCESTOR';
  constructor(childStateId: number, parentStateId: number) {
    super(`Could not find common ancestor between states ${childStateId} and ${parentStateId}`);
    this.name = 'NoCommonAncestorError';
  }
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
  // Ancestry is derived from the physical state tree (SDE_states.parent_state_id),
  // NOT from the SDE_state_lineages closure. The closure is a denormalized cache
  // that ArcMap/ArcSDE populates sparsely: in a real fabric the vast majority of
  // edit states have NO row in it (verified on Putnam — atom_0329cloud's closure
  // listed 6 states while its parent chain is 148, missing every one of its ~59
  // edit states). Reading the closure therefore dropped ArcMap-authored edits and
  // made Reconcile & Post / conflict detection see "no changes". The parent chain
  // is the complete, authoritative ancestry and is exactly what ArcMap walks, so
  // we walk it here (a recursive CTE up parent_state_id to the root).
  //
  // Contract unchanged: return the ancestors of `versionStateId` that are strictly
  // greater than `ancestorStateId` (i.e. the states in the half-open range
  // (ancestorStateId, versionStateId]). Robustness/perf notes:
  //   * The recursion stops once a parent is <= `ancestorStateId` (`> @p1`), not
  //     just at the root. Because parent_state_id is always < its child, every
  //     ancestor at or below the bound is out of range anyway, so this prunes the
  //     walk to the requested window instead of always descending to state 0. It
  //     also guarantees state 0 (the base) is never emitted — callers treat base
  //     separately — for every non-negative `ancestorStateId` (all callers pass 0
  //     or a real state id).
  //   * SQL Server: MAXRECURSION 0 (unlimited) — a chain can exceed the 32767
  //     default on an un-compressed fabric, and capping would make reconcile/post
  //     THROW there. Termination rests on the strictly-decreasing parent_state_id
  //     invariant, which also makes cycles impossible in valid SDE data.
  //   * Postgres: UNION (not UNION ALL) so an accidental cycle from corrupt data
  //     terminates instead of looping (PG has no MAXRECURSION analogue). For a
  //     valid tree each state appears once, so UNION and UNION ALL are equivalent.
  //     SQL Server can't mirror this — its recursive CTE REQUIRES UNION ALL — so a
  //     corrupt cycle there loops only until the request timeout (bounded, not
  //     infinite). Both are non-issues for valid data (the invariant forbids cycles).
  const sql = connection.driver === 'sqlserver'
    ? `
      WITH anc AS (
        SELECT state_id, parent_state_id
        FROM sde.SDE_states WHERE state_id = @p0
        UNION ALL
        SELECT s.state_id, s.parent_state_id
        FROM sde.SDE_states s
        JOIN anc ON s.state_id = anc.parent_state_id
        WHERE anc.parent_state_id > @p1
      )
      SELECT state_id FROM anc
      WHERE state_id > @p1
      ORDER BY state_id
      OPTION (MAXRECURSION 0)
    `
    : `
      WITH RECURSIVE anc AS (
        SELECT state_id, parent_state_id
        FROM sde.sde_states WHERE state_id = $1
        UNION
        SELECT s.state_id, s.parent_state_id
        FROM sde.sde_states s
        JOIN anc ON s.state_id = anc.parent_state_id
        WHERE anc.parent_state_id > $2
      )
      SELECT state_id FROM anc
      WHERE state_id > $2
      ORDER BY state_id
    `;

  const result = await connection.query<{ state_id: number | bigint | string }>(
    sql,
    [versionStateId, ancestorStateId]
  );

  // Coerce: SQL Server can return BIGINT state_id as a string. Downstream
  // consumers (post's buildIntegerList, numeric comparisons, and the in-place
  // delete in revertFeatures) need real, checked integers.
  return result.map(r => toStateId(r.state_id, 'getStatesInRange'));
}

/**
 * Find which of `states` are NOT exclusive to the version (owner.name) -- i.e.
 * referenced by another version's lineage, or having a forked child that is not
 * part of this version's own edit chain. Editing those states in place would
 * corrupt the other version, so a caller (revertFeatures) must refuse.
 *
 * `states` is the version's child-only state set (its own edits since it
 * diverged from its parent). Three signals that a state is external:
 *   (a) another version's lineage closure (SDE_state_lineages) includes it;
 *   (b) another version's tip equals it (SDE_versions, reliable); or
 *   (c) some state forks off it that is NOT itself one of these child-only
 *       states (SDE_states.parent_state_id, reliable).
 * Branches off the COMMON ANCESTOR (e.g. other versions off DEFAULT) are fine
 * and are not flagged, because their fork point is below `states`.
 *
 * IMPORTANT: signal (a) is now UNRELIABLE and effectively dead weight. Since
 * SDE_state_lineages is sparsely populated in real fabrics (see getStatesInRange),
 * the closure rarely lists a sibling's non-tip states. Revert safety therefore
 * rests entirely on (b) [tip match] + (c) [fork in SDE_states] -- both of which
 * read authoritative tables and DO cover the real cases: a sibling either points
 * its tip at a shared state (b) or forks a child off one (c). Do NOT "simplify"
 * revert by leaning on the closure branch; keep (b)+(c). (a) is retained only as
 * a belt-and-suspenders no-op for the rare deployments whose closure IS complete.
 */
export async function findExternallyReferencedStates(
  connection: IDatabaseConnection,
  owner: string,
  name: string,
  states: number[],
): Promise<number[]> {
  if (states.length === 0) return [];
  // buildIntegerList validates every element is a finite integer before inlining
  // (these feed an IN clause used to choose which delta rows revertFeatures may
  // delete -- a non-integer must fail loudly, never silently mis-query).
  const inStates = buildIntegerList(states, 'findExternallyReferencedStates');
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
