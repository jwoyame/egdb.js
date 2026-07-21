/**
 * Functions for detecting changes in versioned tables
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo, FeatureChange, VersionChanges, Feature } from '../types';

/**
 * Quote an identifier based on database driver.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Get all changes for a single versioned table within the given states.
 *
 * Changes are categorized as:
 * - INSERT: Row in A table but NOT in D table (new feature)
 * - UPDATE: Row in BOTH A and D tables (delete old + add new = update)
 * - DELETE: Row in D table but NOT in A table (just deleted)
 *
 * @param connection Database connection
 * @param table Table info
 * @param stateIds State IDs to check for changes
 * @returns Changes found in the table
 */
export async function getTableChanges(
  connection: IDatabaseConnection,
  table: TableInfo,
  stateIds: number[]
): Promise<VersionChanges> {
  if (!table.isVersioned || !table.registrationId) {
    return { inserts: [], updates: [], deletes: [] };
  }

  if (stateIds.length === 0) {
    return { inserts: [], updates: [], deletes: [] };
  }

  const regId = table.registrationId;
  const schema = table.schema;
  const stateIdList = stateIds.join(',');
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
  const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

  // Get all rows in A table (adds) for these states. ORDER BY SDE_STATE_ID
  // ASC is REQUIRED for correctness: when an OBJECTID has A-rows in more than
  // one of these states (the normal multi-state case -- every save/reconcile
  // makes a state), the objectId->stateId Map below keeps the LAST row written,
  // so ascending order makes it the MAX (tip) state. The tip is the row a
  // versioned read resolves (enterprise-table.ts uses MAX(SDE_STATE_ID)), so
  // consumers that copy this row (e.g. trim post) must copy the tip, not an
  // arbitrary earlier state -- otherwise a parcel adjusted-then-retired across
  // states could land its pre-retirement content in DEFAULT.
  const addsSql = driver === 'sqlserver'
    ? `SELECT OBJECTID, SDE_STATE_ID FROM ${aTable} WHERE SDE_STATE_ID IN (${stateIdList}) ORDER BY SDE_STATE_ID ASC`
    : `SELECT objectid as "OBJECTID", sde_state_id as "SDE_STATE_ID" FROM ${aTable} WHERE sde_state_id IN (${stateIdList}) ORDER BY sde_state_id ASC`;

  const addsRows = await connection.query<{ OBJECTID: number; SDE_STATE_ID: number }>(addsSql);

  // Get all rows in D table (deletes) for these states. Same ASC ordering so a
  // multi-state OBJECTID keeps its MAX delete state.
  const deletesSql = driver === 'sqlserver'
    ? `SELECT SDE_DELETES_ROW_ID as OBJECTID, SDE_STATE_ID FROM ${dTable} WHERE SDE_STATE_ID IN (${stateIdList}) ORDER BY SDE_STATE_ID ASC`
    : `SELECT sde_deletes_row_id as "OBJECTID", sde_state_id as "SDE_STATE_ID" FROM ${dTable} WHERE sde_state_id IN (${stateIdList}) ORDER BY sde_state_id ASC`;

  const deletesRows = await connection.query<{ OBJECTID: number; SDE_STATE_ID: number }>(deletesSql);

  // Build sets for analysis
  const addedIds = new Map<number, number>(); // objectId -> stateId
  const deletedIds = new Map<number, number>(); // objectId -> stateId

  for (const row of addsRows) {
    addedIds.set(row.OBJECTID, row.SDE_STATE_ID);
  }

  for (const row of deletesRows) {
    deletedIds.set(row.OBJECTID, row.SDE_STATE_ID);
  }

  const changes: VersionChanges = { inserts: [], updates: [], deletes: [] };

  // Categorize changes
  for (const [objectId, stateId] of addedIds) {
    if (deletedIds.has(objectId)) {
      // UPDATE: appears in both A and D
      changes.updates.push({
        table: table.name,
        registrationId: regId,
        objectId,
        stateId,
        changeType: 'update'
      });
    } else {
      // INSERT: only in A
      changes.inserts.push({
        table: table.name,
        registrationId: regId,
        objectId,
        stateId,
        changeType: 'insert'
      });
    }
  }

  for (const [objectId, stateId] of deletedIds) {
    if (!addedIds.has(objectId)) {
      // DELETE: only in D
      changes.deletes.push({
        table: table.name,
        registrationId: regId,
        objectId,
        stateId,
        changeType: 'delete'
      });
    }
    // If also in A, it's an UPDATE (already handled above)
  }

  return changes;
}

/**
 * Get changes across all versioned tables.
 *
 * @param connection Database connection
 * @param tables All tables in the geodatabase
 * @param stateIds State IDs to check for changes
 * @returns Combined changes from all tables
 */
export async function getAllChanges(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  stateIds: number[]
): Promise<VersionChanges> {
  const allChanges: VersionChanges = { inserts: [], updates: [], deletes: [] };

  for (const table of tables) {
    if (!table.isVersioned) continue;

    const tableChanges = await getTableChanges(connection, table, stateIds);
    allChanges.inserts.push(...tableChanges.inserts);
    allChanges.updates.push(...tableChanges.updates);
    allChanges.deletes.push(...tableChanges.deletes);
  }

  return allChanges;
}

/**
 * A change paired with the parsed feature row in the version's view.
 * `feature` is null for deletes (the row no longer exists in the
 * version view) and for any row that could not be fetched from the
 * view (e.g. the version moved past the change in a concurrent
 * reconcile). Callers that need the pre-delete or pre-update snapshot
 * should pair this with a "read feature at state" helper.
 */
