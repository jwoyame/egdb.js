/**
 * EnterpriseGeodatabase - Main class for accessing enterprise geodatabases
 *
 * Supports SQL Server and PostgreSQL backends.
 */

import type { IDatabaseConnection } from './connections/connection';
import { SqlServerConnection } from './connections/sqlserver';
import { PostgreSQLConnection } from './connections/postgresql';
import { EnterpriseTable } from './enterprise-table';
import { EditSession } from './edit-session';
import { type Logger, consoleLogger } from './logger';
import { setParserLogger } from './parsers/geometry-parser';
import { parseGdbItems } from './parsers/gdb-items-parser';
import type { GdbItemRow } from './parsers/gdb-items-parser';
import type {
  ConnectionConfig,
  GeometryType,
  TableInfo,
  VersionInfo,
  ReconcileOptions,
  ReconcileResult,
  PostOptions,
  PostResult,
  CompressOptions,
  CompressResult,
} from './types';
import {
  findCommonAncestor,
  getStatesInRange,
  findExternallyReferencedStates,
  removeFromATable,
  removeFromDTable,
  getLineageName,
  addStatesToLineage,
  getAllChanges,
  createChildState,
  copyATableRow,
  insertDeleteMarker,
  detectDetailedConflicts,
  getConflictsSummary,
  applyParentChanges,
  isReconciled,
  countChangesInStates,
  emitBaseShadowMarkers,
  updateVersionState,
  selectChangedObjectIds,
  selectDeletedObjectIds,
  selectObjectIdsWithARows,
  selectObjectIdsPresentInParent,
  insertSupersedeMarkers,
  copyTipRows,
  insertDeleteMarkers,
  getVersionStats,
  cleanupStaleLocks,
  computeGraduablePrefix,
  graduateTable,
  pruneStates,
  collapseLineages,
} from './reconcile';
import type { GraduateTableResult } from './reconcile';
import type { StaleLockCleanupResult } from './reconcile';

/**
 * Error thrown when version locking times out.
 * Indicates another operation is in progress on the target version.
 */
export class LockTimeoutError extends Error {
  constructor(resource: string) {
    super(`Lock timeout on resource: ${resource}`);
    this.name = 'LockTimeoutError';
  }
}

export class EnterpriseGeodatabase {
  /** Version-lock acquisition timeout (milliseconds) */
  private static readonly LOCK_TIMEOUT_MS = 30000;

  private connection: IDatabaseConnection;
  private config: ConnectionConfig;
  private _version: string | null = null;
  private _tables: TableInfo[] | null = null;
  // Opened tables, keyed by canonical (lower-cased) table name. Table schema
  // is static for the life of the connection, so openTable's metadata load
  // (GDB_ITEMS XML + INFORMATION_SCHEMA + COUNT + evw lookup - several round
  // trips) only needs to run once per table. Promise-valued so concurrent
  // opens share one load; evicted on failure so a transient error doesn't
  // poison the cache. Version is NOT part of the key: the table is
  // version-agnostic and stream()/insert() take the version per call.
  //
  // Caveat: a cached table's metadata (field list and featureCount) is frozen
  // at first open until the connection is recycled. featureCount is otherwise
  // unused; a live schema change (ALTER TABLE / re-registration) needs
  // evictTable() or a reconnect to be picked up. The key assumes table Name is
  // unique across the geodatabase (true for a single parcel fabric).
  private _tableCache = new Map<string, Promise<EnterpriseTable>>();
  // Cache of a state's ancestry (getStatesInRange(stateId, 0)) keyed by that
  // state id, to remove the per-read recursive-CTE lineage walk (~70-170ms
  // measured) now that every user-facing read goes through the versioned view.
  //
  // Between compresses this is effectively immutable (states are append-only;
  // an edit advances the tip → new key). The one thing that CAN change an
  // existing tip's ancestry is a compress: it trims/collapses states and
  // re-points surviving parents, so a chain cached before a compress can go
  // stale. We therefore bound entries with a short TTL (compress is a rare,
  // typically-nightly op) rather than caching forever, and expose clear() for
  // the paths that run a compress in-process. Soft-capped against unbounded
  // growth as tips advance.
  private _stateLineageCache = new Map<number, { states: number[]; at: number }>();
  private static readonly STATE_LINEAGE_CACHE_MAX = 512;
  private static readonly STATE_LINEAGE_TTL_MS = 60_000;
  private _logger: Logger;

  private constructor(config: ConnectionConfig, connection: IDatabaseConnection) {
    this.config = config;
    this.connection = connection;
    this._logger = config.logger ?? consoleLogger;
    // Route the parser's "unsupported geometry" warnings through the same
    // logger. Process-wide; see setParserLogger doc.
    setParserLogger(this._logger);
  }

  /**
   * Get the logger configured for this geodatabase.
   * Used internally by EditSession etc. — exposed so consumers can also
   * route library warnings through the same pipeline.
   */
  get logger(): Logger {
    return this._logger;
  }

  /**
   * Connect to an enterprise geodatabase
   */
  static async connect(config: ConnectionConfig): Promise<EnterpriseGeodatabase> {
    let connection: IDatabaseConnection;

    if (config.driver === 'sqlserver') {
      connection = new SqlServerConnection({
        ...config,
        driver: 'sqlserver',
      });
    } else if (config.driver === 'postgresql') {
      connection = new PostgreSQLConnection({
        ...config,
        driver: 'postgresql',
      });
    } else {
      throw new Error(`Unsupported driver: ${config.driver}`);
    }

    await connection.connect();

    const egdb = new EnterpriseGeodatabase(config, connection);

    // Verify it's a valid geodatabase
    await egdb.verifyGeodatabase();

    return egdb;
  }

  /**
   * Get the geodatabase version
   */
  get version(): string | null {
    return this._version;
  }

  /**
   * Get the connection source (without password)
   */
  get source(): string {
    return `${this.config.driver}://${this.config.user}@${this.config.server}:${this.config.port ?? (this.config.driver === 'sqlserver' ? 1433 : 5432)}/${this.config.database}`;
  }

  /**
   * Get the underlying database connection
   */
  getConnection(): IDatabaseConnection {
    return this.connection;
  }

