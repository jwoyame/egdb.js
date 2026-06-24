/**
 * Functions for posting changes from child to parent version
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';
import { buildIntegerList, validateNonNegativeInteger } from '../utils/sql-helpers';

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
 * Semantics (CONFIRMED 2026-06-15):
 *   "Reconciled" here means "parentStateId has been added to the child's
 *   closure under the child's lineage_name." This is the same closure-
 *   table lookup used by `getStatesInRange`, `getVersionStateLineage`, and
 *   `computeGraduablePrefix`. Returns true iff the row
 *   `(lineage_name = child.lineage_name, lineage_id = parentStateId)`
 *   exists in `SDE_state_lineages`. Reconcile (`reconcileVersion` →
 *   `addStatesToLineage`) is the only operation that writes this row.
 *
 * Mixed-writer caveat:
 *   If parent's tip has been advanced by an external tool (ArcGIS Pro,
 *   another egdb.js process) WITHOUT us reconciling, this returns false —
 *   which is correct: the child is no longer reconciled and posting would
 *   silently skip parent's intervening edits. Callers must re-reconcile
 *   when this returns false. `postVersion` in EnterpriseGeodatabase
 *   already enforces this by aborting with a clear error.
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
  const childStateList = buildIntegerList(childStateIds, 'postChangesToParent');
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
 * Count the A/D delta rows tagged with any of `stateIds`, across all versioned
 * tables. Used by the ArcMap-style post (which advances the parent pointer
 * instead of moving rows) to report changesPosted without mutating anything --
 * and so the caller can refuse to tear a version down on a 0-change post.
 */