export interface ChangedFeatureRecord {
  table: string;
  registrationId: number;
  objectId: number;
  stateId: number;
  changeType: 'insert' | 'update' | 'delete';
  feature: Feature | null;
}

export interface ChangedFeaturesResult {
  inserts: ChangedFeatureRecord[];
  updates: ChangedFeatureRecord[];
  deletes: ChangedFeatureRecord[];
}

/**
 * A subset of EnterpriseTable that this helper needs. Declared as a
 * minimal interface so callers can pass either a real EnterpriseTable
 * or a test stub without dragging the whole class type in.
 */
export interface FeatureReader {
  stream(options: { version?: string; where?: string }): AsyncIterable<Feature>;
}

/**
 * Get every change across all versioned tables AND the parsed feature
 * row for inserts and updates, in one batched query per table.
 *
 * This is the feature-paired sibling of `getAllChanges`. Today's
 * `getAllChanges` returns OID/stateId/changeType metadata only, which
 * leaves callers doing one stream() call per change to hydrate the
 * geometry and attributes. For typical "show the user what they
 * changed" use cases that is N+1 queries per table. This helper
 * collapses them into one IN-list query per affected table.
 *
 * `versionName` is the view to read inserts/updates from. Pass the
 * child version's qualified name to get the post-edit rows. Pass the
 * parent's name to get a best-effort pre-delete snapshot for deletes
 * (the row will appear in the parent view as long as the parent has
 * not moved past the common ancestor for that row).
 *
 * Deletes return `feature: null` by design; the post-edit row does not
 * exist in the version view. Callers that want the pre-delete snapshot
 * should issue a second call with `versionName` set to the parent.
 *
 * @param connection Database connection (used only by `getAllChanges`
 *   to detect changes; the feature reads go through `openTable`).
 * @param openTable Resolver that returns a FeatureReader for a table
 *   name. Typically `(name) => gdb.openTable(name)`.
 * @param versionName Qualified version name whose view we read from.
 * @param tables All tables in the geodatabase. Non-versioned tables
 *   are skipped.
 * @param stateIds State IDs to check for changes.
 */
export async function getAllChangedFeatures(
  connection: IDatabaseConnection,
  openTable: (name: string) => Promise<FeatureReader>,
  versionName: string,
  tables: TableInfo[],
  stateIds: number[]
): Promise<ChangedFeaturesResult> {
  const base = await getAllChanges(connection, tables, stateIds);

  const result: ChangedFeaturesResult = { inserts: [], updates: [], deletes: [] };

  // Group inserts and updates by table so we issue one IN-list query
  // per table instead of one per row. Deletes do not need a fetch.
  type PerTable = { inserts: FeatureChange[]; updates: FeatureChange[] };
  const byTable = new Map<string, PerTable>();
  for (const c of base.inserts) {
    let entry = byTable.get(c.table);
    if (!entry) { entry = { inserts: [], updates: [] }; byTable.set(c.table, entry); }
    entry.inserts.push(c);
  }
  for (const c of base.updates) {
    let entry = byTable.get(c.table);
    if (!entry) { entry = { inserts: [], updates: [] }; byTable.set(c.table, entry); }
    entry.updates.push(c);
  }

  // Run one query per table to fetch every changed row at once. The
  // versioned view stream returns the row at the current state, which
  // is the post-edit snapshot for inserts and updates.
  const featureByKey = new Map<string, Feature>();
  for (const [tableName, entry] of byTable) {
    const oids = uniqueOids([...entry.inserts, ...entry.updates]);
    if (oids.length === 0) continue;
    const table = await openTable(tableName);
    for await (const f of table.stream({
      version: versionName,
      where: `OBJECTID IN (${oids.join(',')})`,
    })) {
      featureByKey.set(`${tableName}:${f.id}`, f);
    }
  }

  const lookup = (table: string, objectId: number): Feature | null =>
    featureByKey.get(`${table}:${objectId}`) ?? null;

  for (const c of base.inserts) {
    result.inserts.push({
      table: c.table,
      registrationId: c.registrationId,
      objectId: c.objectId,
      stateId: c.stateId,
      changeType: 'insert',
      feature: lookup(c.table, c.objectId),
    });
  }
  for (const c of base.updates) {
    result.updates.push({
      table: c.table,
      registrationId: c.registrationId,
      objectId: c.objectId,
      stateId: c.stateId,
      changeType: 'update',
      feature: lookup(c.table, c.objectId),
    });
  }
  for (const c of base.deletes) {
    result.deletes.push({
      table: c.table,
      registrationId: c.registrationId,
      objectId: c.objectId,
      stateId: c.stateId,
      changeType: 'delete',
      feature: null,
    });
  }

  return result;
}

function uniqueOids(changes: FeatureChange[]): number[] {
  const set = new Set<number>();
  for (const c of changes) set.add(c.objectId);
  return [...set];
}

/**
 * Get a summary of changes (counts only, no details).
 *
 * @param changes Version changes
 * @returns Summary object with counts
 */
export function getChangesSummary(changes: VersionChanges): {
  totalChanges: number;
  insertCount: number;
  updateCount: number;
  deleteCount: number;
  tablesAffected: string[];
} {
  const tablesAffected = new Set<string>();

  for (const c of [...changes.inserts, ...changes.updates, ...changes.deletes]) {
    tablesAffected.add(c.table);
  }

  return {
    totalChanges: changes.inserts.length + changes.updates.length + changes.deletes.length,
    insertCount: changes.inserts.length,
    updateCount: changes.updates.length,
    deleteCount: changes.deletes.length,
    tablesAffected: Array.from(tablesAffected)
  };
}