  /**
   * Verify this is a valid enterprise geodatabase
   */
  private async verifyGeodatabase(): Promise<void> {
    try {
      // PostgreSQL uses lowercase column names
      const sql = this.config.driver === 'sqlserver'
        ? 'SELECT MAJOR, MINOR, BUGFIX FROM sde.SDE_version'
        : 'SELECT major as "MAJOR", minor as "MINOR", bugfix as "BUGFIX" FROM sde.sde_version';

      const rows = await this.connection.query<{
        MAJOR: number;
        MINOR: number;
        BUGFIX: number;
      }>(sql);

      if (rows.length > 0) {
        const row = rows[0]!;
        this._version = `${row.MAJOR}.${row.MINOR}.${row.BUGFIX}`;
      }
    } catch (error) {
      throw new Error(
        `Not a valid enterprise geodatabase: sde.SDE_version table not found. ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * List all tables and feature classes
   */
  async listTables(): Promise<TableInfo[]> {
    if (this._tables) return this._tables;

    // PhysicalName format: DATABASE.SCHEMA.TABLE (e.g., PARCEL_FABRIC.PA.PARCELFABRIC_PARCELS)
    // SDE_table_registry uses: SCHEMA.TABLE (e.g., PA.PARCELFABRIC_PARCELS)
    // We extract SCHEMA.TABLE from PhysicalName by removing the first segment (database name)
    const sql = this.config.driver === 'sqlserver'
      ? `
        SELECT
          i.ObjectID,
          i.UUID,
          t.Name as TypeName,
          i.Name,
          i.PhysicalName,
          i.Path,
          i.DatasetSubtype1,
          i.DatasetSubtype2,
          i.DatasetInfo1,
          i.DatasetInfo2,
          r.registration_id as RegistrationId,
          CASE WHEN r.object_flags & 8 = 8 THEN 1 ELSE 0 END as IsVersioned
        FROM sde.GDB_ITEMS i
        JOIN sde.GDB_ITEMTYPES t ON i.Type = t.UUID
        LEFT JOIN sde.SDE_table_registry r ON
          UPPER(r.owner + '.' + r.table_name) =
          UPPER(SUBSTRING(i.PhysicalName, CHARINDEX('.', i.PhysicalName) + 1, LEN(i.PhysicalName)))
        WHERE t.Name IN ('Table', 'Feature Class')
        ORDER BY i.Name
      `
      : `
        SELECT
          i.objectid as "ObjectID",
          i.uuid as "UUID",
          t.name as "TypeName",
          i.name as "Name",
          i.physicalname as "PhysicalName",
          i.path as "Path",
          i.datasetsubtype1 as "DatasetSubtype1",
          i.datasetsubtype2 as "DatasetSubtype2",
          i.datasetinfo1 as "DatasetInfo1",
          i.datasetinfo2 as "DatasetInfo2",
          r.registration_id as "RegistrationId",
          CASE WHEN r.object_flags & 8 = 8 THEN 1 ELSE 0 END as "IsVersioned"
        FROM sde.gdb_items i
        JOIN sde.gdb_itemtypes t ON i.type = t.uuid
        LEFT JOIN sde.sde_table_registry r ON
          UPPER(r.owner || '.' || r.table_name) =
          UPPER(SUBSTRING(i.physicalname FROM POSITION('.' IN i.physicalname) + 1))
        WHERE t.name IN ('Table', 'Feature Class')
        ORDER BY i.name
      `;

    const rows = await this.connection.query<GdbItemRow & { TypeName: string; RegistrationId?: number; IsVersioned?: number }>(sql);

    // Convert TypeName to Type UUID for parser and include versioning info
    const itemRows: GdbItemRow[] = rows.map((row) => ({
      ...row,
      Type:
        row.TypeName === 'Feature Class'
          ? 'CA1C6E90-7896-4692-AA21-F8BB7063C4AD'
          : '77C1E6B3-9EB4-4A1D-B686-E1CADD1E3ADA',
    }));

    const tables = parseGdbItems(itemRows);

    // Add registration ID and versioning info
    this._tables = tables.map((table, i) => ({
      ...table,
      registrationId: rows[i]?.RegistrationId,
      isVersioned: rows[i]?.IsVersioned === 1,
    }));

    return this._tables;
  }

  /**
   * Open a table for reading
   */
  async openTable(name: string): Promise<EnterpriseTable> {
    const tables = await this.listTables();
    const tableInfo = tables.find(
      (t) =>
        t.name.toLowerCase() === name.toLowerCase() ||
        t.physicalName.toLowerCase() === name.toLowerCase()
    );

    if (!tableInfo) {
      throw new Error(`Table not found: ${name}`);
    }

    // Cache by canonical name so re-opening the same table (every parcel
    // click opens Parcels/Lines/Points) skips the multi-round-trip metadata
    // load. listTables() above is already cached, so the lookup is cheap.
    const key = tableInfo.name.toLowerCase();
    const cached = this._tableCache.get(key);
    if (cached) return cached;

    const opening = this.buildTable(tableInfo);
    this._tableCache.set(key, opening);
    opening.catch(() => this._tableCache.delete(key));
    return opening;
  }

  /**
   * Drop a cached table so the next openTable() reloads its metadata. Call
   * after a live schema change (ALTER TABLE / re-registration); otherwise a
   * table's fields and featureCount stay frozen for the connection's lifetime.
   */
  evictTable(name: string): void {
    this._tableCache.delete(name.toLowerCase());
  }

  /** Resolve a table's version wiring and open it (no caching). */
  private async buildTable(tableInfo: TableInfo): Promise<EnterpriseTable> {
    // Check for enterprise versioned view if table is versioned
    if (tableInfo.isVersioned && !tableInfo.evwViewName) {
      tableInfo.evwViewName = await this.getEvwViewName(tableInfo.name) ?? undefined;
    }

    // Pass state lineage getter for versioned queries
    const getStateLineage = tableInfo.isVersioned
      ? (version: string) => this.getVersionStateLineage(version)
      : undefined;

    // Pass version setter for evw view queries
    const setVersion = tableInfo.evwViewName
      ? (version: string) => this.setCurrentVersion(version)
      : undefined;

    return EnterpriseTable.open(this.connection, tableInfo, getStateLineage, setVersion);
  }

  /**
   * Open a SQL view as a read-only EnterpriseTable. Views are not
   * registered in `sde.GDB_ITEMS` / `sde.SDE_table_registry`, so
   * `openTable` can't find them. Callers identify the view by
   * schema-qualified name and supply the geometry column (since views
   * don't carry SDE shape-column metadata).
   *
   * Returned handle is read-only: insert/update/delete throw rather
   * than issuing SQL. Writes against an updatable view would silently
   * bypass A/D tables, version bookkeeping, and editor tracking - a
   * footgun avoided by refusing them at the library layer.
   *
   * @param qualifiedName Exactly two parts joined by a single dot:
   *   `"<schema>.<name>"` (e.g. `"pa.CAMASALESview"`). Three-part
   *   `db.schema.name` and bare names are rejected. **Postgres folds
   *   unquoted identifiers to lower case** at create time, so a view
   *   created as `MySchema.MyView` lives as `myschema.myview` - pass
   *   the lower-cased form to `openView`.
   * @param opts.shapeFieldName Geometry column name on the view (e.g.
   *   `"Shape"`, `"shape"`). Omit for non-spatial views.
   * @param opts.geometryType Optional ArcGIS geometry-type hint for
   *   downstream consumers.
   */
  async openView(
    qualifiedName: string,
    opts: { shapeFieldName?: string; geometryType?: GeometryType } = {},
  ): Promise<EnterpriseTable> {
    const parts = qualifiedName.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `openView: expected exactly two-part name "<schema>.<name>", got "${qualifiedName}". `
        + 'Three-part db.schema.name and bare names are not accepted.',
      );
    }
    const [schema, name] = parts as [string, string];

    // Existence check up front so the caller gets a clear error rather
    // than an opaque COUNT(*) failure later inside loadMetadata().
    const driver = this.config.driver;
    const exists = await this.viewOrTableExists(driver === 'sqlserver' ? 'sqlserver' : 'postgres', schema, name);
    if (!exists) {
      throw new Error(`openView: view not found: ${schema}.${name}`);
    }

    // physicalName mirrors openTable's per-driver convention: SQL
    // Server stores db.schema.name, Postgres stores schema.name. Not
    // load-bearing here (no GDB_ITEMS lookup will succeed for a view),
    // but consistent with the rest of the codebase.
    const physicalName = driver === 'sqlserver'
      ? `${this.config.database}.${schema}.${name}`
      : `${schema}.${name}`;

    const tableInfo: TableInfo = {
      name,
      physicalName,
      schema,
      isFeatureClass: !!opts.shapeFieldName,
      shapeFieldName: opts.shapeFieldName,
      geometryType: opts.geometryType,
      isVersioned: false,
      readOnly: true,
    };
    return EnterpriseTable.open(this.connection, tableInfo);
  }

  /**
   * Existence probe for openView. Looks in INFORMATION_SCHEMA on both
   * engines so we don't depend on SDE catalog rows that views lack.
   */
  private async viewOrTableExists(
    driver: 'sqlserver' | 'postgres',
    schema: string,
    name: string,
  ): Promise<boolean> {
    const sql = driver === 'sqlserver'
      ? `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.VIEWS
         WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1`
      : `SELECT COUNT(*) AS "n" FROM information_schema.views
         WHERE table_schema = $1 AND table_name = $2`;
    const rows = await this.connection.query<{ n: number | string }>(sql, [schema, name]);
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /**
   * List geodatabase versions
   */
  async listVersions(): Promise<VersionInfo[]> {
    // SDE_versions.creation_time is naive wall-clock in the SERVER's time zone.
    // When the caller tells us that zone, convert it to true UTC here so callers
    // (and their UI) don't apply the offset a second time -- see
    // ConnectionConfig.serverTimeZone. DST is handled per row by AT TIME ZONE,
    // so a February row resolves at -05:00 and a July row at -04:00. Unset =>
    // return the column untouched (previous behaviour).
    const tz = this.config.serverTimeZone;
    const creationTimeExpr = tz
      ? (this.config.driver === 'sqlserver'
        ? `CAST(creation_time AT TIME ZONE @p0 AT TIME ZONE 'UTC' AS datetime2(3)) AS creation_time`
        : `(creation_time AT TIME ZONE $1) AS creation_time`)
      : 'creation_time';
    const params = tz ? [tz] : [];

    const sql = this.config.driver === 'sqlserver'
      ? `
        SELECT
          name,
          owner,
          description,
          parent_name,
          ${creationTimeExpr},
          state_id
        FROM sde.SDE_versions
        ORDER BY name
      `
      : `
        SELECT
          name,
          owner,
          description,
          parent_name,
          ${creationTimeExpr},
          state_id
        FROM sde.sde_versions
        ORDER BY name
      `;

    try {
      const rows = await this.connection.query<{
        name: string;
        owner: string;
        description?: string;
        parent_name?: string;
        creation_time?: Date;
        state_id?: number | bigint;
      }>(sql, params);

      return rows.map((row) => ({
        name: row.name,
        owner: row.owner,
        description: row.description,
        parentName: row.parent_name,
        createTime: row.creation_time,
        stateId: row.state_id != null ? Number(row.state_id) : undefined,
      }));
    } catch {
      // Not all geodatabases have versioning enabled
      return [];
    }
  }

  /**
   * Get version info by name
   * @param versionName Version name in format "owner.name" or just "name"
   */
  async getVersion(versionName: string): Promise<VersionInfo | null> {
    const versions = await this.listVersions();

    // Parse version name (can be "owner.name" or just "name")
    let owner: string;
    let name: string;

    const dotIndex = versionName.indexOf('.');
    if (dotIndex !== -1) {
      owner = versionName.substring(0, dotIndex);
      name = versionName.substring(dotIndex + 1);
    } else {
      // Default to sde owner for unqualified names
      owner = 'sde';
      name = versionName;
    }

    return versions.find(
      v => v.owner.toLowerCase() === owner.toLowerCase() &&
           v.name.toLowerCase() === name.toLowerCase()
    ) || null;
  }

  /**
   * Get state lineage for a version (all state IDs that are ancestors of this version's state)
   * Used internally for versioned queries.
   * @param versionName Version name in format "owner.name" or just "name"
   * @returns Array of state IDs in the lineage, or null if version not found
   */
  async getVersionStateLineage(versionName: string): Promise<number[] | null> {
    const version = await this.getVersion(versionName);
    if (!version?.stateId) return null;

    // Ancestry comes from the physical state tree (SDE_states.parent_state_id),
    // NOT the SDE_state_lineages closure. The closure is sparsely populated in
    // real fabrics (see getStatesInRange in reconcile/find-ancestor.ts) and drops
    // ArcMap-authored edit states, so closure-based reads made a version's own
    // edits invisible (e.g. 98 subdivision parcels ArcMap posted into DEFAULT).
    // The parent chain is the complete ancestry ArcMap reads through.
    //
    // This returns the edit-state ancestry only (state 0 / the base table is not
    // a lineage member). buildVersionedQuery keys base-row shadowing off the
    // delete markers' DELETED_AT (the edit state a row was superseded in), which
    // is always one of these ancestry states, so state 0 is not needed here.
    //
    // Memoized by tip state id — the ancestry is immutable (append-only states),
    // so this is safe with no invalidation. Big win now that all reads are
    // versioned: the recursive-CTE walk runs once per tip instead of per read.
    const tip = version.stateId;
    const cached = this._stateLineageCache.get(tip);
    if (cached && Date.now() - cached.at < EnterpriseGeodatabase.STATE_LINEAGE_TTL_MS) {
      return cached.states;
    }
    const lineage = await getStatesInRange(this.connection, tip, 0);
    if (this._stateLineageCache.size >= EnterpriseGeodatabase.STATE_LINEAGE_CACHE_MAX) {
      // Cheap eviction: drop the oldest insertion (Map preserves insertion order).
      const oldest = this._stateLineageCache.keys().next().value;
      if (oldest !== undefined) this._stateLineageCache.delete(oldest);
    }
    this._stateLineageCache.set(tip, { states: lineage, at: Date.now() });
    return lineage;
  }

  /**
   * Revert specific features within a version back to their parent state, by
   * physically removing their A-table rows and D-table delete-markers from the
   * version's OWN edit states (the states between its common ancestor with its
   * parent and its tip). Unlike a normal edit, this creates no new state and
   * leaves NO edit behind for those features -- so they drop out of the version
   * diff AND out of a subsequent post, as if the edit never happened. This is
   * the clean primitive behind a per-operation "reverse": delete what an
   * operation created, un-retire what it retired, undo what it mutated -- all by
   * the same "remove this feature's edits" action.
   *
   * The caller MUST revert a topologically-complete set (e.g. a parcel and all
   * its lines/points) -- this primitive reverts exactly the OBJECTIDs given and
   * does not chase references.
   *
   * SAFETY: runs under an exclusive version lock and re-validates inside it
   * (the version tip can advance between calls). It refuses (throws) if any of
   * the version's edit states are (a) shared with / forked into another version,
   * or (b) held by a live edit session (SDE_state_locks), since deleting their
   * rows would corrupt that version or destroy unsaved edits. The caller should
   * additionally serialise app-level (a version mutex + no open edit session).
   *
   * @param versionName  owner.name of the (non-root) version to edit.
   * @param features     the features to revert, by table name + OBJECTID.
   * @returns the count reverted and the state ids that were touched.
   */
  async revertFeatures(
    versionName: string,
    features: ReadonlyArray<{ table: string; objectId: number }>,
  ): Promise<{ reverted: number; states: number[] }> {
    if (features.length === 0) return { reverted: 0, states: [] };

    const v0 = await this.getVersion(versionName);
    if (!v0?.stateId) throw new Error(`Version not found or has no state: ${versionName}`);
    if (!v0.parentName) throw new Error(`Cannot revert features in a root version: ${versionName}`);

    const conn = this.connection;

    // Resolve each table's registration metadata once (read-only).
    const allTables = await this.listTables();
    const tableInfoByName = new Map<string, TableInfo>();
    for (const f of features) {
      const key = f.table.toLowerCase();
      if (tableInfoByName.has(key)) continue;
      const ti = allTables.find(
        t => t.name.toLowerCase() === key || t.physicalName.toLowerCase() === key,
      );
      if (!ti) throw new Error(`Table not found: ${f.table}`);
      tableInfoByName.set(key, ti);
    }

    const wasInTx = conn.inTransaction();
    if (!wasInTx) await conn.beginTransaction();
    try {
      // Serialise against concurrent posts/reverts on this version; held to
      // commit/rollback. Then re-read the tip + parent INSIDE the lock (they may
      // have advanced since the pre-lock read) and validate before deleting.
      await this.lockVersion(versionName);

      const version = await this.getVersion(versionName);
      if (!version?.stateId) throw new Error(`Version vanished under lock: ${versionName}`);
      const parent = version.parentName ? await this.getVersion(version.parentName) : null;
      if (!parent?.stateId) throw new Error(`Parent version not found: ${version.parentName}`);

      const ancestor = await findCommonAncestor(conn, version.stateId, parent.stateId);
      const childOnlyStates = await getStatesInRange(conn, version.stateId, ancestor);
      if (childOnlyStates.length === 0) {
        if (!wasInTx) await conn.commitTransaction();
        return { reverted: 0, states: [] };
      }

      // Refuse if any edit state is visible to another version (shared) or has a
      // fork off it. The fork branch also covers a concurrent edit session: a
      // live session forks a new child state off this version's tip (via
      // SDE_state_new_edit, which wires the lineage), so that fork is flagged. We
      // deliberately do NOT also union readLockedBranches: a version's OWN
      // committed edits leave SDE_state_new_edit locks on their states, which
      // would false-positive every normal revert. Callers also hold an app-level
      // version mutex + assert no open edit session.
      const blocked = (await findExternallyReferencedStates(conn, version.owner, version.name, childOnlyStates))
        .sort((a, b) => a - b);
      if (blocked.length > 0) {
        throw new Error(
          `Refusing to revert features in ${versionName}: edit state(s) ${blocked.join(', ')} ` +
          `are shared with or forked by another version. Reconcile/post or close that version first.`,
        );
      }

      for (const f of features) {
        const ti = tableInfoByName.get(f.table.toLowerCase())!;
        for (const stateId of childOnlyStates) {
          await removeFromATable(conn, ti, f.objectId, stateId);
          await removeFromDTable(conn, ti, f.objectId, stateId);
        }
      }
      if (!wasInTx) await conn.commitTransaction();
      return { reverted: features.length, states: childOnlyStates };
    } catch (e) {
      if (!wasInTx) await conn.rollbackTransaction();
      throw e;
    }
  }

  /**
   * Set the current version context for the database session.
   * This affects queries on enterprise versioned views (*_evw).
   *
   * @param versionName Version name (e.g., "sde.DEFAULT" or just "DEFAULT")
   */
  async setCurrentVersion(versionName: string): Promise<void> {
    // Parse version name
    let fullName = versionName;
    if (!versionName.includes('.')) {
      fullName = `sde.${versionName}`;
    }

    const sql = this.config.driver === 'sqlserver'
      ? `EXEC sde.set_current_version @p0`
      : `SELECT sde.set_current_version($1)`;

    await this.connection.query(sql, [fullName]);
  }

  /**
   * Get the current view state ID for the session.
   * This is the state ID that versioned views will use.
   */
  async getCurrentViewState(): Promise<number | null> {
    const sql = this.config.driver === 'sqlserver'
      ? `SELECT sde.SDE_get_view_state() as state_id`
      : `SELECT sde.sde_get_view_state() as state_id`;

    try {
      const rows = await this.connection.query<{ state_id: number }>(sql);
      return rows[0]?.state_id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if an enterprise versioned view (*_evw) exists for a table.
   *
   * @param tableName Table name
   * @returns The evw view name if it exists, null otherwise
   */
  async getEvwViewName(tableName: string): Promise<string | null> {
    const evwName = `${tableName}_evw`;

    const sql = this.config.driver === 'sqlserver'
      ? `SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_NAME = @p0`
      : `SELECT table_schema, table_name FROM information_schema.views WHERE table_name = $1`;

    const rows = await this.connection.query<Record<string, string>>(
      sql,
      [evwName]
    );

    if (rows.length > 0) {
      const row = rows[0]!;
      // Handle both SQL Server (uppercase) and PostgreSQL (lowercase) column names
      const schema = row.TABLE_SCHEMA ?? row.table_schema;
      const name = row.TABLE_NAME ?? row.table_name;
      return `${schema}.${name}`;
    }

    return null;
  }

  // ============================================================
  // VERSION MANAGEMENT
  // ============================================================

  /**
   * Version access levels
   */
  static readonly VersionAccess = {
    /** Anyone can read and write */
    PUBLIC: 0,
    /** Anyone can read, only owner can write */
    PROTECTED: 1,
    /** Only owner can read and write */
    PRIVATE: 2,
  } as const;

  /**
   * Version naming rules
   */
  static readonly VersionNameRule = {
    /** Use the exact name provided */
    EXACT: 1,
    /** Make name unique by appending a number if needed */
    UNIQUE: 2,
  } as const;

  /**
   * Create a new geodatabase version.
   *
   * @param name Version name (will be prefixed with current user)
   * @param options Creation options
   * @returns The created version info
   *
   * @example
   * ```typescript
   * const version = await egdb.createVersion('my_edits', {
   *   parent: 'sde.DEFAULT',
   *   access: EnterpriseGeodatabase.VersionAccess.PRIVATE,
   *   description: 'My editing session'
   * });
   * ```
   */
  async createVersion(
    name: string,
    options?: {
      /** Parent version (default: 'sde.DEFAULT') */
      parent?: string;
      /** Access level (default: PRIVATE) */
      access?: 0 | 1 | 2;
      /** Version description */
      description?: string;
      /** Naming rule (default: EXACT) */
      nameRule?: 1 | 2;
    }
  ): Promise<VersionInfo> {
    const parent = options?.parent ?? 'sde.DEFAULT';
    const access = options?.access ?? EnterpriseGeodatabase.VersionAccess.PRIVATE;
    const description = options?.description ?? '';
    const nameRule = options?.nameRule ?? EnterpriseGeodatabase.VersionNameRule.EXACT;

    if (this.config.driver === 'sqlserver') {
      // SQL Server uses stored procedure with INOUT parameter for name
      // The procedure may modify the name if nameRule is UNIQUE
      await this.connection.query(
        `EXEC sde.create_version @p0, @p1, @p2, @p3, @p4`,
        [parent, name, nameRule, access, description]
      );
    } else {
      // PostgreSQL
      await this.connection.query(
        `SELECT sde.create_version($1, $2, $3, $4, $5)`,
        [parent, name, nameRule, access, description]
      );
    }

    // Fetch the created version info
    // The version owner will be the current database user (which may differ from login user)
    // We need to search by name across all owners
    const versions = await this.listVersions();
    const createdVersion = versions.find(
      v => v.name.toLowerCase() === name.toLowerCase()
    );

    if (!createdVersion) {
      throw new Error(`Version created but not found: ${name}`);
    }
    return createdVersion;
  }

  /**
   * Delete a geodatabase version.
   *
   * The version must have no child versions and must not be the DEFAULT version.
   *
   * @param versionName Version name (e.g., "user.version_name")
   */
  async deleteVersion(versionName: string): Promise<void> {
    // Ensure full name format
    let fullName = versionName;
    if (!versionName.includes('.')) {
      fullName = `${this.config.user}.${versionName}`;
    }

    if (this.config.driver === 'sqlserver') {
      await this.connection.query(`EXEC sde.delete_version @p0`, [fullName]);
    } else {
      await this.connection.query(`SELECT sde.delete_version($1)`, [fullName]);
    }
  }

  /**
   * Start an editing session on a version.
   *
   * This locks the version for editing and creates a new state for changes.
   * You must call stopEditing() when done.
   *
   * @param versionName Version name to edit
   */
  async startEditing(versionName: string): Promise<void> {
    let fullName = versionName;
    if (!versionName.includes('.')) {
      fullName = `sde.${versionName}`;
    }

    if (this.config.driver === 'sqlserver') {
      // edit_action: 1 = start editing
      await this.connection.query(`EXEC sde.edit_version @p0, 1`, [fullName]);
    } else {
      await this.connection.query(`SELECT sde.edit_version($1, 1)`, [fullName]);
    }
  }

  /**
   * Stop an editing session on a version.
   *
   * The edit_version procedure only supports: 1 = start, 2 = end.
   * To discard changes, rollback the transaction before calling this method.
   *
   * @param versionName Version name being edited
   * @param _saveChanges Unused - discard requires transaction rollback before this call
   */
  async stopEditing(versionName: string, _saveChanges: boolean = true): Promise<void> {
    let fullName = versionName;
    if (!versionName.includes('.')) {
      fullName = `sde.${versionName}`;
    }

    if (this.config.driver === 'sqlserver') {
      // edit_action: 1 = start editing, 2 = end editing
      await this.connection.query(`EXEC sde.edit_version @p0, @p1`, [fullName, 2]);
    } else {
      await this.connection.query(`SELECT sde.edit_version($1, 2)`, [fullName]);
    }
  }

  /**
   * Reconcile a version with its parent.
   *
   * This brings changes from the parent version into this version.
   * Conflicts may occur if the same features were edited in both versions.
   *
   * @param versionName Version to reconcile
   * @param options Reconcile options
   * @returns Reconcile result with conflict information
   *
   * @example
   * ```typescript
   * // Basic reconcile with default settings (favor_edit)
   * const result = await egdb.reconcileVersion('myuser.edit_version');
   *
   * // Reconcile with auto-merge enabled
   * const result = await egdb.reconcileVersion('myuser.edit_version', {
   *   autoMerge: true,
   *   conflictResolution: 'favor_edit'
   * });
   *
   * // Detect conflicts only without applying
   * const result = await egdb.reconcileVersion('myuser.edit_version', {
   *   detectOnly: true
   * });
   *
   * // With custom conflict resolver
   * const result = await egdb.reconcileVersion('myuser.edit_version', {
   *   resolveConflict: async (conflict) => {
   *     console.log(`Conflict on ${conflict.table} OID ${conflict.objectId}`);
   *     return 'favor_edit'; // or 'favor_target' or 'merge'
   *   }
   * });
   * ```
   */
  async reconcileVersion(
    versionName: string,
    options?: ReconcileOptions
  ): Promise<ReconcileResult> {
    const opts: ReconcileOptions = {
      conflictResolution: 'favor_edit',
      abortOnConflict: false,
      detectOnly: false,
      autoMerge: true,
      ...options,
    };

    // Get version info
    const version = await this.getVersion(versionName);
    if (!version) {
      throw new Error(`Version not found: ${versionName}`);
    }
    if (!version.stateId) {
      throw new Error(`Version ${versionName} has no state ID`);
    }

    if (!version.parentName) {
      throw new Error(`Version ${versionName} has no parent to reconcile with`);
    }

    // Get parent version info
    const parentFullName = version.parentName.includes('.')
      ? version.parentName
      : `sde.${version.parentName}`;
    const parent = await this.getVersion(parentFullName);
    if (!parent) {
      throw new Error(`Parent version not found: ${parentFullName}`);
    }
    if (!parent.stateId) {
      throw new Error(`Parent version ${parentFullName} has no state ID`);
    }

    // 1. Find common ancestor state
    const commonAncestor = await findCommonAncestor(
      this.connection,
      version.stateId,
      parent.stateId
    );

    // 2. Get states in range for both versions
    const childStates = await getStatesInRange(
      this.connection,
      version.stateId,
      commonAncestor
    );
    const parentStates = await getStatesInRange(
      this.connection,
      parent.stateId,
      commonAncestor
    );

    // Exclude the common ancestor from both lists
    const childOnlyStates = childStates.filter(s => s > commonAncestor);
    const parentOnlyStates = parentStates.filter(s => s > commonAncestor);

    // 3. Get all tables
    const tables = await this.listTables();
    const versionedTables = tables.filter(t => t.isVersioned);

    // 4. Get changes from both versions
    const childChanges = await getAllChanges(this.connection, versionedTables, childOnlyStates);
    const parentChanges = await getAllChanges(this.connection, versionedTables, parentOnlyStates);

    // 5. Detect conflicts
    const conflicts = await detectDetailedConflicts(
      this.connection,
      versionedTables,
      childChanges,
      parentChanges
    );

    const summary = getConflictsSummary(conflicts);

    // Check if we should abort
    if (opts.abortOnConflict && summary.totalConflicts > 0) {
      return {
        hasConflicts: true,
        conflictCount: summary.totalConflicts,
        conflicts,
        applied: false,
        commonAncestorStateId: commonAncestor,
        parentChangesApplied: 0,
        mergedCount: 0,
      };
    }

    // If detectOnly, return without applying
    if (opts.detectOnly) {
      return {
        hasConflicts: summary.totalConflicts > 0,
        conflictCount: summary.totalConflicts,
        conflicts,
        applied: false,
        commonAncestorStateId: commonAncestor,
        parentChangesApplied: 0,
        mergedCount: 0,
      };
    }

    // 6 + 7. Apply parent changes and extend the child's lineage inside
    // a transaction so a mid-apply failure cannot leave the version
    // half-reconciled (some A/D writes succeeded, lineage not extended,
    // no rollback). Skip the wrap when the caller already started a
    // transaction so we don't try to nest one — same shape as the
    // existing `transaction()` helper.
    // Capture narrowed values before the closure: TypeScript's narrowing
    // from the early `!version.stateId` guard does not cross into nested
    // arrow functions.
    const childStateId = version.stateId;
    // Look up the actual lineage_name from SDE_states — do NOT conflate it
    // with state_id. createChildState (via SDE_state_new_edit) gives the child
    // the PARENT's lineage_name, and ArcGIS-Pro-authored states likewise use a
    // separate tree identifier (Putnam empirical: state 25066 has lineage_name
    // 24542). Using childStateId as the lineage_name inserts the parent's
    // states under the WRONG lineage tree, and the child's closure silently
    // does NOT gain the parent's tip.
    const childLineageName = await getLineageName(this.connection, childStateId);

    const runApply = async () => {
      const result = await applyParentChanges(
        this.connection,
        versionedTables,
        parentChanges,
        conflicts,
        childStateId,
        opts
      );
      await addStatesToLineage(this.connection, childLineageName, parentOnlyStates);
      return result;
    };

    let appliedCount: number;
    let mergedCount: number;
    if (this.connection.inTransaction()) {
      const r = await runApply();
      appliedCount = r.appliedCount;
      mergedCount = r.mergedCount;
    } else {
      await this.connection.beginTransaction();
      try {
        const r = await runApply();
        appliedCount = r.appliedCount;
        mergedCount = r.mergedCount;
        await this.connection.commitTransaction();
      } catch (error) {
        try {
          await this.connection.rollbackTransaction();
        } catch (rollbackError) {
          // Surface the original cause but log the rollback failure too.
          console.error('reconcile rollback failed:', rollbackError);
        }
        throw error;
      }
    }

    return {
      hasConflicts: summary.totalConflicts > 0,
      conflictCount: summary.totalConflicts,
      conflicts,
      applied: true,
      commonAncestorStateId: commonAncestor,
      parentChangesApplied: appliedCount,
      mergedCount,
    };
  }

  /**
   * Post changes from a version to its parent.
   *
   * This pushes all changes from the child version into the parent.
   * The version must be reconciled first (child's lineage must include parent's current state).
   *
   * @param versionName Version to post
   * @param options Post options
   * @returns Post result
   *
   * @example
   * ```typescript
   * // Reconcile first, then post
   * await egdb.reconcileVersion('myuser.edit_version');
   * const result = await egdb.postVersion('myuser.edit_version');
   * console.log(`Posted ${result.changesPosted} changes`);
   *
   * // Post and delete the version after
   * await egdb.postVersion('myuser.edit_version', {
   *   deleteVersionAfterPost: true
   * });
   * ```
   */
  async postVersion(
    versionName: string,
    options?: PostOptions
  ): Promise<PostResult> {
    const version = await this.getVersion(versionName);
    if (!version) {
      throw new Error(`Version not found: ${versionName}`);
    }
    if (!version.stateId) {
      throw new Error(`Version ${versionName} has no state ID`);
    }

    if (!version.parentName) {
      throw new Error(`Cannot post DEFAULT version - it has no parent`);
    }

    const parentFullName = version.parentName.includes('.')
      ? version.parentName
      : `sde.${version.parentName}`;

    // Post is the only writer that mutates the parent's state pointer, so we
    // serialize concurrent posts to the same parent with an exclusive lock.
    // pg_advisory_xact_lock is transaction-scoped, so the lock + the work need
    // to share a transaction. sp_getapplock with @LockOwner='Transaction' has
    // the same property, so the same shape works for both drivers.
    await this.connection.beginTransaction();
    try {
      await this.lockVersion(parentFullName);

      // Re-fetch parent INSIDE the lock — its state_id may have advanced
      // between getVersion above and lock acquisition.
      const parent = await this.getVersion(parentFullName);
      if (!parent) {
        throw new Error(`Parent version not found: ${parentFullName}`);
      }
      if (!parent.stateId) {
        throw new Error(`Parent version ${parentFullName} has no state ID`);
      }

      // Re-verify reconciliation under the lock. If another session posted
      // to the parent after our caller's reconcile, child.stateId is no
      // longer a descendant of parent.stateId and we must abort.
      const reconciled = await isReconciled(
        this.connection,
        version.stateId,
        parent.stateId
      );
      if (!reconciled) {
        throw new Error(
          `Version ${versionName} is no longer reconciled with ${parentFullName}. ` +
            `Parent was modified by another post. Reconcile again before retrying.`
        );
      }

      const tables = await this.listTables();
      const versionedTables = tables.filter(t => t.isVersioned);

      // Count the version's posted changes over the states between the common
      // ancestor and the version tip -- the same reliable range the reverse path
      // uses. (getChildUniqueStates was returning empty for some reconciled
      // versions, so changesPosted came back 0 even though the post landed.)
      const ancestor = await findCommonAncestor(this.connection, version.stateId, parent.stateId);
      const childStates = await getStatesInRange(this.connection, version.stateId, ancestor);
      const changesPosted = await countChangesInStates(this.connection, versionedTables, childStates);

      // Two post strategies:
      //
      // trimPost (ArcMap-style, closure-correct): create a NEW state on
      // DEFAULT's OWN lineage via SDE_state_new_edit (which maintains the
      // SDE_state_lineages closure) and replay the version's net deltas into
      // it. DEFAULT's closure stays == its parent_state_id ancestry, so Esri
      // *_evw views / the publish ETL / ArcGIS (all resolve versions via the
      // closure) see the posted edits. See handoff/DURABLE_CLOSURE_FIX_PLAN.md
      // and memory project_publish_etl_closure_gap.
      //
      // Legacy repoint (default, being phased out): advances DEFAULT's pointer
      // onto the child's tip with ZERO row copying. Immutable + cheap, and
      // egdb's own parent_state_id reader resolves it -- but it does NOT write
      // the closure rows, so every closure-based Esri reader silently misses
      // the post. Kept behind the flag for rollback during rollout.
      let postTargetState: number;
      if (options?.trimPost) {
        const newTip = await createChildState(this.connection, parent.stateId);
        // SDE_state_new_edit places an exclusive lock on the new state. Unlike
        // an EditSession's transient edit state, this state becomes DEFAULT's
        // permanent tip, so the lock must be cleared -- a stuck lock blocks
        // future edits and makes compress skip the branch. Clear by state_id
        // (mirrors deleteChildState) since SDE_state_new_edit owns the lock
        // under its own connection sde_id, which createChildState doesn't return.
        await this.connection.execute(
          this.connection.driver === 'sqlserver'
            ? `DELETE FROM sde.SDE_state_locks WHERE state_id = @p0`
            : `DELETE FROM sde.sde_state_locks WHERE state_id = $1`,
          [newTip]
        );
        // getAllChanges now yields the TIP (MAX SDE_STATE_ID) A/D row per
        // OBJECTID (get-changes.ts orders ascending, Map keeps last), so each
        // copy reproduces the version's resolved content, not an arbitrary
        // earlier state. Every A-row copy MUST move exactly one row -- a 0-row
        // copy would leave a bare delete marker with no A-row (a vanished
        // feature), so we assert it loudly rather than commit a phantom post.
        const changes = await getAllChanges(this.connection, versionedTables, childStates);
        const copyOrThrow = async (t: TableInfo, oid: number, from: number) => {
          const n = await copyATableRow(this.connection, t, oid, from, newTip);
          if (n !== 1) {
            throw new Error(
              `Trim post failed to copy A-row for ${t.name} OBJECTID ${oid} from state ${from} ` +
              `(rows affected = ${n}, expected 1). The post was NOT published.`
            );
          }
        };
        for (const c of [...changes.inserts, ...changes.updates, ...changes.deletes]) {
          const t = versionedTables.find(vt => vt.name === c.table);
          if (!t) continue;
          if (c.changeType === 'insert' || c.changeType === 'update') {
            // Both just copy the version's TIP a-row to newTip. An UPDATE needs
            // NO delete marker at newTip: the superseded BASE row is hidden by
            // emitBaseShadowMarkers' state-0 marker (below), and a prior a-row is
            // superseded by MAX-state resolution. Emitting a (newTip) marker here
            // would collide with the copied a-row -- egdb's own reader tolerates
            // it (it only suppresses a delete at a state > the add), but Esri's
            // *_evw / the publish ETL suppress on SDE_STATE_ID = the add's state,
            // so the retired row would vanish from the published layer.
            await copyOrThrow(t, c.objectId, c.stateId);
          } else {
            // Pure delete: the edit-state marker is what egdb's reader honors
            // (base-half keys on DELETED_AT); emitBaseShadowMarkers adds the
            // state-0 marker Esri readers need.
            await insertDeleteMarker(this.connection, t, c.objectId, newTip);
          }
        }
        const advanced = await updateVersionState(
          this.connection, parent.owner, parent.name, newTip
        );
        if (advanced !== 1) {
          throw new Error(
            `Post did not advance ${parentFullName}: matched ${advanced} version rows ` +
            `(expected 1). The edit was NOT published.`
          );
        }
        postTargetState = newTip;
      } else {
        const versionsAdvanced = await updateVersionState(
          this.connection, parent.owner, parent.name, version.stateId
        );
        // The actual landing guarantee: DEFAULT must have advanced. If 0 rows
        // matched, the edit did NOT publish -- fail loudly (and roll back)
        // rather than report a phantom success, the way April's post did.
        if (versionsAdvanced !== 1) {
          throw new Error(
            `Post did not advance ${parentFullName}: matched ${versionsAdvanced} version rows ` +
            `(expected 1). The edit was NOT published.`
          );
        }
        postTargetState = version.stateId;
      }

      // Emit Esri-standard base-shadow delete markers for the rows this post
      // superseded, so the publish ETL / ArcGIS / *_evw views hide the stale
      // base rows. Scoped to the post's own contribution (states above the
      // pre-post parent tip); in trimPost mode the copied rows live at the new
      // tip, which is in DEFAULT's closure.
      await emitBaseShadowMarkers(
        this.connection,
        versionedTables,
        postTargetState,
        parent.stateId
      );

      // Lock auto-releases on commit (Postgres pg_advisory_xact_lock; SQL Server
      // sp_getapplock @LockOwner='Transaction'). No explicit unlock needed.
      await this.connection.commitTransaction();

      // deleteVersion is reference-aware (native sde.delete_version keeps states
      // still referenced by a version). Legacy post: DEFAULT now shares the
      // version's own states, so those are kept and become DEFAULT's history.
      // trimPost: DEFAULT points at a NEW state (newTip) and the version's edit
      // states are only COUSINS of newTip (never its ancestors -- newTip
      // branches from parent.stateId, the pre-post DEFAULT tip), so deleting the
      // version can collect them WITHOUT affecting newTip's resolution -- the
      // deltas were copied into newTip. (Runs outside the post txn; covered by
      // the trimPost + deleteVersionAfterPost training case.)
      if (options?.deleteVersionAfterPost) {
        await this.deleteVersion(versionName);
      }

      return {
        changesPosted,
        newParentStateId: postTargetState,
      };
    } catch (error) {
      await this.connection.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Rebase a version onto its parent's current tip, keeping the version's own
   * identity (same row in SDE_versions: same owner, same name).
   *
   * WHY: a reconcile copies the parent's changed rows INTO the child's state. On
   * a large fabric that is tens of thousands of rows, and it leaves the version
   * carrying a huge diff that is almost entirely the parent's own data -- which
   * makes Review slow and Post time out, even though the editor only changed a
   * handful of features. Rebasing instead creates a fresh state branched off the
   * parent's tip and replays ONLY the rows that actually differ from the parent,
   * so the version ends up with exactly the editor's work and nothing else.
   *
   * Redundant rows are identified structurally, not guessed: a child row that is
   * byte-identical to a parent row carries no information (a previous reconcile
   * copied it in), so dropping it cannot lose an edit. See selectChangedObjectIds.
   *
   * The version's OLD states are left untouched and simply become unreferenced,
   * so this is REVERSIBLE (repoint the version back) until a compress reclaims
   * them -- which is also how the leftover rows get cleaned up, natively.
   *
   * Returns per-table counts plus the old/new state ids.
   */
  /**
   * Rebase a version onto its parent's current tip, keeping its identity (same
   * row in SDE_versions: same owner, same name -- the editor still sees "their"
   * version, it just now sits on current DEFAULT).
   *
   * WHY: reconcile copies the parent's changed rows INTO the child's state. On a
   * large fabric that is tens of thousands of rows, leaving the version carrying
   * a diff that is almost entirely the parent's own data -- Review crawls and
   * Post times out even though the editor changed a handful of features.
   * Rebasing instead branches a fresh state off the parent's tip and replays ONLY
   * what actually differs, so the version ends up with exactly the editor's work.
   *
   * !!! NOT PRODUCTION READY. DO NOT UNGATE. DO NOT WIRE TO A ROUTE. !!!
   *
   * A first review found four defects; the fixes for them introduced further
   * ones, which a second review caught. A training run passed every check it
   * made and still proved little, because it never posted, never compressed, and
   * used data with no prior reconcile -- exactly where the remaining bugs live.
   * Treat a green training run here as weak evidence.
   *
   * OPEN, each independently disqualifying:
   *
   *  A. POST IS IMPOSSIBLE AFTER A REBASE. `isReconciled` (post.ts) is a pure
   *     closure lookup for (child lineage_name, parent state). Seeding only
   *     [newState] below leaves that row absent, so postVersion refuses with
   *     "no longer reconciled" -- the version can only be cleared by the very
   *     full reconcile this exists to avoid. The closure must be SEEDED with the
   *     parent's ancestry under the new lineage (one set-based INSERT..SELECT,
   *     which is what SDE_state_new_edit itself does when it allocates a
   *     lineage), not truncated to one row.
   *  B. COMPRESS GRADUATION STOPS DATABASE-WIDE. computeGraduablePrefix
   *     intersects every version tip's closure; a one-row closure makes that
   *     intersection empty, so compress graduates nothing for the whole
   *     geodatabase while any rebased version exists -- and posted work reaches
   *     the public layer via compress. Silent.
   *  C. NON-DETERMINISTIC. If the parent tip already has a child,
   *     SDE_state_new_edit allocates a fresh lineage and copies the parent's
   *     closure into it, so the code takes a different branch and yields a
   *     correct closure. Same input, two structurally different outcomes.
   *  D. TIP-ONLY COMPARISON FALSE-KEEPS. Stale reconcile residue that the parent
   *     has since changed again differs from the parent's TIP, so it is replayed
   *     and supersedes DEFAULT's NEWER row -- reverting it on post. The test must
   *     be three-way against the COMMON ANCESTOR, and a row differing from both
   *     is a CONFLICT, which this never detects (reconcileVersion does).
   *  E. CREATE-THEN-DELETE RESURRECTS; DELETE-AFTER-RECONCILE VANISHES. The
   *     pureDeletes heuristic is a set difference; it needs a per-OID temporal
   *     test (max D-state vs max A-state).
   *  F. PARENT IS NOT LOCKED. Only the child is locked; parentStates/parent tip
   *     are read before the transaction and never revalidated, so a concurrent
   *     post can strand rows dropped as "redundant" against a tip the new state
   *     does not descend from. postVersion locks the parent; this must too.
   *  G. PURE-DELETE MARKERS ARE INVISIBLE TO EGDB'S OWN READER. The adds-half
   *     predicate needs D.SDE_STATE_ID > A.SDE_STATE_ID; a marker at the
   *     superseded state can never satisfy it. The previous form broke Esri
   *     instead. Both markers are needed, not one or the other.
   *  H. LATENT BASE-TABLE DELETION. Markers carry a DEFAULT-lineage state, and
   *     graduateTable treats SDE_STATE_ID in the graduable prefix as graduable --
   *     so once (A) is fixed, an UNPOSTED version's delete can graduate into
   *     `DELETE FROM <base>`. Today only the broken closure masks it. This is the
   *     most dangerous interaction in the change; fix (A) and (H) together.
   *
   * Lesser: markers are not idempotent (a re-run duplicates them); parentStates
   * is inlined as a huge IN-list (10k+ states pre-compress) where
   * emitBaseShadowMarkers deliberately avoids that; CHUNK=2000 may exceed SQL
   * Server's 1000-row table-value-constructor limit; begin/rollbackTransaction
   * ignore the `wasInTx` pattern every other write path here uses; no
   * open-EditSession/fork check (a save would silently undo the rebase); the
   * dry-run reports updates under a `deletes` label; `droppedRedundant` counts
   * OBJECTIDs and reveals nothing about the false-keep in (D).
   */
  async rebaseVersion(
    versionName: string,
    options?: { dryRun?: boolean; unsafeExperimental?: boolean },
  ): Promise<{
    version: string;
    fromState: number;
    toState: number | null;
    replayed: Array<{ table: string; updates: number; deletes: number }>;
    droppedRedundant: number;
    dryRun: boolean;
  }> {
    // Refuse by default. A dry run is read-only and always allowed; anything that
    // writes requires the caller to opt in explicitly, so this cannot be reached
    // by accident while the defects above stand.
    if (!options?.dryRun && !options?.unsafeExperimental) {
      throw new Error(
        'rebaseVersion is NOT production ready: post refuses after a rebase (truncated ' +
        'closure), compress graduation stalls database-wide, the comparison can revert ' +
        'newer parent edits, and delete handling resurrects/loses features. See the ' +
        'open-defect list on the method. ' +
        'Pass { unsafeExperimental: true } to run it anyway, or { dryRun: true } to inspect the plan.',
      );
    }

    const version = await this.getVersion(versionName);
    if (!version || version.stateId == null) {
      throw new Error(`Version not found: ${versionName}`);
    }
    if (!version.parentName) {
      throw new Error(`Version ${versionName} has no parent; nothing to rebase onto.`);
    }
    const parentFullName = version.parentName.includes('.')
      ? version.parentName
      : `sde.${version.parentName}`;
    const parent = await this.getVersion(parentFullName);
    if (!parent || parent.stateId == null) {
      throw new Error(`Parent version not found: ${parentFullName}`);
    }

    const ancestor = await findCommonAncestor(this.connection, version.stateId, parent.stateId);
    const childStates = (await getStatesInRange(this.connection, version.stateId, 0))
      .filter((s) => s > ancestor);
    const parentStates = await getStatesInRange(this.connection, parent.stateId, 0);

    const versionedTables = (await this.listTables()).filter((t) => t.isVersioned);

    // Keep IN-lists / VALUES constructors inside SQL Server's expression limits.
    // One statement per chunk still collapses thousands of round-trips.
    const CHUNK = 2000;
    const chunkIds = (ids: number[]): number[][] => {
      const out: number[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
      return out;
    };

    // Work out what to replay BEFORE opening a transaction (all reads).
    const plan: Array<{ table: TableInfo; changed: number[]; pureDeletes: number[]; redundant: number }> = [];
    let droppedRedundant = 0;
    for (const table of versionedTables) {
      const changed = await selectChangedObjectIds(this.connection, table, childStates, parentStates);
      const deleted = await selectDeletedObjectIds(this.connection, table, childStates);
      // A PURE delete is a D-row with NO A-row anywhere in the version's states.
      // Filtering only against `changed` is not enough: a reconcile writes a
      // delete marker AND a copied A-row per parent change, and those A-rows are
      // dropped as identical-to-parent, so their markers would otherwise survive
      // as thousands of phantom "deletions" that never happened.
      const withARows = new Set(await selectObjectIdsWithARows(this.connection, table, childStates));
      const pureDeletes = deleted.filter((oid) => !withARows.has(oid));
      // A replayed row that SUPERSEDES a row the parent has is an update, whose
      // native representation is delete-marker + A-row at the same state (exactly
      // what the editor's own edit state held). Without the marker the diff
      // mislabels a retirement as a creation. A brand-new feature gets NO marker:
      // one at the same state as its A-row hides it from Esri's *_evw readers.
      const supersedes = await selectObjectIdsPresentInParent(this.connection, table, changed, parentStates);
      const markers = [...new Set([...pureDeletes, ...supersedes])];
      // How many of the version's own rows are being discarded as identical to
      // the parent's. This is the number to sanity-check on a dry run: if it is
      // non-zero for a version nobody reconciled, the comparison is dropping
      // real edits and the rebase must not be run.
      const redundant = Math.max(0, withARows.size - changed.length);
      droppedRedundant += redundant;
      if (changed.length || markers.length) {
        plan.push({ table, changed, pureDeletes: markers, redundant });
      }
    }

    if (options?.dryRun) {
      return {
        version: `${version.owner}.${version.name}`,
        fromState: version.stateId,
        toState: null,
        replayed: plan.map((p) => ({ table: p.table.name, updates: p.changed.length, deletes: p.pureDeletes.length })),
        droppedRedundant,
        dryRun: true,
      };
    }

    await this.connection.beginTransaction();
    try {
      // Serialise against concurrent edits, then re-read the version INSIDE the
      // lock: the plan above was computed from a state read before the lock, and
      // a save landing in between would otherwise be silently orphaned.
      await this.lockVersion(versionName);
      const fresh = await this.getVersion(versionName);
      if (!fresh || fresh.stateId !== version.stateId) {
        throw new Error(
          `Version ${versionName} moved from state ${version.stateId} to ` +
          `${fresh?.stateId ?? 'missing'} while the rebase was being planned. ` +
          `Nothing was changed; re-run to pick up the new edits.`,
        );
      }

      const newState = await createChildState(this.connection, parent.stateId);
      // SDE_state_new_edit locks the new state; this state becomes the version's
      // permanent tip, so clear the lock (same reasoning as trim post).
      await this.connection.execute(
        this.connection.driver === 'sqlserver'
          ? `DELETE FROM sde.SDE_state_locks WHERE state_id = @p0`
          : `DELETE FROM sde.sde_state_locks WHERE state_id = $1`,
        [newState],
      );

      // The new state MUST NOT share the parent's lineage. SDE_state_new_edit
      // hands the child the parent's lineage_name when the parent's tip has no
      // other children, and writing that state into the parent's closure makes a
      // version's UNPOSTED edits visible to every closure-based reader -- Esri's
      // *_evw and the publish ETL -- i.e. it publishes un-reviewed work. Observed
      // live. Give the state its own lineage (SDE's convention: lineage_name =
      // the state that starts the lineage) before touching any closure row.
      const parentLineage = await getLineageName(this.connection, parent.stateId);
      let lineage = await getLineageName(this.connection, newState);
      if (lineage === parentLineage) {
        await this.connection.execute(
          this.connection.driver === 'sqlserver'
            ? `UPDATE sde.SDE_states SET lineage_name = @p0 WHERE state_id = @p0`
            : `UPDATE sde.sde_states SET lineage_name = $1 WHERE state_id = $1`,
          [newState],
        );
        lineage = newState;
      }
      // SDE_state_new_edit maintains the closure ITSELF and inserts
      // (parentLineage, newState) when it creates the state. Reassigning
      // lineage_name above does not retract that row, so the version's unposted
      // state would still sit in the parent's closure -- the exact leak that
      // exposed un-reviewed edits to Esri *_evw and the publish ETL on live, and
      // which a training run caught still happening. Retract it explicitly.
      await this.connection.execute(
        this.connection.driver === 'sqlserver'
          ? `DELETE FROM sde.SDE_state_lineages WHERE lineage_name = @p0 AND lineage_id = @p1`
          : `DELETE FROM sde.sde_state_lineages WHERE lineage_name = $1 AND lineage_id = $2`,
        [parentLineage, newState],
      );

      const replayed: Array<{ table: string; updates: number; deletes: number }> = [];
      for (const p of plan) {
        let updates = 0;
        for (const part of chunkIds(p.changed)) {
          const n = await copyTipRows(this.connection, p.table, childStates, newState, part);
          if (n !== part.length) {
            throw new Error(
              `Rebase of ${versionName} failed on ${p.table.name}: copied ${n} A-rows, ` +
              `expected ${part.length}. The version was NOT changed.`,
            );
          }
          updates += n;
        }
        let deletes = 0;
        for (const part of chunkIds(p.pureDeletes)) {
          // Markers carry the SUPERSEDED row's state (0 = base), not newState --
          // a marker at the A-row's own state hides the feature from Esri readers.
          deletes += await insertSupersedeMarkers(this.connection, p.table, part, parentStates, newState);
        }
        replayed.push({ table: p.table.name, updates, deletes });
      }

      const moved = await updateVersionState(
        this.connection, version.owner, version.name, newState, version.stateId,
      );
      if (moved !== 1) {
        throw new Error(
          `Rebase did not move ${versionName}: matched ${moved} version rows (expected 1). ` +
          `Another edit landed concurrently; the version was NOT changed.`,
        );
      }

      // Record only the new state, under ITS OWN lineage. Writing the parent's
      // whole chain here would be thousands of single-row INSERTs inside this
      // transaction -- the very round-trip pathology this work removes -- and
      // SDE's closure is sparsely populated by design anyway.
      await addStatesToLineage(this.connection, lineage, [newState]);

      await this.connection.commitTransaction();
      return {
        version: `${version.owner}.${version.name}`,
        fromState: version.stateId,
        toState: newState,
        replayed,
        droppedRedundant,
        dryRun: false,
      };
    } catch (error) {
      await this.connection.rollbackTransaction();
      throw error;
    }
  }


  /**
   * Compress the entire geodatabase by removing orphaned states
   * and redundant A/D entries across all versions.
   *
   * WARNING: This is a heavy operation and should be run during maintenance windows.
   *
   * @param options Compression options
   * @returns Compression result
   *
   * @example
   * ```typescript
   * const result = await egdb.compress();
   * console.log(`Removed ${result.statesRemoved} orphaned states`);
   * ```
   */
  async compress(options?: CompressOptions): Promise<CompressResult> {
    // --- Safety guards (COMPRESS_HARDENING_PLAN.md step 0) ---------------------
    // compress() has known-unfixed data-loss vectors and must not be reachable by
    // accident while hardening is in flight. Refuse unless the caller explicitly
    // acknowledges the risk.
    if (!options?.acknowledgeExperimentalUnsafe) {
      throw new Error(
        'compress() is experimental and has known-unfixed data-loss defects; it must not run ' +
        'unacknowledged. Pass { acknowledgeExperimentalUnsafe: true } to run it anyway. ' +
        'See openparcels/handoff/COMPRESS_HARDENING_PLAN.md before doing so.',
      );
    }
    // Running inside a caller-owned transaction breaks compress's documented
    // per-phase critical sections (graduation would run at the caller's isolation
    // and never commit per table). Refuse rather than corrupt silently.
    if (this.connection.inTransaction()) {
      throw new Error('compress() must not be called inside an open transaction.');
    }

    const allTables = await this.listTables();
    const allVersioned = allTables.filter(t => t.isVersioned);
    // N2 (COMPRESS_HARDENING_PLAN.md): `options.tables` may ONLY scope graduation.
    // Prune and collapse delete/re-point STATES, so they must always operate on
    // EVERY versioned table — otherwise an excluded table keeps A/D rows tagged
    // with a state that prune deleted (invisible forever) or pointing at a
    // collapsed-away child. `tables` (possibly filtered) drives graduation only.
    let tables = allVersioned;
    if (options?.tables && options.tables.length > 0) {
      const tableNames = new Set(options.tables.map(t => t.toLowerCase()));
      tables = tables.filter(t => tableNames.has(t.name.toLowerCase()));
    }

    // Phase 3 (Esri terminology): graduate delta rows into base tables.
    // Per-table, SERIALIZABLE so the in-fence subset revalidation and the
    // base writes form a single critical section against concurrent
    // createVersion.
    const graduableSnapshot = await computeGraduablePrefix(this.connection);
    const columnCache = new Map<string, string[]>();
    const graduationByTable: GraduateTableResult[] = [];
    let graduatedUpserts = 0;
    let graduatedDeletes = 0;
    let totalAddsRemoved = 0;
    let totalDeletesRemoved = 0;
    for (const t of tables) {
      const wasInTx = this.connection.inTransaction();
      if (!wasInTx) await this.connection.beginTransaction({ isolation: 'serializable' });
      try {
        const r = await graduateTable(this.connection, t, graduableSnapshot, columnCache);
        if (!wasInTx) await this.connection.commitTransaction();
        graduationByTable.push(r);
        graduatedUpserts += r.upserts;
        graduatedDeletes += r.deletes;
        totalAddsRemoved += r.aRowsRemoved;
        totalDeletesRemoved += r.dRowsRemoved;
      } catch (e) {
        if (!wasInTx && this.connection.inTransaction()) {
          await this.connection.rollbackTransaction();
        }
        throw e;
      }
    }

    // Phase 1: prune unreferenced, non-branch-point, unlocked states.
    const pruneResult = await pruneStates(this.connection, allVersioned);
    totalAddsRemoved += pruneResult.deltaRowsRemoved;
    const statesRemoved = pruneResult.statesRemoved;

    // Phase 2: collapse linear state chains (child into parent).
    const collapseResult = await collapseLineages(this.connection, allVersioned);

    const allTablesSkipped = graduationByTable.length > 0
      && graduationByTable.every(t => t.status === 'skipped-version-set-changed');
    if (allTablesSkipped) {
      this._logger.warn?.(
        `compress: every table's graduation skipped with status='skipped-version-set-changed'. ` +
        `The version set changed during compress (likely a concurrent createVersion). ` +
        `Re-run compress.`,
      );
    }

    return {
      addsRemoved: totalAddsRemoved,
      deletesRemoved: totalDeletesRemoved,
      statesRemoved,
      graduatedUpserts,
      graduatedDeletes,
      graduationByTable,
      lineagesCollapsed: collapseResult.collapses,
      rowsRewritten: collapseResult.rowsRewritten,
      statesSkippedByPrune: pruneResult.statesSkipped,
      allTablesSkippedDueToConcurrentVersionChange: allTablesSkipped || undefined,
    };
  }

