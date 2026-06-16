/**
 * SDE Compress — implementation of the three phases defined in Esri's docs:
 *
 *   Phase 1: prune unreferenced states           → `pruneStates`
 *   Phase 2: collapse candidate lineages         → `collapseLineages`
 *   Phase 3: graduate delta rows to base         → `graduateTable`
 *
 * This module runs them in order 3 → 1 → 2 (graduate-then-prune is
 * monotonic-safe: nothing graduated can be lost to a later prune). Per-
 * table transactions are the documented atomicity unit; partial completion
 * across tables is normal and surfaced in `CompressResult`.
 *
 * See docs/SDE_COMPRESS_SPEC.md for the full specification.
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';
import { buildIntegerList } from '../utils/sql-helpers';

type Driver = 'sqlserver' | 'postgresql';

function qid(driver: Driver, name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * SDE system-table identifier resolver. SQL Server uses PascalCase
 * (`sde.SDE_states`); PostgreSQL lowercases (`sde.sde_states`).
 */
function sysTable(driver: Driver, name: 'SDE_states' | 'SDE_state_lineages' | 'SDE_versions' | 'SDE_state_locks' | 'SDE_mvtables_modified'): string {
  return driver === 'sqlserver' ? `sde.${name}` : `sde.${name.toLowerCase()}`;
}

/**
 * SDE delta-table column resolver. SQL Server uses uppercase OBJECTID /
 * SDE_STATE_ID / SDE_DELETES_ROW_ID / DELETED_AT; PostgreSQL lowercases.
 */
function col(driver: Driver, name: 'OBJECTID' | 'SDE_STATE_ID' | 'SDE_DELETES_ROW_ID' | 'DELETED_AT' | 'state_id' | 'parent_state_id' | 'lineage_id' | 'lineage_name'): string {
  if (driver === 'sqlserver') return name;
  return name.toLowerCase();
}

