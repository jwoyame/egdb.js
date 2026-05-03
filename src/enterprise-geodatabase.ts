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
import { parseGdbItems } from './parsers/gdb-items-parser';
import type { GdbItemRow } from './parsers/gdb-items-parser';
import type {
  ConnectionConfig,
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
  addStatesToLineage,
  getAllChanges,
  detectDetailedConflicts,
  getConflictsSummary,
  applyParentChanges,
  isReconciled,
  postChangesToParent,
  updateVersionState,
  deleteStates,
  getChildUniqueStates,
  compressStates,
  removeOrphanedStates,
  getVersionStats,
  cleanupStaleLocks,
} from './reconcile';
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
  private _logger: Logger;

  private constructor(config: ConnectionConfig, connection: IDatabaseConnection) {
    this.config = config;
    this.connection = connection;
    this._logger = config.logger ?? consoleLogger;
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
   * List geodatabase versions
   */
  async listVersions(): Promise<VersionInfo[]> {
    const sql = this.config.driver === 'sqlserver'
      ? `
        SELECT
          name,
          owner,
          description,
          parent_name,
          creation_time,
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
          creation_time,
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
        state_id?: number;
      }>(sql);

      return rows.map((row) => ({
        name: row.name,
        owner: row.owner,
        description: row.description,
        parentName: row.parent_name,
        createTime: row.creation_time,
        stateId: row.state_id,
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

    const sql = this.config.driver === 'sqlserver'
      ? `
        SELECT DISTINCT sl.lineage_id
        FROM sde.SDE_state_lineages sl
        JOIN sde.SDE_states s ON s.state_id = @p0
        WHERE sl.lineage_name = s.lineage_name
          AND sl.lineage_id <= @p0
        ORDER BY sl.lineage_id
      `
      : `
        SELECT DISTINCT sl.lineage_id
        FROM sde.sde_state_lineages sl
        JOIN sde.sde_states s ON s.state_id = $1
        WHERE sl.lineage_name = s.lineage_name
          AND sl.lineage_id <= $1
        ORDER BY sl.lineage_id
      `;

    const rows = await this.connection.query<{ lineage_id: number }>(sql, [version.stateId]);
    return rows.map(r => r.lineage_id);
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

    // 6. Apply parent changes to child version
    const { appliedCount, mergedCount } = await applyParentChanges(
      this.connection,
      versionedTables,
      parentChanges,
      conflicts,
      version.stateId,
      opts
    );

    // 7. Update child's lineage to include parent's states
    // This marks the reconcile as complete
    const childLineageName = version.stateId; // Lineage name equals current state_id
    await addStatesToLineage(this.connection, childLineageName, parentOnlyStates);

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

      const childUniqueStates = await getChildUniqueStates(
        this.connection,
        version.stateId,
        parent.stateId
      );

      const tables = await this.listTables();
      const versionedTables = tables.filter(t => t.isVersioned);

      const changesPosted = await postChangesToParent(
        this.connection,
        versionedTables,
        childUniqueStates,
        parent.stateId
      );

      await updateVersionState(
        this.connection,
        version.owner,
        version.name,
        parent.stateId
      );

      await deleteStates(this.connection, childUniqueStates);

      // Lock auto-releases on commit for both drivers (Postgres:
      // pg_advisory_xact_lock; SQL Server: sp_getapplock with @LockOwner =
      // 'Transaction'). No explicit unlock needed on the success path.
      await this.connection.commitTransaction();

      if (options?.deleteVersionAfterPost) {
        await this.deleteVersion(versionName);
      }

      return {
        changesPosted,
        newParentStateId: parent.stateId,
      };
    } catch (error) {
      await this.connection.rollbackTransaction();
      throw error;
    }
  }

  /**
   * Compress a specific version's states to reduce A/D table bloat.
   *
   * This removes redundant entries:
   * - Insert + Delete pairs for the same OBJECTID (net effect: nothing)
   * - Multiple updates to the same OBJECTID (keeps only latest)
   *
   * @param versionName Version to compress
   * @param options Compression options
   * @returns Compression result
   *
   * @example
   * ```typescript
   * const result = await egdb.compressVersion('myuser.edit_version');
   * console.log(`Removed ${result.addsRemoved} adds, ${result.deletesRemoved} deletes`);
   * ```
   */
  async compressVersion(
    versionName: string,
    options?: CompressOptions
  ): Promise<CompressResult> {
    const version = await this.getVersion(versionName);
    if (!version) {
      throw new Error(`Version not found: ${versionName}`);
    }
    if (!version.stateId) {
      throw new Error(`Version ${versionName} has no state ID`);
    }

    // Get version's state lineage
    const stateLineage = await this.getVersionStateLineage(versionName);
    if (!stateLineage || stateLineage.length === 0) {
      return { addsRemoved: 0, deletesRemoved: 0, statesRemoved: 0 };
    }

    // Get tables to compress
    const allTables = await this.listTables();
    let tables = allTables.filter(t => t.isVersioned);

    // Filter to specific tables if requested
    if (options?.tables && options.tables.length > 0) {
      const tableNames = new Set(options.tables.map(t => t.toLowerCase()));
      tables = tables.filter(t => tableNames.has(t.name.toLowerCase()));
    }

    // Compress the states
    const result = await compressStates(this.connection, tables, stateLineage);

    // Optionally remove orphaned states
    if (options?.removeOrphanedStates) {
      result.statesRemoved = await removeOrphanedStates(this.connection);
    }

    return result;
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
    // Get all versioned tables
    const allTables = await this.listTables();
    let tables = allTables.filter(t => t.isVersioned);

    // Filter to specific tables if requested
    if (options?.tables && options.tables.length > 0) {
      const tableNames = new Set(options.tables.map(t => t.toLowerCase()));
      tables = tables.filter(t => tableNames.has(t.name.toLowerCase()));
    }

    // Get all versions to find all active states
    const versions = await this.listVersions();
    const activeStates = new Set<number>();
    for (const v of versions) {
      if (v.stateId) {
        const lineage = await this.getVersionStateLineage(`${v.owner}.${v.name}`);
        if (lineage) {
          lineage.forEach(s => activeStates.add(s));
        }
      }
    }

    // Compress each version's states
    let totalAddsRemoved = 0;
    let totalDeletesRemoved = 0;

    for (const v of versions) {
      if (v.stateId) {
        const lineage = await this.getVersionStateLineage(`${v.owner}.${v.name}`);
        if (lineage && lineage.length > 0) {
          const result = await compressStates(this.connection, tables, lineage);
          totalAddsRemoved += result.addsRemoved;
          totalDeletesRemoved += result.deletesRemoved;
        }
      }
    }

    // Remove orphaned states (states not referenced by any version)
    const statesRemoved = options?.removeOrphanedStates !== false
      ? await removeOrphanedStates(this.connection)
      : 0;

    return {
      addsRemoved: totalAddsRemoved,
      deletesRemoved: totalDeletesRemoved,
      statesRemoved,
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
    await this.connection.close();
  }
}