  /**
   * Get statistics about A/D table sizes for a version.
   *
   * @param versionName Version to analyze
   * @returns Map of table name to add/delete counts
   *
   * @example
   * ```typescript
   * const stats = await egdb.getVersionStats('myuser.edit_version');
   * for (const [table, counts] of stats) {
   *   console.log(`${table}: ${counts.adds} adds, ${counts.deletes} deletes`);
   * }
   * ```
   */
  async getVersionStatistics(
    versionName: string
  ): Promise<Map<string, { adds: number; deletes: number }>> {
    const version = await this.getVersion(versionName);
    if (!version) {
      throw new Error(`Version not found: ${versionName}`);
    }

    const stateLineage = await this.getVersionStateLineage(versionName);
    if (!stateLineage || stateLineage.length === 0) {
      return new Map();
    }

    const tables = await this.listTables();
    const versionedTables = tables.filter(t => t.isVersioned);

    return getVersionStats(this.connection, versionedTables, stateLineage);
  }

  // ============================================================
  // TRANSACTION SUPPORT
  // ============================================================

  /**
   * Check if currently in a transaction
   */
  inTransaction(): boolean {
    return this.connection.inTransaction();
  }

  /**
   * Execute operations within a database transaction.
   * Auto-commits on success, rolls back on error.
   *
   * @example
   * ```typescript
   * await egdb.transaction(async () => {
   *   const parcels = await egdb.openTable('PARCELS');
   *   await parcels.insert({ attributes: { Name: 'Parcel 1' } });
   *   await parcels.insert({ attributes: { Name: 'Parcel 2' } });
   *   // Both inserts committed together, or both rolled back on error
   * });
   * ```
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.connection.inTransaction()) {
      // Already in a transaction, just execute the function
      return fn();
    }

    await this.connection.beginTransaction();
    try {
      const result = await fn();
      await this.connection.commitTransaction();
      return result;
    } catch (error) {
      await this.connection.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Execute versioned edits within a database transaction.
   * Starts an edit session, executes the provided function, saves and closes the session.
   * Auto-commits on success, rolls back on error.
   *
   * @param versionName Version to edit (e.g., "sde.DEFAULT")
   * @param fn Function that receives an EditSession and performs edits
   *
   * @example
   * ```typescript
   * await egdb.editTransaction('sde.DEFAULT', async (session) => {
   *   await session.insert('PARCELS', { attributes: { Name: 'New' } });
   *   await session.update('PARCELS', 123, { Status: 'Active' });
   *   // All edits committed atomically, or rolled back on error
   * });
   * ```
   */
  async editTransaction<T>(
    versionName: string,
    fn: (session: EditSession) => Promise<T>
  ): Promise<T> {
    const alreadyInTransaction = this.connection.inTransaction();

    if (!alreadyInTransaction) {
      await this.connection.beginTransaction();
    }

    try {
      // Create edit session (writes directly to A/D tables)
      // Note: We don't call startEditing/stopEditing here because:
      // 1. EditSession writes directly to A/D tables without needing sde.edit_version
      // 2. sde.edit_version may interfere with our explicit transaction management
      const session = await EditSession.start(this, versionName);

      // Execute user code
      const result = await fn(session);

      // Save and close session
      await session.save();
      await session.close();

      if (!alreadyInTransaction) {
        await this.connection.commitTransaction();
      }

      return result;
    } catch (error) {
      if (!alreadyInTransaction) {
        await this.connection.rollbackTransaction();
      }
      throw error;
    }
  }