export async function countChangesInStates(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  stateIds: number[]
): Promise<number> {
  if (stateIds.length === 0) return 0;
  const driver = connection.driver;
  const stateList = buildIntegerList(stateIds, 'countChangesInStates');
  const sidCol = driver === 'sqlserver' ? 'SDE_STATE_ID' : 'sde_state_id';
  let count = 0;
  for (const table of tables) {
    if (!table.isVersioned || !table.registrationId) continue;
    const qSchema = quoteId(driver, table.schema);
    for (const prefix of ['a', 'D']) {
      const t = `${qSchema}.${quoteId(driver, `${prefix}${table.registrationId}`)}`;
      const r = await connection.query<{ c: number | bigint }>(
        `SELECT COUNT(*) AS c FROM ${t} WHERE ${sidCol} IN (${stateList})`
      );
      count += Number(r[0]?.c ?? 0);
    }
  }
  return count;
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
 * Strategy (CONFIRMED 2026-06-15):
 *   1. Per-state lineage cleanup: `WHERE lineage_name = stateId` removes
 *      the deleted state's own closure tree. Matches the
 *      `deleteChildState` pattern in state-management.ts.
 *   2. Probe for cross-tree dangling references and emit telemetry. A
 *      sibling version that previously reconciled with the child (or
 *      indirectly inherited the child's state via DEFAULT) may still have
 *      a closure row `(lineage_name = sibling, lineage_id = stateId)`. We
 *      DO NOT delete those rows blindly — that would corrupt the
 *      sibling's closure if `stateId` was a real ancestor. Instead we
 *      surface the count via the returned `dangling` field so the caller
 *      can warn / log / surface in CompressResult. Callers must reconcile
 *      siblings BEFORE posting; this matches Pro's documented post
 *      precondition.
 *   3. Delete the SDE_states rows themselves.
 *
 * The dangling rows accumulate slowly (one per (sibling, post) pair) and
 * are cleaned up automatically when the sibling is itself deleted via
 * the same per-state pattern.
 *
 * @param connection Database connection
 * @param stateIds State IDs to delete
 * @returns Telemetry on cleanup work performed.
 */
export interface DeleteStatesResult {
  /** Number of states removed from SDE_states */
  statesRemoved: number;
  /** Number of `lineage_name = stateId` closure rows removed */
  ownClosureRowsRemoved: number;
  /** Number of closure rows in OTHER versions still pointing at these
   *  states as `lineage_id`. These rows become dangling references after
   *  the SDE_states rows are dropped. Operator should reconcile any
   *  affected sibling versions to clear them on the next compress. */
  danglingCrossTreeRows: number;
}

export async function deleteStates(
  connection: IDatabaseConnection,
  stateIds: number[]
): Promise<DeleteStatesResult> {
  if (stateIds.length === 0) {
    return { statesRemoved: 0, ownClosureRowsRemoved: 0, danglingCrossTreeRows: 0 };
  }

  const driver = connection.driver;
  const stateList = buildIntegerList(stateIds, 'deleteStates');

  // 1. Per-state lineage cleanup, scoped to each state's own closure tree.
  let ownClosureRowsRemoved = 0;
  for (const stateId of stateIds) {
    const deleteLineageSql = driver === 'sqlserver'
      ? `DELETE FROM sde.SDE_state_lineages WHERE lineage_name = @p0`
      : `DELETE FROM sde.sde_state_lineages WHERE lineage_name = $1`;
    const r = await connection.execute(deleteLineageSql, [stateId]);
    ownClosureRowsRemoved += r.rowsAffected;
  }

  // 2. Probe for cross-tree dangling references.
  const countDanglingSql = driver === 'sqlserver'
    ? `SELECT COUNT(*) AS cnt FROM sde.SDE_state_lineages WHERE lineage_id IN (${stateList})`
    : `SELECT COUNT(*) AS cnt FROM sde.sde_state_lineages WHERE lineage_id IN (${stateList})`;
  const danglingRows = await connection.query<{ cnt: number | bigint }>(countDanglingSql);
  const danglingCrossTreeRows = Number(danglingRows[0]?.cnt ?? 0);

  // 3. Delete the SDE_states rows themselves.
  const deleteStatesSql = driver === 'sqlserver'
    ? `DELETE FROM sde.SDE_states WHERE state_id IN (${stateList})`
    : `DELETE FROM sde.sde_states WHERE state_id IN (${stateList})`;
  const dr = await connection.execute(deleteStatesSql, []);

  return {
    statesRemoved: dr.rowsAffected,
    ownClosureRowsRemoved,
    danglingCrossTreeRows,
  };
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
  // The child tip itself (@p0 / $1) is UNIONed into the closure because
  // ArcGIS-Pro-authored states do NOT have self-rows in SDE_state_lineages
  // (empirically: 161/163 Putnam states had none). Without the UNION, the
  // child tip's own state_id is dropped from the result; postChangesToParent
  // then never rewrites SDE_STATE_ID for delta rows tagged with the child
  // tip, and those rows become unreachable orphans after deleteStates runs.
  // Symmetric to getStatesInRange / getVersionStateLineage / the closure
  // pattern in compress-impl.ts.
  const sql = connection.driver === 'sqlserver'
    ? `
      SELECT DISTINCT state_id FROM (
        SELECT lineage_id AS state_id
        FROM sde.SDE_state_lineages
        WHERE lineage_name = (SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p0)
        UNION
        SELECT @p0 AS state_id
      ) child_closure
      WHERE state_id NOT IN (
        SELECT lineage_id FROM sde.SDE_state_lineages
        WHERE lineage_name = (SELECT lineage_name FROM sde.SDE_states WHERE state_id = @p1)
        UNION
        SELECT @p1 AS lineage_id
      )
      ORDER BY state_id
    `
    : `
      SELECT DISTINCT state_id FROM (
        SELECT lineage_id AS state_id
        FROM sde.sde_state_lineages
        WHERE lineage_name = (SELECT lineage_name FROM sde.sde_states WHERE state_id = $1)
        UNION
        SELECT $1 AS state_id
      ) AS child_closure
      WHERE state_id NOT IN (
        SELECT lineage_id FROM sde.sde_state_lineages
        WHERE lineage_name = (SELECT lineage_name FROM sde.sde_states WHERE state_id = $2)
        UNION
        SELECT $2 AS lineage_id
      )
      ORDER BY state_id
    `;

  const result = await connection.query<{ state_id: number | bigint | string }>(sql, [childStateId, parentStateId]);
  // Coerce to Number: SQL Server returns the BIGINT state_id as a string (the
  // outer DISTINCT over a lineage_id/param UNION yields a bigint-typed column),
  // and postChangesToParent's buildIntegerList rejects string state ids. Other
  // state-id readers (getVersionStateLineage) already coerce. Validate so a
  // precision-lost id fails loudly rather than rewriting the wrong state's rows.
  return result.map(r => {
    const n = Number(r.state_id);
    validateNonNegativeInteger(n, 'getChildUniqueStates');
    return n;
  });
}