function paramRef(driver: Driver, index: number): string {
  return driver === 'sqlserver' ? `@p${index}` : `$${index + 1}`;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

export class InconsistentLineageError extends Error {
  constructor(public readonly missingStates: number[]) {
    super(`SDE_state_lineages is missing self-rows for states: ${missingStates.slice(0, 10).join(', ')}${missingStates.length > 10 ? ` (...and ${missingStates.length - 10} more)` : ''}`);
    this.name = 'InconsistentLineageError';
  }
}

/**
 * Diagnostic: count states that are missing a self-row in
 * SDE_state_lineages. ArcGIS-authored states do NOT have self-rows, and
 * neither do egdb.js states now that createChildState uses SDE_state_new_edit
 * (the child shares the parent's lineage_name). The closure-based queries in
 * this module compensate by UNIONing each tip's own state_id into the
 * effective closure, so this is informational, not fatal.
 *
 * The original spec (SDE_COMPRESS_SPEC.md Section 3.1) called the self-row
 * pattern an invariant and recommended aborting compress if any state
 * lacked one. Empirical verification against Putnam parcel_fabric_test
 * (10.5.1, 161/163 states had no self-row) showed that's not how SDE
 * actually behaves. Use this function for telemetry only.
 */
export async function countMissingSelfRows(connection: IDatabaseConnection): Promise<number> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  const sql = `
    SELECT COUNT(*) AS cnt
    FROM ${states} s
    WHERE NOT EXISTS (
      SELECT 1 FROM ${lineages}
      WHERE ${lid} = s.${sid} AND ${lname} = s.${sid}
    )
  `;
  const rows = await connection.query<{ cnt: number | bigint }>(sql);
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * @deprecated The self-row "invariant" is not real for SDE. Kept for
 * backwards compatibility; callers should switch to `countMissingSelfRows`
 * for telemetry. This function is now a no-op.
 */
export async function assertSelfRowInvariant(_connection: IDatabaseConnection): Promise<void> {
  // Intentionally no-op. See countMissingSelfRows() and the comment above.
}

// ---------------------------------------------------------------------------
// Lock and lineage discovery
// ---------------------------------------------------------------------------

/**
 * Detect whether `sde.SDE_mvtables_modified` exists in the database. The
 * table is conventionally present on SDE schemas but not strictly required.
 * We check ONCE at the start of each phase and gate writes on the result,
 * because on PostgreSQL a transaction that hits a missing-table error
 * enters the `25P02 in_failed_sql_transaction` state and every subsequent
 * statement in the same transaction is silently rejected — destroying the
 * rest of the prune/collapse work. The previous try/catch around the
 * mvtables DELETE was incorrect on PG.
 */
export async function hasMvtablesModified(connection: IDatabaseConnection): Promise<boolean> {
  const driver = connection.driver;
  const sql = driver === 'sqlserver'
    ? `SELECT 1 FROM sys.tables t INNER JOIN sys.schemas s ON s.schema_id = t.schema_id WHERE s.name = 'sde' AND t.name = 'SDE_mvtables_modified'`
    : `SELECT 1 FROM information_schema.tables WHERE table_schema = 'sde' AND table_name = 'sde_mvtables_modified'`;
  const rows = await connection.query(sql);
  return rows.length > 0;
}

/**
 * Returns the set of state_ids that compress must NOT touch because a live
 * EditSession has them locked. The set is expanded with all ancestors (so
 * the locked state's reads through the lineage are preserved) and all
 * descendants (so unsaved A/D rows under the lock are preserved).
 *
 * See spec Section 16 step 1: "An implementer who reads 'SELECT state_id
 * FROM SDE_state_locks' literally would prune in-flight child states
 * (destroying unsaved A/D rows) or ancestor states (corrupting versioned-
 * view reads through the locked state when DEFAULT has moved)."
 */
export async function readLockedBranches(connection: IDatabaseConnection): Promise<Set<number>> {
  const driver = connection.driver;
  const locks = sysTable(driver, 'SDE_state_locks');
  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  // Three branches to UNION:
  //   1. The locked states themselves.
  //   2. Ancestors of locked states. For each lock L, look up L's
  //      lineage_name from SDE_states, then take the closure rows with
  //      lineage_id <= L.state_id under that lineage_name. (Within a
  //      lineage_name, state_id IS lineage order from root to tip; the
  //      global "state_id is allocation order" caveat only applies across
  //      different lineage_names — see SDE_COMPRESS_SPEC.md Section 4.)
  //   3. Descendants of locked states. For each lock L, find SDE_states
  //      rows S where S.lineage_name has L as a closure member (i.e., a
  //      lineage_name+L pair exists in SDE_state_lineages) AND L.state_id
  //      <= S.state_id.
  //
  // The original implementation read `lineage_name` as if it were a
  // state_id and produced garbage when locks were present. Verified
  // against Putnam parcel_fabric_test where lineage_name is a separate
  // tree identifier (e.g., state 25066 has lineage_name 24542).
  const sql = `
    SELECT ${sid} AS state_id FROM ${locks}
    UNION
    SELECT sl.${lid} AS state_id
    FROM ${locks} lk
    JOIN ${states} sLock ON sLock.${sid} = lk.${sid}
    JOIN ${lineages} sl ON sl.${lname} = sLock.${lname} AND sl.${lid} <= lk.${sid}
    UNION
    SELECT sDesc.${sid} AS state_id
    FROM ${locks} lk
    JOIN ${lineages} sl ON sl.${lid} = lk.${sid}
    JOIN ${states} sDesc ON sDesc.${lname} = sl.${lname} AND sDesc.${sid} >= lk.${sid}
  `;
  const rows = await connection.query<{ state_id: number | bigint }>(sql);
  return new Set(rows.map(r => Number(r.state_id)));
}

/**
 * Compute the graduable prefix: states that appear in EVERY surviving
 * version's lineage closure. Per spec Section 3.3, a delta row is graduable
 * iff its SDE_STATE_ID is in this set.
 *
 * Algorithm: for each tip T, the closure is `SDE_state_lineages WHERE
 * lineage_name = T` (which includes T itself via the self-row invariant).
 * A state S is graduable iff its lineage_id appears for every distinct
 * lineage_name in (SELECT state_id FROM SDE_versions).
 */
export async function computeGraduablePrefix(connection: IDatabaseConnection): Promise<Set<number>> {
  const driver = connection.driver;
  const versions = sysTable(driver, 'SDE_versions');
  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  // Distinct version tips (collapsing multi-version-points-at-same-state).
  const versionCountRow = await connection.query<{ cnt: number | bigint }>(
    `SELECT COUNT(DISTINCT ${sid}) AS cnt FROM ${versions} WHERE ${sid} IS NOT NULL`
  );
  const versionCount = Number(versionCountRow[0]?.cnt ?? 0);
  if (versionCount === 0) return new Set();

  // A state's effective closure follows the pattern in find-ancestor.ts:
  //   - Look up the tip's lineage_name from SDE_states (NOT the tip's state_id)
  //   - Join SDE_state_lineages with that lineage_name
  //   - Filter lineage_id <= tip.state_id (within a lineage_name, state_id IS
  //     monotonic from root to tip; the global state_id ordering pitfall only
  //     applies ACROSS different lineage_names)
  //   - UNION the tip itself (SDE does not write self-rows uniformly)
  // Graduable iff state appears in EVERY tip's effective closure.
  const sql = `
    SELECT state_id FROM (
      SELECT s.${sid} AS tip, sl.${lid} AS state_id
      FROM ${versions} v
      JOIN ${states} s ON s.${sid} = v.${sid}
      JOIN ${lineages} sl ON sl.${lname} = s.${lname} AND sl.${lid} <= v.${sid}
      WHERE v.${sid} IS NOT NULL
      UNION
      SELECT ${sid} AS tip, ${sid} AS state_id
      FROM ${versions}
      WHERE ${sid} IS NOT NULL
    ) ${driver === 'sqlserver' ? 'closures' : 'AS closures'}
    GROUP BY state_id
    HAVING COUNT(DISTINCT tip) = ${versionCount}
  `;
  const rows = await connection.query<{ state_id: number | bigint }>(sql);
  return new Set(rows.map(r => Number(r.state_id)));
}

/**
 * Per spec Section 16 step 3: the in-transaction revalidation. The snapshot
 * prefix is still safe iff every state in it is still in the recomputed
 * prefix (snapshot ⊆ recomputed). A post that extends a tip downstream is
 * the common case and produces a SUPERSET, not invalidating. Only a new-
 * version creation can shrink the intersection.
 */
export function isSubsetOf(snapshot: Set<number>, recomputed: Set<number>): boolean {
  for (const s of snapshot) {
    if (!recomputed.has(s)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Graduate delta rows to base
// ---------------------------------------------------------------------------

export interface GraduateTableResult {
  table: string;
  status: 'graduated' | 'skipped-version-set-changed' | 'no-graduable-rows';
  upserts: number;
  deletes: number;
  /** Rows removed from the A-table */
  aRowsRemoved: number;
  /** Rows removed from the D-table */
  dRowsRemoved: number;
  /** Warnings produced (e.g. Pro-authored DELETED_AT outside prefix). */
  warnings: string[];
}

interface DeltaRow {
  state_id: number;
  oid: number;
  isDelete: boolean;
}

/**
 * Graduate one registered table's delta rows into its base table.
 *
 * Must be called inside a transaction at SERIALIZABLE or REPEATABLE READ.
 * The first step is an in-fence subset revalidation of the graduable
 * snapshot; if the version set changed since the snapshot, the table is
 * skipped with `status: 'skipped-version-set-changed'`.
 *
 * Tie-breaking rules for an OID with both A and D rows in the graduable
 * prefix:
 *  - A and D at the same SDE_STATE_ID → UPSERT-A (the pair is an UPDATE)
 *  - D's state is a descendant of A's state → DELETE (D supersedes A)
 *  - A's state is a descendant of or equal to D's state → UPSERT-A
 *  - only A → UPSERT-A; only D → DELETE
 *
 * "Descendant" is resolved via `SDE_state_lineages`, never via numeric
 * state_id comparison: within a `lineage_name` state_id is lineage order,
 * but across different `lineage_name` trees state_ids are allocation
 * order. See docs/SDE_COMPRESS_SPEC.md Section 4.
 */
export async function graduateTable(
  connection: IDatabaseConnection,
  table: TableInfo,
  graduableSnapshot: Set<number>,
  columnCache?: ColumnCache,
): Promise<GraduateTableResult> {
  const cache = columnCache ?? new Map<string, string[]>();
  const driver = connection.driver;
  const result: GraduateTableResult = {
    table: table.name,
    status: 'no-graduable-rows',
    upserts: 0,
    deletes: 0,
    aRowsRemoved: 0,
    dRowsRemoved: 0,
    warnings: [],
  };

  if (!table.isVersioned || !table.registrationId) return result;

  // Take a shared lock on SDE_versions so concurrent createVersion blocks
  // until this txn commits. Without this, a snapshot-isolation read can be
  // racy at commit time (SQL Server surfaces this as a serialization
  // failure, leaving the half-graduated table to be rolled back, instead of
  // the documented 'skipped-version-set-changed' status). With the lock,
  // the in-fence revalidation below is a true critical section relative to
  // version-set changes. See SDE_COMPRESS_SPEC Section 16 step 3.
  // The probe must lock the FULL range, not a single row. `TOP 1 ... WITH
  // (HOLDLOCK, ROWLOCK)` under READ COMMITTED takes a key-range lock for
  // only the one row scanned; a concurrent createVersion inserting outside
  // that range proceeds. TABLOCK + HOLDLOCK takes a table-level shared lock
  // that blocks every INSERT into SDE_versions until commit. The
  // computeGraduablePrefix recompute below is then a true critical section.
  const versionsTbl = sysTable(connection.driver, 'SDE_versions');
  if (connection.driver === 'sqlserver') {
    await connection.query(`SELECT COUNT(*) FROM ${versionsTbl} WITH (HOLDLOCK, TABLOCK)`);
  } else {
    // SHARE mode on the whole table; same intent as SQL Server's TABLOCK+HOLDLOCK.
    await connection.execute(`LOCK TABLE ${versionsTbl} IN SHARE MODE`);
  }

  // In-fence subset revalidation
  const recomputed = await computeGraduablePrefix(connection);
  if (!isSubsetOf(graduableSnapshot, recomputed)) {
    result.status = 'skipped-version-set-changed';
    return result;
  }

  if (graduableSnapshot.size === 0) return result;

  const regId = table.registrationId;
  const qSchema = qid(driver, table.schema);
  const aTable = `${qSchema}.${qid(driver, `a${regId}`)}`;
  const dTable = `${qSchema}.${qid(driver, `D${regId}`)}`;
  const baseTable = `${qSchema}.${qid(driver, table.name)}`;
  const oidCol = col(driver, 'OBJECTID');
  const sidCol = col(driver, 'SDE_STATE_ID');
  const drowCol = col(driver, 'SDE_DELETES_ROW_ID');
  const delAtCol = col(driver, 'DELETED_AT');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const states = sysTable(driver, 'SDE_states');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  const graduableList = buildIntegerList(Array.from(graduableSnapshot), 'graduateTable');

  // BULK STEP 1: find every winning A-row across all OIDs in one query.
  // A winner = no newer A-row exists for the same OID in the graduable prefix.
  // "Newer" = a2's state has a1's state as ancestor (lineage_name + lineage_id<=
  // closure pattern; see Section 3.3 + Section 4.1 of the spec).
  const aWinnersSql = `
    SELECT a1.${oidCol} AS oid, a1.${sidCol} AS state_id
    FROM ${aTable} a1
    WHERE a1.${sidCol} IN (${graduableList})
      AND NOT EXISTS (
        SELECT 1 FROM ${aTable} a2
        JOIN ${states} s2 ON s2.${col(driver, 'state_id')} = a2.${sidCol}
        JOIN ${lineages} sl ON sl.${lname} = s2.${lname}
          AND sl.${lid} = a1.${sidCol}
          AND sl.${lid} <= a2.${sidCol}
        WHERE a2.${oidCol} = a1.${oidCol}
          AND a2.${sidCol} IN (${graduableList})
          AND a2.${sidCol} <> a1.${sidCol}
      )
  `;
  const aWinnerRows = await connection.query<{ oid: number | bigint; state_id: number | bigint }>(aWinnersSql);

  // BULK STEP 2: find every winning D-row across all OIDs in one query.
  const dWinnersSql = `
    SELECT d1.${drowCol} AS oid, d1.${sidCol} AS state_id, d1.${delAtCol} AS deleted_at
    FROM ${dTable} d1
    WHERE d1.${sidCol} IN (${graduableList})
      AND NOT EXISTS (
        SELECT 1 FROM ${dTable} d2
        JOIN ${states} s2 ON s2.${col(driver, 'state_id')} = d2.${sidCol}
        JOIN ${lineages} sl ON sl.${lname} = s2.${lname}
          AND sl.${lid} = d1.${sidCol}
          AND sl.${lid} <= d2.${sidCol}
        WHERE d2.${drowCol} = d1.${drowCol}
          AND d2.${sidCol} IN (${graduableList})
          AND d2.${sidCol} <> d1.${sidCol}
      )
  `;
  const dWinnerRows = await connection.query<{ oid: number | bigint; state_id: number | bigint; deleted_at: number | bigint | null }>(dWinnersSql);

  // Build OID → winner map.
  //
  // Cross-lineage caveat: aWinnersSql / dWinnersSql only check supersession
  // within a single lineage_name tree (the JOIN binds sl.lineage_name to
  // s2.lineage_name). When the same OID has graduable rows in TWO distinct
  // lineage_name trees that BOTH terminate at version tips (e.g. two posted
  // versions both modified OID 99, ending up at states with different
  // lineage_names but a shared DEFAULT ancestor), each tree contributes its
  // own "winner" and the previous code silently overwrote one with the
  // other via `winners.set(oid, w)`. Net effect: the loser's A/D rows would
  // still be DELETED at the cleanup step, but its column values would never
  // graduate to base. To stay safe, collect ALL candidate state_ids per OID
  // first; if a single OID has multiple A-winners (or multiple D-winners)
  // we'll resolve ancestry below and only delete delta rows for the
  // resolved winner's state.
  interface Winners {
    aStateIds: number[];
    dStateIds: number[];
    dDeletedAt?: number | null;
  }
  const winners = new Map<number, Winners>();
  for (const r of aWinnerRows) {
    const oid = Number(r.oid);
    const w = winners.get(oid) ?? { aStateIds: [], dStateIds: [] };
    w.aStateIds.push(Number(r.state_id));
    winners.set(oid, w);
  }
  for (const r of dWinnerRows) {
    const oid = Number(r.oid);
    const w = winners.get(oid) ?? { aStateIds: [], dStateIds: [] };
    w.dStateIds.push(Number(r.state_id));
    // Last-seen DELETED_AT is fine for the warn-only Pro-authored caveat;
    // ancestry resolution below picks the winning d-state explicitly.
    w.dDeletedAt = r.deleted_at != null ? Number(r.deleted_at) : null;
    winners.set(oid, w);
  }
  if (winners.size === 0) return result;

  // Collect every (ancestor, descendant) pair we need to resolve across
  // BOTH the multi-winner case AND the A-vs-D winner-mismatch case. Then
  // make a SINGLE batched query (chunked to avoid VALUES-list bloat)
  // instead of N sequential round-trips. Previous per-pair await loop was
  // O(pairs) round-trips inside a SERIALIZABLE transaction — at hundreds
  // of pairs this held locks for tens of seconds.

  const pairsNeeded = new Set<string>();
  const pairKey = (anc: number, desc: number) => `${anc}:${desc}`;

  for (const w of winners.values()) {
    if (w.aStateIds.length > 1) {
      for (const s of w.aStateIds) for (const t of w.aStateIds) {
        if (s !== t) pairsNeeded.add(pairKey(t, s));
      }
    }
    if (w.dStateIds.length > 1) {
      for (const s of w.dStateIds) for (const t of w.dStateIds) {
        if (s !== t) pairsNeeded.add(pairKey(t, s));
      }
    }
  }
  // The A-vs-D winner-mismatch pairs are added below after each side has
  // been resolved to a single winner — we don't know the pair until then,
  // so we resolve same-side first, then a second batch for cross-side.

  const ancestryRel = await batchResolveAncestry(connection, driver, pairsNeeded);
  const isAncestor = (anc: number, desc: number) =>
    anc === desc || ancestryRel.has(pairKey(anc, desc));

  // Flatten multi-winner OIDs to single-winner OIDs using the in-memory
  // ancestry relation, warning + skipping when winners are non-comparable.
  function pickNewest(candidates: number[]): number | null {
    if (candidates.length === 1) return candidates[0]!;
    for (const s of candidates) {
      let isNewest = true;
      for (const t of candidates) {
        if (t === s) continue;
        if (!isAncestor(t, s)) { isNewest = false; break; }
      }
      if (isNewest) return s;
    }
    return null;
  }

  for (const [oid, w] of winners) {
    if (w.aStateIds.length > 1) {
      const winner = pickNewest(w.aStateIds);
      if (winner === null) {
        result.warnings.push(
          `OID ${oid} has concurrent graduable A-rows in non-comparable lineages (states ${w.aStateIds.join(', ')}). Skipping; reconcile required before this OID can graduate.`,
        );
        winners.delete(oid);
        continue;
      }
      w.aStateIds = [winner];
    }
    if (w.dStateIds.length > 1) {
      const winner = pickNewest(w.dStateIds);
      if (winner === null) {
        result.warnings.push(
          `OID ${oid} has concurrent graduable D-rows in non-comparable lineages (states ${w.dStateIds.join(', ')}). Skipping; reconcile required before this OID can graduate.`,
        );
        winners.delete(oid);
        continue;
      }
      w.dStateIds = [winner];
    }
  }
  if (winners.size === 0) return result;

  // Cross-side pairs (A-winner vs D-winner at distinct states) — collect
  // them now that each OID has at most one A and one D winner. One more
  // batched query.
  const crossPairs = new Set<string>();
  for (const w of winners.values()) {
    const a = w.aStateIds[0];
    const d = w.dStateIds[0];
    if (a !== undefined && d !== undefined && a !== d) {
      crossPairs.add(pairKey(a, d));
    }
  }
  const crossRel = crossPairs.size > 0
    ? await batchResolveAncestry(connection, driver, crossPairs)
    : new Set<string>();
  const isAncestorCross = (anc: number, desc: number) =>
    anc === desc || crossRel.has(pairKey(anc, desc));

  // Apply tie-breakers (in memory, no more I/O).
  const upsertTargets: Array<{ oid: number; aStateId: number }> = [];
  const deleteTargets: number[] = [];

  for (const [oid, w] of winners) {
    const aStateId = w.aStateIds[0];
    const dStateId = w.dStateIds[0];
    if (aStateId !== undefined && dStateId !== undefined) {
      // Co-located D+A at the same state → UPDATE (UPSERT-A).
      if (aStateId === dStateId) {
        upsertTargets.push({ oid, aStateId });
      } else if (isAncestorCross(aStateId, dStateId)) {
        // D is descendant of A → D is newer → DELETE.
        deleteTargets.push(oid);
      } else {
        // A is descendant-of-or-incomparable-to D → UPSERT-A.
        upsertTargets.push({ oid, aStateId });
      }
    } else if (aStateId !== undefined) {
      upsertTargets.push({ oid, aStateId });
    } else if (dStateId !== undefined) {
      // Pro-authored caveat: if DELETED_AT is outside the prefix and differs
      // from SDE_STATE_ID, warn (Section 3.3.0).
      if (w.dDeletedAt != null && w.dDeletedAt !== dStateId && !graduableSnapshot.has(w.dDeletedAt)) {
        result.warnings.push(
          `D-row for OID ${oid}: DELETED_AT=${w.dDeletedAt} differs from SDE_STATE_ID=${dStateId} and is outside the graduable prefix. Pro-authored pre-image semantics may not match egdb.js behaviour. See spec section 3.3.0.`,
        );
      }
      deleteTargets.push(oid);
    }
  }

  const onProgress = (compressProgressHook as { graduateTable?: (info: { table: string; total: number; done: number }) => void }).graduateTable;
  const total = winners.size;
  onProgress?.({ table: table.name, total, done: 0 });

  // BULK STEP 3: chunked writes. Each chunk = one set of OIDs that share the
  // same A-winner state (so the UPDATE/INSERT joins cleanly).
  const BATCH = 500;

  // Group upserts by aStateId so each chunk's JOIN matches a single state.
  const byState = new Map<number, number[]>();
  for (const { oid, aStateId } of upsertTargets) {
    const arr = byState.get(aStateId) ?? [];
    arr.push(oid);
    byState.set(aStateId, arr);
  }

  // Only fetch column metadata if we have upserts to perform.
  let columns: string[] | null = null;
  let baseCols: string[] = [];
  let qCols = '';
  let setClause = '';
  let srcCols = '';
  if (byState.size > 0) {
    columns = await getTableColumns(connection, driver, table, cache);
    baseCols = columns.filter(c => c.toLowerCase() !== sidCol.toLowerCase());
    qCols = baseCols.map(c => qid(driver, c)).join(', ');
    setClause = baseCols
      .filter(c => c.toLowerCase() !== oidCol.toLowerCase())
      .map(c => `${qid(driver, c)} = a.${qid(driver, c)}`)
      .join(', ');
    srcCols = baseCols.map(c => `a.${qid(driver, c)}`).join(', ');
  }

  let upsertedSoFar = 0;
  for (const [aStateId, oids] of byState) {
    for (let i = 0; i < oids.length; i += BATCH) {
      const chunk = oids.slice(i, i + BATCH);
      const oidList = buildIntegerList(chunk, 'graduateTable.upsertChunk');

      if (driver === 'sqlserver') {
        // Bulk UPDATE: rows already in base.
        const updSql = `
          UPDATE base WITH (UPDLOCK, HOLDLOCK)
          SET ${setClause}
          FROM ${baseTable} base
          INNER JOIN ${aTable} a ON a.${qid(driver, oidCol)} = base.${qid(driver, oidCol)}
          WHERE a.${qid(driver, oidCol)} IN (${oidList})
            AND a.${qid(driver, sidCol)} = @p0
        `;
        const upd = await connection.execute(updSql, [aStateId]);
        result.upserts += upd.rowsAffected;
        upsertedSoFar += upd.rowsAffected;

        // Bulk INSERT: rows not yet in base.
        const insSql = `
          INSERT INTO ${baseTable} (${qCols})
          SELECT ${srcCols}
          FROM ${aTable} a WITH (HOLDLOCK)
          WHERE a.${qid(driver, oidCol)} IN (${oidList})
            AND a.${qid(driver, sidCol)} = @p0
            AND NOT EXISTS (
              SELECT 1 FROM ${baseTable} b WITH (HOLDLOCK)
              WHERE b.${qid(driver, oidCol)} = a.${qid(driver, oidCol)}
            )
        `;
        const ins = await connection.execute(insSql, [aStateId]);
        result.upserts += ins.rowsAffected;
        upsertedSoFar += ins.rowsAffected;
      } else {
        const updateSet = baseCols
          .filter(c => c.toLowerCase() !== oidCol.toLowerCase())
          .map(c => `${qid(driver, c)} = EXCLUDED.${qid(driver, c)}`)
          .join(', ');
        const sql = `
          INSERT INTO ${baseTable} (${qCols})
          SELECT ${baseCols.map(c => qid(driver, c)).join(', ')}
          FROM ${aTable}
          WHERE ${qid(driver, oidCol)} IN (${oidList}) AND ${qid(driver, sidCol)} = $1
          ON CONFLICT (${qid(driver, oidCol)}) DO UPDATE SET ${updateSet}
        `;
        const upserted = await connection.execute(sql, [aStateId]);
        result.upserts += upserted.rowsAffected;
        upsertedSoFar += upserted.rowsAffected;
      }
      onProgress?.({ table: table.name, total, done: upsertedSoFar });
    }
  }

  // Bulk DELETE from base for graduated deletes.
  if (deleteTargets.length > 0) {
    for (let i = 0; i < deleteTargets.length; i += BATCH) {
      const chunk = deleteTargets.slice(i, i + BATCH);
      const oidList = buildIntegerList(chunk, 'graduateTable.deleteChunk');
      const del = await connection.execute(
        `DELETE FROM ${baseTable} WHERE ${qid(driver, oidCol)} IN (${oidList})`,
      );
      result.deletes += del.rowsAffected;
    }
  }

  // Bulk DELETE all delta rows for OIDs we resolved. By this point every
  // surviving winner has a single target (upsert or delete); the multi-
  // lineage non-comparable case removed those OIDs from `winners` earlier
  // with a warning. Deleting their delta rows here keeps the A/D tables
  // tidy regardless of which action was applied to base.
  const allOids = Array.from(winners.keys());
  if (allOids.length > 0) {
    for (let i = 0; i < allOids.length; i += BATCH) {
      const chunk = allOids.slice(i, i + BATCH);
      const oidList = buildIntegerList(chunk, 'graduateTable.cleanupAChunk');
      const delA = await connection.execute(
        `DELETE FROM ${aTable} WHERE ${oidCol} IN (${oidList}) AND ${sidCol} IN (${graduableList})`,
      );
      result.aRowsRemoved += delA.rowsAffected;
      const delD = await connection.execute(
        `DELETE FROM ${dTable} WHERE ${drowCol} IN (${oidList}) AND ${sidCol} IN (${graduableList})`,
      );
      result.dRowsRemoved += delD.rowsAffected;
    }
  }
  onProgress?.({ table: table.name, total, done: total });

  result.status = 'graduated';
  return result;
}

/**
 * Test/diagnostic hook. Set `compressProgressHook.graduateTable` to a
 * callback that receives progress events from graduateTable.
 */
export const compressProgressHook: {
  graduateTable?: (info: { table: string; total: number; done: number }) => void;
} = {};

/**
 * Is state `ancestor` an ancestor of state `descendant`? Resolved via the
 * closure table — NEVER via state_id comparison.
 */
async function stateIsAncestorOf(
  connection: IDatabaseConnection,
  driver: Driver,
  ancestor: number,
  descendant: number,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');
  // Same pattern as find-ancestor.ts: join SDE_state_lineages on the
  // descendant's lineage_name (looked up from SDE_states), filter
  // lineage_id <= descendant (within a lineage_name, state_id is lineage
  // order from root to tip).
  const sql = `
    SELECT 1 FROM ${lineages} sl
    JOIN ${states} s ON s.${lname} = sl.${lname}
    WHERE s.${sid} = ${paramRef(driver, 0)}
      AND sl.${lid} = ${paramRef(driver, 1)}
      AND sl.${lid} <= ${paramRef(driver, 0)}
  `;
  const rows = await connection.query(sql, [descendant, ancestor]);
  return rows.length > 0;
}

/**
 * Batched ancestry resolution. Given a set of `"ancestor:descendant"` pair
 * keys, returns the subset where ancestor is in descendant's lineage
 * closure. One round-trip per chunk (default 200 pairs/chunk) instead of
 * one per pair.
 *
 * Uses the same lineage_name-join + `lineage_id <= state_id` pattern as
 * `stateIsAncestorOf`.
 */
async function batchResolveAncestry(
  connection: IDatabaseConnection,
  driver: Driver,
  pairKeys: Set<string>,
): Promise<Set<string>> {
  if (pairKeys.size === 0) return new Set();

  const pairs: Array<{ anc: number; desc: number }> = [];
  for (const key of pairKeys) {
    const [a, d] = key.split(':');
    pairs.push({ anc: Number(a), desc: Number(d) });
  }

  const states = sysTable(driver, 'SDE_states');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  const result = new Set<string>();
  const CHUNK = 200;

  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    // Build a VALUES list. Both dialects accept `(VALUES (...), (...)) AS p(anc, desc)`.
    const valuesList = chunk.map(p => `(${p.anc}, ${p.desc})`).join(', ');
    const sql = driver === 'sqlserver'
      ? `
        SELECT p.anc, p.desc
        FROM (VALUES ${valuesList}) AS p(anc, desc)
        JOIN ${states} sd ON sd.${sid} = p.desc
        JOIN ${lineages} sl ON sl.${lname} = sd.${lname}
          AND sl.${lid} = p.anc
          AND sl.${lid} <= p.desc
      `
      : `
        SELECT p.anc, p.desc
        FROM (VALUES ${valuesList}) AS p(anc, desc)
        JOIN ${states} sd ON sd.${sid} = p.desc
        JOIN ${lineages} sl ON sl.${lname} = sd.${lname}
          AND sl.${lid} = p.anc
          AND sl.${lid} <= p.desc
      `;
    const rows = await connection.query<{ anc: number | bigint; desc: number | bigint }>(sql);
    for (const r of rows) {
      result.add(`${Number(r.anc)}:${Number(r.desc)}`);
    }
  }

  return result;
}

/**
 * Per-invocation column-name cache. The base table and the A-table share
 * the same columns (plus SDE_STATE_ID on the A-table). The caller passes a
 * fresh Map for each `compress()` invocation so DDL changes between runs
 * are never served from stale memory, and so connection-pool wrapping
 * cannot stabilize the cache key incorrectly.
 */
export type ColumnCache = Map<string, string[]>;

async function getTableColumns(
  connection: IDatabaseConnection,
  driver: Driver,
  table: TableInfo,
  cache: ColumnCache,
): Promise<string[]> {
  const key = `${table.schema}.${table.name}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const sql = driver === 'sqlserver'
    ? `
      SELECT COLUMN_NAME AS name
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1
      ORDER BY ORDINAL_POSITION
    `
    : `
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position
    `;
  const rows = await connection.query<{ name: string }>(sql, [table.schema, table.name]);
  const names = rows.map(r => r.name);
  if (names.length === 0) {
    throw new Error(`No columns found for ${table.schema}.${table.name}; cannot graduate.`);
  }
  cache.set(key, names);
  return names;
}

// ---------------------------------------------------------------------------
// Prune states
// ---------------------------------------------------------------------------

export interface PruneResult {
  /** Number of states deleted from SDE_states */
  statesRemoved: number;
  /** Number of A/D rows deleted across all tables for pruned states */
  deltaRowsRemoved: number;
  /** States considered but skipped because re-check failed under locking */
  statesSkipped: number;
  /**
   * Number of delta rows already committed to disk for a state that was
   * subsequently aborted by the metadata-transaction recheck (a new
   * EditSession.start landed a lock after we'd committed the per-table
   * delta-row deletes but before we committed SDE_states). The state itself
   * is preserved (counted in statesSkipped), but its A/D rows for the
   * graduable prefix are gone. Operators should treat a non-zero value here
   * as a signal to investigate concurrent EditSession activity during
   * compress windows. See SDE_COMPRESS_SPEC Section 16 step 4(b).
   */
  deltaRowsLostToLateLocks: number;
}

/**
 * Find prune-candidate states per spec Section 3.1:
 *   - NOT a version tip
 *   - NOT in any version's lineage closure
 *   - has at most one direct child (not a branch point)
 *   - NOT in any locked branch's expanded closure
 */
async function findPruneCandidates(
  connection: IDatabaseConnection,
  lockedExpanded: Set<number>,
): Promise<number[]> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const versions = sysTable(driver, 'SDE_versions');
  const lineages = sysTable(driver, 'SDE_state_lineages');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');
  const lid = col(driver, 'lineage_id');
  const lname = col(driver, 'lineage_name');

  // "Not in any version's closure" uses the same idiom as
  // computeGraduablePrefix: each version tip's effective closure is
  //   JOIN SDE_states vs ON vs.state_id = v.state_id
  //   JOIN SDE_state_lineages sl ON sl.lineage_name = vs.lineage_name
  //     AND sl.lineage_id <= vs.state_id
  // UNION the tip itself (ArcGIS-authored states often have no self-row).
  // The earlier shape `WHERE lineage_name IN (SELECT state_id FROM versions)`
  // treated the tip's state_id as if it were a lineage_name and returned
  // zero rows on any DB where lineage_name != state_id (the normal case).
  // That made every linear ancestor of a tip a candidate; only the
  // branch-point / lockedExpanded filters saved correctness, and a long
  // linear DEFAULT history would have been pruned.
  const sql = `
    SELECT s.${sid} AS state_id
    FROM ${states} s
    WHERE s.${sid} NOT IN (SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL)
      AND s.${sid} NOT IN (
        SELECT sl.${lid}
        FROM ${lineages} sl
        JOIN ${states} vs ON vs.${lname} = sl.${lname}
        WHERE vs.${sid} IN (SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL)
          AND sl.${lid} <= vs.${sid}
        UNION
        SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL
      )
      AND (
        SELECT COUNT(*) FROM ${states} c WHERE c.${pid} = s.${sid}
      ) <= 1
  `;
  const rows = await connection.query<{ state_id: number | bigint }>(sql);
  return rows
    .map(r => Number(r.state_id))
    .filter(s => !lockedExpanded.has(s));
}

/**
 * Prune unreferenced, non-branch-point, unlocked states.
 *
 * Per spec Section 16 step 4 + Section 7: the closure/lock recheck runs
 * INSIDE each per-table delta-row deletion transaction, BEFORE the DELETE.
 * A separate metadata transaction at the end deletes SDE_state_lineages /
 * SDE_states / SDE_mvtables_modified after every table has committed.
 */
export async function pruneStates(
  connection: IDatabaseConnection,
  tables: TableInfo[],
): Promise<PruneResult> {
  const result: PruneResult = {
    statesRemoved: 0,
    deltaRowsRemoved: 0,
    statesSkipped: 0,
    deltaRowsLostToLateLocks: 0,
  };
  // Pre-check ONCE so we never raise a missing-table error mid-transaction
  // (PostgreSQL would poison the transaction; SQL Server would just throw
  // and lose the metadata-tx work). See `hasMvtablesModified()`.
  const mvExists = await hasMvtablesModified(connection);
  const driver = connection.driver;

  const lockedExpanded = await readLockedBranches(connection);
  const candidates = await findPruneCandidates(connection, lockedExpanded);
  if (candidates.length === 0) return result;

  const versionedTables = tables.filter(t => t.isVersioned && t.registrationId);

  for (const stateId of candidates) {
    let stateStillEligible = true;
    let deltaRowsDeletedForThisState = 0;

    // Per-table delta-row deletion. Each table is its own transaction, with
    // an in-fence recheck of the prune predicate.
    for (const table of versionedTables) {
      const regId = table.registrationId!;
      const qSchema = qid(driver, table.schema);
      const aTable = `${qSchema}.${qid(driver, `a${regId}`)}`;
      const dTable = `${qSchema}.${qid(driver, `D${regId}`)}`;
      const sidCol = col(driver, 'SDE_STATE_ID');
      const delAtCol = col(driver, 'DELETED_AT');

      try {
        await connection.beginTransaction();
        const recheckLocks = await readLockedBranches(connection);
        const recheckCandidates = new Set(await findPruneCandidates(connection, recheckLocks));
        if (!recheckCandidates.has(stateId)) {
          await connection.rollbackTransaction();
          stateStillEligible = false;
          break;
        }
        const delA = await connection.execute(
          `DELETE FROM ${aTable} WHERE ${sidCol} = ${paramRef(driver, 0)}`,
          [stateId],
        );
        result.deltaRowsRemoved += delA.rowsAffected;
        deltaRowsDeletedForThisState += delA.rowsAffected;
        // Use two distinct param slots — even though SQL Server's @p0 can be
        // referenced twice safely with one bound param, the mssql driver
        // registers exactly the params passed in the array, and mismatch
        // (two params bound but one referenced) can throw "too many
        // arguments" depending on driver config. Bind two; reference two.
        const delD = await connection.execute(
          `DELETE FROM ${dTable} WHERE ${sidCol} = ${paramRef(driver, 0)} OR ${delAtCol} = ${paramRef(driver, 1)}`,
          [stateId, stateId],
        );
        result.deltaRowsRemoved += delD.rowsAffected;
        deltaRowsDeletedForThisState += delD.rowsAffected;
        await connection.commitTransaction();
      } catch (e) {
        if (connection.inTransaction()) await connection.rollbackTransaction();
        throw e;
      }
    }

    if (!stateStillEligible) {
      result.statesSkipped += 1;
      continue;
    }

    // Final metadata transaction: re-evaluate one more time, then drop the
    // state row. Order matters per Section 16: lineages → mvtables_modified
    // → states.
    try {
      await connection.beginTransaction();
      const recheckLocks = await readLockedBranches(connection);
      const recheckCandidates = new Set(await findPruneCandidates(connection, recheckLocks));
      if (!recheckCandidates.has(stateId)) {
        await connection.rollbackTransaction();
        result.statesSkipped += 1;
        // The per-table delta-row deletes have already committed; we
        // cannot un-do them here. Surface the count so operators can
        // detect concurrent EditSession.start races during compress.
        if (deltaRowsDeletedForThisState > 0) {
          result.deltaRowsLostToLateLocks += deltaRowsDeletedForThisState;
        }
        continue;
      }
      const lineages = sysTable(driver, 'SDE_state_lineages');
      const states = sysTable(driver, 'SDE_states');
      const mv = sysTable(driver, 'SDE_mvtables_modified');
      const lid = col(driver, 'lineage_id');
      const lname = col(driver, 'lineage_name');
      const sidM = col(driver, 'state_id');

      // Same param-binding rule as above: two slots, two refs.
      await connection.execute(
        `DELETE FROM ${lineages} WHERE ${lid} = ${paramRef(driver, 0)} OR ${lname} = ${paramRef(driver, 1)}`,
        [stateId, stateId],
      );
      if (mvExists) {
        await connection.execute(
          `DELETE FROM ${mv} WHERE ${sidM} = ${paramRef(driver, 0)}`,
          [stateId],
        );
      }
      const del = await connection.execute(
        `DELETE FROM ${states} WHERE ${sidM} = ${paramRef(driver, 0)}`,
        [stateId],
      );
      result.statesRemoved += del.rowsAffected;
      await connection.commitTransaction();
    } catch (e) {
      if (connection.inTransaction()) await connection.rollbackTransaction();
      throw e;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Collapse candidate lineages
// ---------------------------------------------------------------------------

export interface CollapseResult {
  /** Number of (parent, child) merges performed */
  collapses: number;
  /** Number of delta rows rewritten (SDE_STATE_ID or DELETED_AT updates) */
  rowsRewritten: number;
}

/**
 * Find collapse candidates: (parent P, child C) where C is not a version tip,
 * P has exactly one child (= C), and C has at most one child of its own.
 *
 * Note: branch points must survive. A state with ≥ 2 children cannot collapse
 * its children up because doing so would merge sibling branches.
 */
async function findCollapsePairs(
  connection: IDatabaseConnection,
  lockedExpanded: Set<number>,
): Promise<Array<{ parent: number; child: number }>> {
  const driver = connection.driver;
  const states = sysTable(driver, 'SDE_states');
  const versions = sysTable(driver, 'SDE_versions');
  const sid = col(driver, 'state_id');
  const pid = col(driver, 'parent_state_id');

  const sql = `
    SELECT c.${sid} AS child, p.${sid} AS parent
    FROM ${states} c
    INNER JOIN ${states} p ON p.${sid} = c.${pid}
    WHERE c.${sid} NOT IN (SELECT ${sid} FROM ${versions} WHERE ${sid} IS NOT NULL)
      AND (SELECT COUNT(*) FROM ${states} p2 WHERE p2.${pid} = p.${sid}) = 1
      AND (SELECT COUNT(*) FROM ${states} cc WHERE cc.${pid} = c.${sid}) <= 1
  `;
  const rows = await connection.query<{ parent: number | bigint; child: number | bigint }>(sql);
  return rows
    .map(r => ({ parent: Number(r.parent), child: Number(r.child) }))
    .filter(p => !lockedExpanded.has(p.parent) && !lockedExpanded.has(p.child));
}

/**
 * Collapse linear runs of states.
 *
 * Note on collapse direction: per spec Section 3.2, child C collapses into
 * parent P (P survives). Delta rows at C are rebased to P; SDE_versions
 * entries pointing at C are rewritten to P in the same transaction.
 *
 * DELETED_AT independent rewrite (spec Section 3.2 step 4, fix H5): D-row
 * SDE_STATE_ID and DELETED_AT can each independently equal C; both must be
 * rewritten in their own UPDATEs.
 */
export async function collapseLineages(
  connection: IDatabaseConnection,
  tables: TableInfo[],
): Promise<CollapseResult> {
  const result: CollapseResult = { collapses: 0, rowsRewritten: 0 };
  const driver = connection.driver;
  const versionedTables = tables.filter(t => t.isVersioned && t.registrationId);
  const mvExists = await hasMvtablesModified(connection);

  // Iterate until no more collapses are possible.
  for (;;) {
    const lockedExpanded = await readLockedBranches(connection);
    const pairs = await findCollapsePairs(connection, lockedExpanded);
    if (pairs.length === 0) break;

    let didCollapse = false;
    for (const { parent, child } of pairs) {
      // Per-table delta-row rewrites.
      for (const table of versionedTables) {
        const regId = table.registrationId!;
        const qSchema = qid(driver, table.schema);
        const aTable = `${qSchema}.${qid(driver, `a${regId}`)}`;
        const dTable = `${qSchema}.${qid(driver, `D${regId}`)}`;
        const oidCol = col(driver, 'OBJECTID');
        const sidCol = col(driver, 'SDE_STATE_ID');
        const drowCol = col(driver, 'SDE_DELETES_ROW_ID');
        const delAtCol = col(driver, 'DELETED_AT');

        try {
          await connection.beginTransaction();

          // Dedupe BEFORE rewrite (spec Section 3.2 step 3). Within a P→C
          // chain, C is closer to the tip, so C wins; delete the loser
          // A-row at P for any OID that also has an A-row at C.
          await connection.execute(
            `DELETE FROM ${aTable}
             WHERE ${sidCol} = ${paramRef(driver, 0)}
               AND ${oidCol} IN (
                 SELECT ${oidCol} FROM ${aTable} WHERE ${sidCol} = ${paramRef(driver, 1)}
               )`,
            [parent, child],
          );
          await connection.execute(
            `DELETE FROM ${dTable}
             WHERE ${sidCol} = ${paramRef(driver, 0)}
               AND ${drowCol} IN (
                 SELECT ${drowCol} FROM ${dTable} WHERE ${sidCol} = ${paramRef(driver, 1)}
               )`,
            [parent, child],
          );

          // Rewrite SDE_STATE_ID (C → P).
          const aUpd = await connection.execute(
            `UPDATE ${aTable} SET ${sidCol} = ${paramRef(driver, 0)} WHERE ${sidCol} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
          result.rowsRewritten += aUpd.rowsAffected;
          const dUpd1 = await connection.execute(
            `UPDATE ${dTable} SET ${sidCol} = ${paramRef(driver, 0)} WHERE ${sidCol} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
          result.rowsRewritten += dUpd1.rowsAffected;
          // Independent DELETED_AT rewrite (fix H5).
          const dUpd2 = await connection.execute(
            `UPDATE ${dTable} SET ${delAtCol} = ${paramRef(driver, 0)} WHERE ${delAtCol} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
          result.rowsRewritten += dUpd2.rowsAffected;

          await connection.commitTransaction();
        } catch (e) {
          if (connection.inTransaction()) await connection.rollbackTransaction();
          throw e;
        }
      }

      // Single metadata transaction per collapse (atomic with state delete).
      try {
        await connection.beginTransaction();
        const states = sysTable(driver, 'SDE_states');
        const lineages = sysTable(driver, 'SDE_state_lineages');
        const versions = sysTable(driver, 'SDE_versions');
        const mv = sysTable(driver, 'SDE_mvtables_modified');
        const sid = col(driver, 'state_id');
        const lid = col(driver, 'lineage_id');
        const lname = col(driver, 'lineage_name');

        // Rewrite lineage rows: any lineage_id = child → parent.
        // First, DELETE any rows whose update would PK-conflict — a
        // (lineage_name, lineage_id=parent) row already exists, so we'd
        // duplicate. Then the bulk UPDATE is safe.
        // (lineage_name = child is removed: child's own closure rows go away.)
        const dedupLineages = driver === 'sqlserver'
          ? `DELETE sl1 FROM ${lineages} sl1
             WHERE sl1.${lid} = @p0
               AND EXISTS (
                 SELECT 1 FROM ${lineages} sl2
                 WHERE sl2.${lid} = @p1 AND sl2.${lname} = sl1.${lname}
               )`
          : `DELETE FROM ${lineages} sl1
             WHERE sl1.${lid} = $1
               AND EXISTS (
                 SELECT 1 FROM ${lineages} sl2
                 WHERE sl2.${lid} = $2 AND sl2.${lname} = sl1.${lname}
               )`;
        await connection.execute(dedupLineages, [child, parent]);
        await connection.execute(
          `UPDATE ${lineages} SET ${lid} = ${paramRef(driver, 0)} WHERE ${lid} = ${paramRef(driver, 1)}`,
          [parent, child],
        );
        await connection.execute(
          `DELETE FROM ${lineages} WHERE ${lname} = ${paramRef(driver, 0)}`,
          [child],
        );
        if (mvExists) {
          // SDE_mvtables_modified PK is typically (state_id, registration_id).
          // Same dedupe pattern as SDE_state_lineages above.
          const dedupMv = driver === 'sqlserver'
            ? `DELETE mv1 FROM ${mv} mv1
               WHERE mv1.${sid} = @p0
                 AND EXISTS (
                   SELECT 1 FROM ${mv} mv2
                   WHERE mv2.${sid} = @p1
                     AND mv2.registration_id = mv1.registration_id
                 )`
            : `DELETE FROM ${mv} mv1
               WHERE mv1.${sid} = $1
                 AND EXISTS (
                   SELECT 1 FROM ${mv} mv2
                   WHERE mv2.${sid} = $2
                     AND mv2.registration_id = mv1.registration_id
                 )`;
          await connection.execute(dedupMv, [child, parent]);
          await connection.execute(
            `UPDATE ${mv} SET ${sid} = ${paramRef(driver, 0)} WHERE ${sid} = ${paramRef(driver, 1)}`,
            [parent, child],
          );
        }
        // No-op in steady state per spec; covers race where a version was
        // created concurrently and now points at C.
        await connection.execute(
          `UPDATE ${versions} SET ${sid} = ${paramRef(driver, 0)} WHERE ${sid} = ${paramRef(driver, 1)}`,
          [parent, child],
        );
        // Re-point any other state's parent_state_id from child to parent
        // (i.e. the child's child becomes a direct child of the parent).
        const pid = col(driver, 'parent_state_id');
        await connection.execute(
          `UPDATE ${states} SET ${pid} = ${paramRef(driver, 0)} WHERE ${pid} = ${paramRef(driver, 1)}`,
          [parent, child],
        );
        await connection.execute(
          `DELETE FROM ${states} WHERE ${sid} = ${paramRef(driver, 0)}`,
          [child],
        );
        await connection.commitTransaction();
        result.collapses += 1;
        didCollapse = true;
      } catch (e) {
        if (connection.inTransaction()) await connection.rollbackTransaction();
        throw e;
      }
    }

    if (!didCollapse) break;
  }

  return result;
}