  /**
   * Execute a raw SQL query
   *
   * Use with caution - this bypasses normal geodatabase access patterns.
   */
  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.connection.query<T>(sql, params);
  }

  /**
   * Remove rows from `SDE_state_locks` whose owning database session no longer
   * exists. Run as a periodic maintenance task to recover from EditSession
   * processes that died before reaching `close()`.
   *
   * Cross-checks against `sys.dm_exec_sessions` (SQL Server) or
   * `pg_stat_activity` (PostgreSQL). The current connection's own session is
   * always considered live, so this is safe to call from a long-running
   * service.
   *
   * Note: this only removes lock rows, not the orphaned child states they
   * were protecting. Those states still hold a self-row in
   * `SDE_state_lineages`, so a deeper cleanup pass would be needed to fully
   * reclaim them. See CLAUDE.md "Known Limitations".
   */
  async cleanupStaleLocks(): Promise<StaleLockCleanupResult> {
    return cleanupStaleLocks(this.connection);
  }

  // ============================================================
  // VERSION LOCKING (used by postVersion to serialize concurrent posts)
  // ============================================================

  /**
   * Acquire an exclusive transaction-scoped lock identifying a version.
   *
   * SQL Server: sp_getapplock with @LockOwner = 'Transaction'.
   * PostgreSQL: pg_advisory_xact_lock + a per-transaction statement_timeout
   * so the lock wait can't block forever. Postgres' SET LOCAL does NOT accept
   * bind parameters in most drivers, so we inline the timeout constant — safe
   * because LOCK_TIMEOUT_MS is a class constant, not user input.
   *
   * Caller must already be in a transaction; both flavors release at commit
   * (Postgres automatically; SQL Server because the lock is transaction-owned),
   * so there's no companion unlockVersion — commit/rollback ends the lock.
   *
   * @throws LockTimeoutError if the lock cannot be acquired within LOCK_TIMEOUT_MS
   */
  private async lockVersion(versionName: string): Promise<void> {
    const resource = `egdb_version:${versionName}`;

    if (this.config.driver === 'sqlserver') {
      const sql = `
        DECLARE @result int;
        EXEC @result = sp_getapplock
          @Resource = @p0,
          @LockMode = 'Exclusive',
          @LockOwner = 'Transaction',
          @LockTimeout = @p1;
        SELECT @result AS lock_result;
      `;
      const result = await this.connection.query<{ lock_result: number }>(sql, [
        resource,
        EnterpriseGeodatabase.LOCK_TIMEOUT_MS,
      ]);
      const code = result[0]?.lock_result ?? -999;
      if (code < 0) {
        if (code === -1) throw new LockTimeoutError(resource);
        if (code === -3) throw new Error(`Deadlock while locking ${versionName}`);
        throw new Error(`Failed to lock ${versionName}: sp_getapplock code ${code}`);
      }
    } else {
      try {
        // Inlined constant — see method doc for why this can't be a bind param.
        await this.connection.query(
          `SET LOCAL statement_timeout = ${EnterpriseGeodatabase.LOCK_TIMEOUT_MS}`
        );
        await this.connection.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [resource]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('statement timeout') || msg.includes('canceling statement')) {
          throw new LockTimeoutError(resource);
        }
        throw error;
      }
    }
  }

  /**
   * Close the geodatabase connection
   */
  async close(): Promise<void> {
    // Cached tables hold this connection; drop them so they can't be reused
    // against a closed connection after a reconnect.
    this._tableCache.clear();
    await this.connection.close();
  }
}
