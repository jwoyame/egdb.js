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
 * Emit Esri-standard base-shadow delete markers for the rows a post superseded.
 *
 * egdb's edit-time delete markers use the EDIT state for SDE_STATE_ID, which its
 * own reader understands (it matches D rows by `SDE_STATE_ID IN lineage`). But
 * Esri's versioned views, the publish ETL, and ArcGIS hide a superseded BASE row
 * only when a `SDE_STATE_ID = 0` marker exists -- which egdb never writes. Result:
 * after a post, a retired/merged parcel's stale base row leaks to those readers.
 *
 * This additive step (run inside the post txn, after the parent pointer advanced)
 * inserts the standard `(OBJECTID, SDE_STATE_ID=0, DELETED_AT=<edit state>)` marker
 * for every OBJECTID this post introduced a NEW A-row for (state > sinceState in
 * the parent's new closure) that still has a base-table row and lacks the marker.
 * It changes no existing rows and is idempotent. SQL Server only (Putnam); the PG
 * ArcSDE evw shape is not validated here.
 *
 * @returns number of markers inserted
 */
export async function emitBaseShadowMarkers(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  tipState: number,
  sinceState: number
): Promise<number> {
  const driver = connection.driver;
  if (driver !== 'sqlserver') return 0;
  const tip = Number(tipState);
  const since = Number(sinceState);
  // The parent's (DEFAULT's) closure at its new tip, expressed as a subquery so
  // we never materialise a huge IN-list (Putnam runs 10k+ states pre-compress).
  const closure =
    `SELECT l.lineage_id FROM sde.SDE_states s ` +
    `INNER JOIN sde.SDE_state_lineages l ON l.lineage_name = s.lineage_name ` +
    `WHERE s.state_id = ${tip} AND l.lineage_id <= s.state_id`;
  let total = 0;
  for (const t of tables) {
    if (!t.isVersioned || !t.registrationId) continue;
    const schema = quoteId(driver, t.schema);
    const aTable = `${schema}.${quoteId(driver, `a${t.registrationId}`)}`;
    const dTable = `${schema}.${quoteId(driver, `D${t.registrationId}`)}`;
    // t.name is the 2-part table identifier (t.physicalName is the 3-part
    // DATABASE.SCHEMA.TABLE form and would build an invalid object name here).
    const base = `${schema}.${quoteId(driver, t.name)}`;
    // (1) Rows SUPERSEDED by a new A-row (update/split/retire): shadow the base
    // row so Esri hides it in favour of the new adds-row content.
    const sql =
      `INSERT INTO ${dTable} (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) ` +
      `SELECT m.OBJECTID, 0, m.ms FROM (` +
      `  SELECT a.OBJECTID, MAX(a.SDE_STATE_ID) AS ms FROM ${aTable} a ` +
      `  WHERE a.SDE_STATE_ID IN (${closure}) AND a.SDE_STATE_ID > ${since} ` +
      `  GROUP BY a.OBJECTID` +
      `) m ` +
      `WHERE EXISTS (SELECT 1 FROM ${base} b WHERE b.OBJECTID = m.OBJECTID) ` +
      `AND NOT EXISTS (SELECT 1 FROM ${dTable} d WHERE d.SDE_DELETES_ROW_ID = m.OBJECTID ` +
      `AND d.SDE_STATE_ID = 0 AND d.DELETED_AT IN (${closure}))`;
    const r = await connection.execute(sql);
    total += r.rowsAffected;

    // (2) Base rows HARD-DELETED by this post (a D marker in range but NO new
    // A-row): egdb writes the delete marker at the edit state, which Esri's
    // *_evw / the publish ETL ignore (they hide a base row only via a
    // SDE_STATE_ID = 0 marker). Without this, a hard-deleted base parcel leaks
    // to Esri readers -- the exact interop gap this function closes for updates.
    const delSql =
      `INSERT INTO ${dTable} (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) ` +
      `SELECT m.OBJECTID, 0, m.ms FROM (` +
      `  SELECT d.SDE_DELETES_ROW_ID AS OBJECTID, MAX(d.SDE_STATE_ID) AS ms FROM ${dTable} d ` +
      `  WHERE d.SDE_STATE_ID IN (${closure}) AND d.SDE_STATE_ID > ${since} ` +
      `  GROUP BY d.SDE_DELETES_ROW_ID` +
      `) m ` +
      `WHERE EXISTS (SELECT 1 FROM ${base} b WHERE b.OBJECTID = m.OBJECTID) ` +
      `AND NOT EXISTS (SELECT 1 FROM ${aTable} a WHERE a.OBJECTID = m.OBJECTID ` +
      `AND a.SDE_STATE_ID IN (${closure}) AND a.SDE_STATE_ID > ${since}) ` +
      `AND NOT EXISTS (SELECT 1 FROM ${dTable} d0 WHERE d0.SDE_DELETES_ROW_ID = m.OBJECTID ` +
      `AND d0.SDE_STATE_ID = 0 AND d0.DELETED_AT IN (${closure}))`;
    const rd = await connection.execute(delSql);
    total += rd.rowsAffected;
  }
  return total;
}

/**
 * Emit the Esri-standard adds-shadow delete markers a post needs.
 *
 * Esri's `*_evw` views, ArcGIS, and the publish ETL resolve the adds half of a
 * versioned table by returning EVERY a-row whose state is in the version's
 * closure, shadowed one-for-one: an a-row at state S is hidden only by a marker
 * whose `SDE_STATE_ID` is S itself (with `DELETED_AT` in the closure). They do
 * no newest-state resolution. egdb's own reader instead keeps the a-row at
 * MAX(state) per OBJECTID, so it needs no such marker and never wrote one.
 * Without it, an OBJECTID that already had an a-row in the parent's closure and
 * gets a fresh one from this post is returned TWICE by those readers -- once
 * with the current values and once with the superseded ones, which is how a
 * retired parcel keeps appearing on the published layer.
 *
 * This runs inside the post transaction, after the parent pointer advanced, and
 * inserts `(OBJECTID, SDE_STATE_ID = superseded a-state, DELETED_AT = the state
 * that superseded it)` so that at most the freshest a-row survives an Esri read.
 * It is additive, changes no existing row, and is idempotent. Scoped to the
 * OBJECTIDs this post touched (something above `sinceState`), so it never
 * back-fills markers for earlier posts. SQL Server only (Putnam); the PG ArcSDE
 * evw shape is not validated here.
 *
 * Counterpart of `emitBaseShadowMarkers`, which covers the base half, and must
 * run after it: the base-half markers carry `SDE_STATE_ID = 0` and so are
 * outside the `> sinceState` window the delete pass below looks at.
 *
 * This is additive only, so it cannot make the legacy repoint post
 * (`trimPost: false`) Esri-safe: that path moves the parent onto the version's
 * own states, which carries the version's edit-state markers into the parent's
 * closure, and an Esri reader takes one of those as hiding the very row it was
 * written with. Only `trimPost` keeps those markers out of the parent's closure.
 *
 * @returns number of markers inserted
 */
export async function emitAddsShadowMarkers(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  tipState: number,
  sinceState: number
): Promise<number> {
  const driver = connection.driver;
  if (driver !== 'sqlserver') return 0;
  const tip = Number(tipState);
  const since = Number(sinceState);
  // Both land inside SQL text, so reject anything that is not a state id.
  validateNonNegativeInteger(tip, 'emitAddsShadowMarkers.tipState');
  validateNonNegativeInteger(since, 'emitAddsShadowMarkers.sinceState');
  // The parent's closure at its new tip, as a subquery so a long ancestry is
  // never materialised as an IN-list.
  const closure =
    `SELECT l.lineage_id FROM sde.SDE_states s ` +
    `INNER JOIN sde.SDE_state_lineages l ON l.lineage_name = s.lineage_name ` +
    `WHERE s.state_id = ${tip} AND l.lineage_id <= s.state_id`;
  let total = 0;
  for (const t of tables) {
    if (!t.isVersioned || !t.registrationId) continue;
    const schema = quoteId(driver, t.schema);
    const aTable = `${schema}.${quoteId(driver, `a${t.registrationId}`)}`;
    const dTable = `${schema}.${quoteId(driver, `D${t.registrationId}`)}`;
    // Already carries a marker at its own state that this closure honours.
    const unshadowed =
      `NOT EXISTS (SELECT 1 FROM ${dTable} d WHERE d.SDE_DELETES_ROW_ID = a.OBJECTID ` +
      `AND d.SDE_STATE_ID = a.SDE_STATE_ID AND d.DELETED_AT IN (${closure}))`;

    // (1) Superseded by a fresher a-row (insert-over, update, split, retire):
    // hide every older a-row in the closure in favour of the freshest one.
    const sql =
      `INSERT INTO ${dTable} (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) ` +
      `SELECT a.OBJECTID, a.SDE_STATE_ID, m.ms FROM ${aTable} a ` +
      `INNER JOIN (` +
      `  SELECT a2.OBJECTID, MAX(a2.SDE_STATE_ID) AS ms FROM ${aTable} a2 ` +
      `  WHERE a2.SDE_STATE_ID IN (${closure}) GROUP BY a2.OBJECTID ` +
      `  HAVING MAX(a2.SDE_STATE_ID) > ${since}` +
      `) m ON m.OBJECTID = a.OBJECTID ` +
      `WHERE a.SDE_STATE_ID IN (${closure}) AND a.SDE_STATE_ID < m.ms ` +
      `AND ${unshadowed}`;
    const r = await connection.execute(sql);
    total += r.rowsAffected;

    // (2) Removed outright by this post: a delete marker above `sinceState` and
    // no fresher a-row, so every a-row below that delete must be hidden too.
    // Pass (1) has already marked the ones an update superseded, and the
    // unshadowed test skips them, so the two passes never write the same row.
    const delSql =
      `INSERT INTO ${dTable} (SDE_DELETES_ROW_ID, SDE_STATE_ID, DELETED_AT) ` +
      `SELECT a.OBJECTID, a.SDE_STATE_ID, m.ds FROM ${aTable} a ` +
      `INNER JOIN (` +
      `  SELECT d2.SDE_DELETES_ROW_ID AS OBJECTID, MAX(d2.SDE_STATE_ID) AS ds FROM ${dTable} d2 ` +
      `  WHERE d2.SDE_STATE_ID IN (${closure}) AND d2.SDE_STATE_ID > ${since} ` +
      `  GROUP BY d2.SDE_DELETES_ROW_ID` +
      `) m ON m.OBJECTID = a.OBJECTID ` +
      `WHERE a.SDE_STATE_ID IN (${closure}) AND a.SDE_STATE_ID < m.ds ` +
      `AND ${unshadowed}`;
    const rd = await connection.execute(delSql);
    total += rd.rowsAffected;
  }
  return total;
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
  newStateId: number,
  /**
   * Optimistic guard: when given, the update only applies while the version is
   * STILL on this state. Without it a save landing between "read the version's
   * state" and "repoint it" is silently orphaned -- the new state is never
   * carried forward and the pointer moves off it, losing the editor's work.
   * Any caller that computed a plan from a state it read earlier must pass it;
   * a 0-row result then means "someone else moved it", not "version missing".
   */
  expectedStateId?: number
): Promise<number> {
  const guarded = expectedStateId != null;
  const sql = connection.driver === 'sqlserver'
    ? `UPDATE sde.SDE_versions SET state_id = @p0 WHERE owner = @p1 AND name = @p2${guarded ? ' AND state_id = @p3' : ''}`
    : `UPDATE sde.sde_versions SET state_id = $1 WHERE owner = $2 AND name = $3${guarded ? ' AND state_id = $4' : ''}`;

  const params: unknown[] = [newStateId, versionOwner, versionName];
  if (guarded) params.push(expectedStateId);
  const r = await connection.execute(sql, params);
  return r.rowsAffected;
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
 * @deprecated CLOSURE-BASED AND UNRELIABLE. This reads SDE_state_lineages, which
 * is sparsely populated in real fabrics (see getStatesInRange in find-ancestor.ts):
 * it drops ArcMap-authored edit states and would report far too few "unique" states.
 * post.ts now counts changes over `getStatesInRange` (parent_state_id) instead, so
 * this is currently DEAD. Do NOT wire it into a new caller; use
 * `getStatesInRange(childState, findCommonAncestor(childState, parentState))`.
 * Retained only to avoid breaking the re-export in reconcile/index.ts.
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
