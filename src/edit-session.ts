/**
 * EditSession - Versioned editing for enterprise geodatabase tables
 *
 * When editing in a version, operations go to the A/D delta tables:
 * - INSERT → Add row to A table with SDE_STATE_ID
 * - UPDATE → Add row to D table (mark old as deleted) + Add row to A table (new values)
 * - DELETE → Add row to D table
 */

import type { IDatabaseConnection } from './connections/connection';
import type { EnterpriseGeodatabase } from './enterprise-geodatabase';
import { EnterpriseTable } from './enterprise-table';
import { geometryToWkt, isValidGeometry } from './parsers/geometry-writer';
import type { Feature, Geometry, VersionInfo, TableInfo } from './types';
import { validatePositiveInteger } from './utils/sql-helpers';
import { requireRegistrationId } from './utils/guards';
import {
  createChildState,
  deleteChildState,
  acquireStateLock,
  releaseStateLock,
} from './reconcile/state-management';

/** Options for versioned insert operations */
export interface VersionedInsertOptions {
  /** SRID to use for geometry (defaults to table's spatial reference) */
  srid?: number;
}

/** Options for versioned update operations */
export interface VersionedUpdateOptions {
  /** SRID to use for geometry updates */
  srid?: number;
}

/** Edit session state */
type SessionState = 'open' | 'saved' | 'discarded' | 'closed';

/** Types of tracked edit operations */
type EditOperationType = 'insert' | 'update' | 'delete';

/** Information stored for undo/redo */
interface EditOperation {
  type: EditOperationType;
  tableName: string;
  objectId: number;
  /** Previous attributes (for update/delete) */
  previousAttributes?: Record<string, unknown>;
  /** Previous geometry (for update/delete) */
  previousGeometry?: Geometry | null;
  /** New attributes (for insert/update) */
  newAttributes?: Record<string, unknown>;
  /** New geometry (for insert/update) */
  newGeometry?: Geometry | null;
  /** Whether the row existed in A table before this op */
  wasInAddsTable: boolean;
  /** SRID used for geometry operations */
  srid?: number;
}

/**
 * EditSession manages versioned edits within a geodatabase version.
 *
 * Usage:
 * ```typescript
 * const session = await EditSession.start(egdb, 'sde.DEFAULT');
 *
 * // Make edits
 * await session.insert('PARCELS', { attributes: { Name: 'New Parcel' } });
 * await session.update('PARCELS', 123, { Status: 'Updated' });
 * await session.delete('PARCELS', 456);
 *
 * // Save or discard
 * await session.save();
 * // or: await session.discard();
 *
 * await session.close();
 * ```
 */
export class EditSession {
  private geodatabase: EnterpriseGeodatabase;
  private connection: IDatabaseConnection;
  private versionInfo: VersionInfo;
  private stateId: number;
  /** Parent state at session start — used as the CAS predicate in save() */
  private parentStateId: number;
  /** sde_id used to acquire the state lock; null after release */
  private stateLockSdeId: number | null = null;
  private sessionState: SessionState = 'open';
  private tableCache: Map<string, EnterpriseTable> = new Map();
  private tableInfoCache: Map<string, TableInfo> = new Map();
  private undoStack: EditOperation[] = [];
  private redoStack: EditOperation[] = [];
  /** Track which tables (by registrationId) have been modified for discard cleanup */
  private modifiedTables: Set<number> = new Set();

  private constructor(
    geodatabase: EnterpriseGeodatabase,
    connection: IDatabaseConnection,
    versionInfo: VersionInfo,
    stateId: number,
    parentStateId: number
  ) {
    this.geodatabase = geodatabase;
    this.connection = connection;
    this.versionInfo = versionInfo;
    this.stateId = stateId;
    this.parentStateId = parentStateId;
  }

  /**
   * Start an edit session on a version
   * @param geodatabase The geodatabase connection
   * @param versionName Version name (e.g., "sde.DEFAULT" or just "DEFAULT")
   */
  static async start(
    geodatabase: EnterpriseGeodatabase,
    versionName: string
  ): Promise<EditSession> {
    const version = await geodatabase.getVersion(versionName);
    if (!version) {
      throw new Error(`Version not found: ${versionName}`);
    }

    if (!version.stateId) {
      throw new Error(`Version ${versionName} has no state ID`);
    }

    const connection = geodatabase.getConnection();
    const parentStateId = version.stateId;

    // State creation + lock acquisition must be atomic. Otherwise a crash
    // between the two leaves an unlocked child state that compress can reap.
    const wasInTx = connection.inTransaction();
    if (!wasInTx) await connection.beginTransaction();

    let childStateId: number;
    let sdeId: number;
    try {
      childStateId = await createChildState(connection, parentStateId);
      sdeId = await acquireStateLock(connection, childStateId);
      if (!wasInTx) await connection.commitTransaction();
    } catch (error) {
      if (!wasInTx) await connection.rollbackTransaction();
      throw error;
    }

    const session = new EditSession(geodatabase, connection, version, childStateId, parentStateId);
    session.stateLockSdeId = sdeId;
    return session;
  }

  /**
   * Get the version name this session is editing
   */
  get versionName(): string {
    return `${this.versionInfo.owner}.${this.versionInfo.name}`;
  }

  /**
   * Get the state ID being edited
   */
  get currentStateId(): number {
    return this.stateId;
  }

  /**
   * Check if the session is open for editing
   */
  get isOpen(): boolean {
    return this.sessionState === 'open';
  }

  /**
   * Check if there are unsaved changes in this session.
   *
   * Returns true if the session is open and has pending operations.
   * Use this to prompt users before closing without saving.
   *
   * Note: Uses undoStack.length rather than modifiedTables.size to correctly
   * handle insert → undo scenarios where the table was touched but no
   * changes remain.
   */
  get hasUnsavedChanges(): boolean {
    return this.sessionState === 'open' && this.undoStack.length > 0;
  }

  /**
   * Quote identifier based on database driver
   */
  private quoteId(name: string): string {
    return this.connection.driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
  }

  /**
   * Get or load a table
   */
  private async getTable(tableName: string): Promise<EnterpriseTable> {
    if (this.tableCache.has(tableName)) {
      return this.tableCache.get(tableName)!;
    }

    const table = await this.geodatabase.openTable(tableName);
    this.tableCache.set(tableName, table);
    return table;
  }

  /**
   * Get or load table info
   */
  private async getTableInfo(tableName: string): Promise<TableInfo> {
    if (this.tableInfoCache.has(tableName)) {
      return this.tableInfoCache.get(tableName)!;
    }

    const tables = await this.geodatabase.listTables();
    const info = tables.find(
      t => t.name.toLowerCase() === tableName.toLowerCase() ||
           t.physicalName.toLowerCase() === tableName.toLowerCase()
    );

    if (!info) {
      throw new Error(`Table not found: ${tableName}`);
    }

    this.tableInfoCache.set(tableName, info);
    return info;
  }

  /**
   * Build a safe WHERE clause for OBJECTID lookup.
   * Validates that id is a positive integer to prevent SQL injection — the
   * stream() API takes `where` as a raw string, so untrusted ids embedded
   * directly would otherwise be unsafe.
   */
  private buildObjectIdWhere(id: number): string {
    validatePositiveInteger(id, 'OBJECTID');
    return `OBJECTID = ${id}`;
  }

  /**
   * Get a feature from the versioned view (base table - deletes + adds)
   * This is used to find features for update/delete operations
   */
  private async getVersionedFeature(
    table: EnterpriseTable,
    _tableInfo: TableInfo,
    id: number
  ): Promise<Feature | null> {
    // Use stream with version to properly query the versioned view
    // This includes both base table rows and A table rows (minus D table deletes)
    for await (const feature of table.stream({
      version: this.versionName,
      where: this.buildObjectIdWhere(id),
      limit: 1
    })) {
      return feature;
    }
    return null;
  }

  /**
   * Allocate the next OBJECTID from the i-table
   */
  private async allocateNextObjectId(tableInfo: TableInfo): Promise<number> {
    const regId = tableInfo.registrationId;
    if (!regId) {
      throw new Error(`Table ${tableInfo.name} is not registered (no registrationId)`);
    }

    const driver = this.connection.driver;
    const iTable = `${this.quoteId(tableInfo.schema)}.${this.quoteId(`i${regId}`)}`;

    if (driver === 'sqlserver') {
      const sql = `
        UPDATE ${iTable}
        SET base_id = base_id + 1
        OUTPUT DELETED.base_id
        WHERE id_type = 2
      `;
      const result = await this.connection.query<{ base_id: number }>(sql);
      if (result.length === 0 || result[0]?.base_id === undefined) {
        throw new Error(`Failed to allocate OBJECTID from ${iTable}`);
      }
      return result[0].base_id;
    } else {
      const sql = `
        UPDATE ${iTable}
        SET base_id = base_id + 1
        WHERE id_type = 2
        RETURNING base_id - 1 as allocated_id
      `;
      const result = await this.connection.query<{ allocated_id: number }>(sql);
      if (result.length === 0) {
        throw new Error(`Failed to allocate OBJECTID from ${iTable}`);
      }
      return result[0]!.allocated_id;
    }
  }

  /**
   * Insert a feature into a versioned table (writes to A table)
   * @param tableName Name of the table
   * @param feature Feature to insert (id is ignored, will be auto-generated)
   * @param options Insert options
   * @returns The new OBJECTID
   */
  async insert(
    tableName: string,
    feature: Omit<Feature, 'id'> | { attributes: Record<string, unknown>; geometry?: Geometry | null },
    options?: VersionedInsertOptions
  ): Promise<number> {
    this.ensureOpen();

    const table = await this.getTable(tableName);
    const tableInfo = await this.getTableInfo(tableName);

    if (!tableInfo.isVersioned) {
      throw new Error(`Table ${tableName} is not versioned. Use table.insert() for direct edits.`);
    }

    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);

    // A table name: a{registrationId}
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;

    // Allocate next OBJECTID
    const newObjectId = await this.allocateNextObjectId(tableInfo);

    // Get field metadata
    const metadata = table.metadata;
    const shapeField = tableInfo.shapeFieldName;

    // Get writable fields (exclude OBJECTID, GLOBALID, and GEOMETRY)
    const writableFields = metadata.fields.filter(f =>
      f.type !== 6 && // OID
      f.name.toLowerCase() !== 'objectid' &&
      f.name.toLowerCase() !== 'globalid' &&
      f.type !== 7 // GEOMETRY (handled separately)
    );

    // Build column names and values
    // A table has: same columns as base + SDE_STATE_ID
    const columns: string[] = [
      this.quoteId('OBJECTID'),
      this.quoteId('SDE_STATE_ID')
    ];
    const params: string[] = [
      driver === 'sqlserver' ? '@p0' : '$1',
      driver === 'sqlserver' ? '@p1' : '$2'
    ];
    const values: unknown[] = [newObjectId, this.stateId];
    let paramIndex = 2;

    for (const field of writableFields) {
      const value = feature.attributes[field.name];
      if (value !== undefined) {
        columns.push(this.quoteId(field.name));
        params.push(driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`);
        values.push(value);
        paramIndex++;
      }
    }

    // Handle geometry
    if (shapeField && feature.geometry && isValidGeometry(feature.geometry)) {
      const srid = options?.srid ?? feature.geometry.srid ?? 0;
      const wkt = geometryToWkt(feature.geometry);

      columns.push(this.quoteId(shapeField));
      if (driver === 'sqlserver') {
        params.push(`geometry::STGeomFromText(@p${paramIndex}, ${srid})`);
        values.push(wkt);
      } else {
        params.push(`ST_GeomFromText($${paramIndex + 1}, ${srid})`);
        values.push(wkt);
      }
      paramIndex++;
    }

    // Build INSERT statement for A table
    const sql = `
      INSERT INTO ${addsTable} (${columns.join(', ')})
      VALUES (${params.join(', ')})
    `;

    await this.connection.execute(sql, values);

    // Track modified table for discard cleanup
    this.modifiedTables.add(regId);

    // Track for undo/redo
    this.undoStack.push({
      type: 'insert',
      tableName,
      objectId: newObjectId,
      newAttributes: { ...feature.attributes },
      newGeometry: feature.geometry ?? null,
      wasInAddsTable: false, // New insert, didn't exist before
      srid: options?.srid ?? feature.geometry?.srid,
    });
    this.redoStack = []; // Clear redo stack on new operation

    return newObjectId;
  }

  /**
   * Check if a feature exists in the A table for the current state
   */
  private async existsInAddsTable(
    tableInfo: TableInfo,
    id: number
  ): Promise<boolean> {
    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;

    const sql = driver === 'sqlserver'
      ? `SELECT 1 FROM ${addsTable} WHERE OBJECTID = @p0 AND SDE_STATE_ID = @p1`
      : `SELECT 1 FROM ${addsTable} WHERE objectid = $1 AND sde_state_id = $2`;

    const result = await this.connection.query(sql, [id, this.stateId]);
    return result.length > 0;
  }

  /**
   * Update a row that already exists in the A table for current state
   * Returns previous values for undo tracking
   */
  private async updateAddsTableRow(
    tableInfo: TableInfo,
    table: EnterpriseTable,
    id: number,
    attributes: Partial<Record<string, unknown>>,
    current: Feature,
    options?: VersionedUpdateOptions
  ): Promise<{ success: boolean; previousAttributes: Record<string, unknown> }> {
    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
    const shapeField = tableInfo.shapeFieldName;

    // Build SET clauses for UPDATE
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 0;

    for (const [key, value] of Object.entries(attributes)) {
      // Skip OBJECTID, GLOBALID, SDE_STATE_ID and geometry (handled separately)
      const keyLower = key.toLowerCase();
      if (keyLower === 'objectid' || keyLower === 'globalid' || keyLower === 'sde_state_id') continue;
      if (shapeField && keyLower === shapeField.toLowerCase()) continue;

      setClauses.push(
        `${this.quoteId(key)} = ${driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`}`
      );
      values.push(value);
      paramIndex++;
    }

    // Handle geometry update if present
    if (shapeField && attributes[shapeField]) {
      const geometry = attributes[shapeField] as Geometry;
      if (isValidGeometry(geometry)) {
        const srid = options?.srid ?? geometry.srid ?? 0;
        const wkt = geometryToWkt(geometry);

        if (driver === 'sqlserver') {
          setClauses.push(`${this.quoteId(shapeField)} = geometry::STGeomFromText(@p${paramIndex}, ${srid})`);
        } else {
          setClauses.push(`${this.quoteId(shapeField)} = ST_GeomFromText($${paramIndex + 1}, ${srid})`);
        }
        values.push(wkt);
        paramIndex++;
      }
    }

    if (setClauses.length === 0) {
      return { success: false, previousAttributes: {} }; // Nothing to update
    }

    // Capture previous values for undo
    const previousAttributes: Record<string, unknown> = {};
    for (const key of Object.keys(attributes)) {
      previousAttributes[key] = current.attributes[key];
    }

    // Add WHERE clause parameters
    values.push(id, this.stateId);
    const idParam = driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`;
    const stateParam = driver === 'sqlserver' ? `@p${paramIndex + 1}` : `$${paramIndex + 2}`;

    const sql = `
      UPDATE ${addsTable}
      SET ${setClauses.join(', ')}
      WHERE OBJECTID = ${idParam} AND SDE_STATE_ID = ${stateParam}
    `;

    const result = await this.connection.execute(sql, values);
    return { success: result.rowsAffected > 0, previousAttributes };
  }

  /**
   * Update a feature in a versioned table
   *
   * If the feature was added in the current state (A table), updates it directly.
   * If the feature is from the base table or an earlier state:
   * - Marks old row as deleted (D table)
   * - Inserts new row (A table)
   *
   * @param tableName Name of the table
   * @param id OBJECTID of the feature to update
   * @param attributes Attributes to update (partial update)
   * @param options Update options
   * @returns true if updated, false if not found
   */
  async update(
    tableName: string,
    id: number,
    attributes: Partial<Record<string, unknown>>,
    options?: VersionedUpdateOptions
  ): Promise<boolean> {
    this.ensureOpen();

    const table = await this.getTable(tableName);
    const tableInfo = await this.getTableInfo(tableName);

    if (!tableInfo.isVersioned) {
      throw new Error(`Table ${tableName} is not versioned. Use table.update() for direct edits.`);
    }

    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);

    // Read current feature (from versioned view using the version we're editing)
    const current = await this.getVersionedFeature(table, tableInfo, id);
    if (!current) {
      return false;
    }

    const shapeField = tableInfo.shapeFieldName;
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;

    // Check if this feature already exists in the A table for current state
    const existsInAdds = await this.existsInAddsTable(tableInfo, id);

    if (existsInAdds) {
      // Feature was added/modified in current state - UPDATE it directly
      const result = await this.updateAddsTableRow(tableInfo, table, id, attributes, current, options);
      if (result.success) {
        // Track modified table for discard cleanup
        this.modifiedTables.add(regId);

        // Track for undo/redo
        this.undoStack.push({
          type: 'update',
          tableName,
          objectId: id,
          previousAttributes: result.previousAttributes,
          previousGeometry: current.geometry,
          newAttributes: { ...attributes },
          newGeometry: (attributes[tableInfo.shapeFieldName!] as Geometry) ?? null,
          wasInAddsTable: true,
          srid: options?.srid,
        });
        this.redoStack = [];
      }
      return result.success;
    }

    // Feature is from base table or earlier state - use D+A approach

    // 1. Mark as deleted in D table
    const deletesTable = `${schema}.${this.quoteId(`D${regId}`)}`;
    const deleteSql = driver === 'sqlserver'
      ? `INSERT INTO ${deletesTable} (SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT) VALUES (@p0, @p1, @p2)`
      : `INSERT INTO ${deletesTable} (sde_state_id, sde_deletes_row_id, deleted_at) VALUES ($1, $2, $3)`;

    await this.connection.execute(deleteSql, [this.stateId, id, this.stateId]);

    // 2. Insert updated row in A table (with same OBJECTID)
    const metadata = table.metadata;

    // Merge current attributes with updates
    const mergedAttributes = { ...current.attributes, ...attributes };

    // Get writable fields
    const writableFields = metadata.fields.filter(f =>
      f.type !== 6 && // OID
      f.name.toLowerCase() !== 'objectid' &&
      f.name.toLowerCase() !== 'globalid' &&
      f.type !== 7 // GEOMETRY
    );

    // Build INSERT for A table
    const columns: string[] = [
      this.quoteId('OBJECTID'),
      this.quoteId('SDE_STATE_ID')
    ];
    const params: string[] = [
      driver === 'sqlserver' ? '@p0' : '$1',
      driver === 'sqlserver' ? '@p1' : '$2'
    ];
    const values: unknown[] = [id, this.stateId]; // Same OBJECTID, new state
    let paramIndex = 2;

    for (const field of writableFields) {
      const value = mergedAttributes[field.name];
      if (value !== undefined) {
        columns.push(this.quoteId(field.name));
        params.push(driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`);
        values.push(value);
        paramIndex++;
      }
    }

    // Handle geometry (use updated or existing)
    const geometry = attributes[shapeField!] as Geometry | undefined ?? current.geometry;
    if (shapeField && geometry && isValidGeometry(geometry)) {
      const srid = options?.srid ?? geometry.srid ?? 0;
      const wkt = geometryToWkt(geometry);

      columns.push(this.quoteId(shapeField));
      if (driver === 'sqlserver') {
        params.push(`geometry::STGeomFromText(@p${paramIndex}, ${srid})`);
        values.push(wkt);
      } else {
        params.push(`ST_GeomFromText($${paramIndex + 1}, ${srid})`);
        values.push(wkt);
      }
      paramIndex++;
    }

    const insertSql = `
      INSERT INTO ${addsTable} (${columns.join(', ')})
      VALUES (${params.join(', ')})
    `;

    await this.connection.execute(insertSql, values);

    // Track modified table for discard cleanup
    this.modifiedTables.add(regId);

    // Track for undo/redo
    this.undoStack.push({
      type: 'update',
      tableName,
      objectId: id,
      previousAttributes: { ...current.attributes },
      previousGeometry: current.geometry,
      newAttributes: { ...attributes },
      newGeometry: (attributes[shapeField!] as Geometry) ?? null,
      wasInAddsTable: false, // Was not in A table before, now has D+A entries
      srid: options?.srid,
    });
    this.redoStack = [];

    return true;
  }

  /**
   * Delete a feature from a versioned table
   *
   * If the feature was added in the current state (A table), removes it from A table.
   * If the feature is from the base table or an earlier state, marks as deleted in D table.
   *
   * @param tableName Name of the table
   * @param id OBJECTID of the feature to delete
   * @returns true if deleted, false if not found
   */
  async delete(tableName: string, id: number): Promise<boolean> {
    this.ensureOpen();

    const table = await this.getTable(tableName);
    const tableInfo = await this.getTableInfo(tableName);

    if (!tableInfo.isVersioned) {
      throw new Error(`Table ${tableName} is not versioned. Use table.delete() for direct edits.`);
    }

    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);

    // Verify feature exists (in versioned view)
    const current = await this.getVersionedFeature(table, tableInfo, id);
    if (!current) {
      return false;
    }

    // Check if this feature exists in the A table for current state
    const existsInAdds = await this.existsInAddsTable(tableInfo, id);

    if (existsInAdds) {
      // Feature was added in current state - just DELETE from A table
      const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
      const sql = driver === 'sqlserver'
        ? `DELETE FROM ${addsTable} WHERE OBJECTID = @p0 AND SDE_STATE_ID = @p1`
        : `DELETE FROM ${addsTable} WHERE objectid = $1 AND sde_state_id = $2`;

      await this.connection.execute(sql, [id, this.stateId]);

      // Track modified table for discard cleanup
      this.modifiedTables.add(regId);

      // Track for undo/redo
      this.undoStack.push({
        type: 'delete',
        tableName,
        objectId: id,
        previousAttributes: { ...current.attributes },
        previousGeometry: current.geometry,
        wasInAddsTable: true, // Was in A table
      });
      this.redoStack = [];

      return true;
    }

    // Feature is from base table or earlier state - mark as deleted in D table
    const deletesTable = `${schema}.${this.quoteId(`D${regId}`)}`;
    const sql = driver === 'sqlserver'
      ? `INSERT INTO ${deletesTable} (SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT) VALUES (@p0, @p1, @p2)`
      : `INSERT INTO ${deletesTable} (sde_state_id, sde_deletes_row_id, deleted_at) VALUES ($1, $2, $3)`;

    await this.connection.execute(sql, [this.stateId, id, this.stateId]);

    // Track modified table for discard cleanup
    this.modifiedTables.add(regId);

    // Track for undo/redo
    this.undoStack.push({
      type: 'delete',
      tableName,
      objectId: id,
      previousAttributes: { ...current.attributes },
      previousGeometry: current.geometry,
      wasInAddsTable: false, // Was from base table
    });
    this.redoStack = [];

    return true;
  }

  /**
   * Delete multiple features from a versioned table
   * @param tableName Name of the table
   * @param ids OBJECTIDs of features to delete
   * @returns Number of features marked as deleted
   */
  async deleteMany(tableName: string, ids: number[]): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const deleted = await this.delete(tableName, id);
      if (deleted) count++;
    }
    return count;
  }

  /**
   * Save changes by pointing the version at this session's child state.
   *
   * Uses compare-and-swap: the UPDATE only succeeds if the version still
   * points at the parent state observed when the session started. If another
   * session has saved in the meantime, this throws and the caller must
   * reconcile (pull the other session's changes) and retry.
   */
  async save(): Promise<void> {
    this.ensureOpen();

    const driver = this.connection.driver;
    const sql =
      driver === 'sqlserver'
        ? `UPDATE sde.SDE_versions SET state_id = @p0
           WHERE owner = @p1 AND name = @p2 AND state_id = @p3`
        : `UPDATE sde.sde_versions SET state_id = $1
           WHERE owner = $2 AND name = $3 AND state_id = $4`;

    const result = await this.connection.execute(sql, [
      this.stateId,
      this.versionInfo.owner,
      this.versionInfo.name,
      this.parentStateId,
    ]);

    if (result.rowsAffected === 0) {
      throw new Error(
        `Cannot save: version ${this.versionName} was modified by another session ` +
          `since this session started (expected state ${this.parentStateId}). ` +
          `Reconcile and start a new session.`
      );
    }

    this.sessionState = 'saved';
  }

  /**
   * Get schema for a registration ID by looking up in cache or querying the registry
   */
  private async getSchemaForRegistrationId(registrationId: number): Promise<string> {
    // Check cache first
    for (const [, info] of this.tableInfoCache) {
      if (info.registrationId === registrationId) {
        return info.schema;
      }
    }

    // Query SDE_table_registry
    const driver = this.connection.driver;
    const sql = driver === 'sqlserver'
      ? `SELECT owner FROM sde.SDE_table_registry WHERE registration_id = @p0`
      : `SELECT owner FROM sde.sde_table_registry WHERE registration_id = $1`;

    const result = await this.connection.query<{ owner: string }>(sql, [registrationId]);
    return result[0]?.owner ?? 'sde';
  }

  /**
   * Discard all changes made in this edit session.
   *
   * Releases the state lock, then deletes the child state and its A/D entries
   * atomically. If anything fails, the session is left open for retry.
   *
   * Order matters: SDE_state_locks rows referencing the state must be cleared
   * before the state row, otherwise the FK on SDE_state_locks.state_id rejects
   * the delete. deleteChildState handles that ordering internally; we also
   * clear our cached sdeId after a successful release so close() doesn't try
   * a second release.
   *
   * @throws Error if cleanup fails (session remains open for retry)
   */
  async discard(): Promise<void> {
    this.ensureOpen();

    const wasInTransaction = this.connection.inTransaction();
    if (!wasInTransaction) await this.connection.beginTransaction();

    try {
      const registeredTables = await this.getModifiedTableInfo();

      // Release the lock (still inside this transaction) before deleteChildState
      // tries to remove the state row. deleteChildState also defends with its own
      // DELETE on SDE_state_locks, but releasing here first keeps state ownership
      // semantics clean and avoids leaving a stale row if cleanup fails partway.
      if (this.stateLockSdeId !== null) {
        await releaseStateLock(this.connection, this.stateId, this.stateLockSdeId);
      }

      await deleteChildState(this.connection, this.stateId, registeredTables);

      if (!wasInTransaction) await this.connection.commitTransaction();
      this.stateLockSdeId = null;
    } catch (error) {
      if (!wasInTransaction) await this.connection.rollbackTransaction();
      // Leave session 'open' so the caller can retry. Preserve the cause.
      throw new Error(
        `Failed to discard changes: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }

    this.modifiedTables.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.sessionState = 'discarded';
  }

  /**
   * Close the edit session.
   *
   * Releases the state lock if it's still held (e.g., after save() or when the
   * session ends without discard()). Lock release is best-effort: a failure
   * here logs a warning but doesn't fail close, since the orphaned lock will
   * eventually be cleared by a maintenance compress.
   *
   * Note: close() does not auto-discard unsaved changes. Call discard() first
   * if you want to cancel uncommitted edits, or save() to confirm them.
   */
  async close(): Promise<void> {
    if (this.stateLockSdeId !== null) {
      try {
        await releaseStateLock(this.connection, this.stateId, this.stateLockSdeId);
      } catch (e) {
        // A swallowed unlock failure leaves a row in SDE_state_locks that
        // compress will respect forever, so the operator needs to see this.
        this.geodatabase.logger.warn(
          `Failed to release state lock for state ${this.stateId}`,
          e
        );
      }
      this.stateLockSdeId = null;
    }

    this.tableCache.clear();
    this.tableInfoCache.clear();
    this.modifiedTables.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.sessionState = 'closed';
  }

  /**
   * Get registration info for all tables modified in this session.
   * Used by discard() to know which A/D tables need cleanup.
   */
  private async getModifiedTableInfo(): Promise<Array<{ schema: string; registrationId: number }>> {
    const result: Array<{ schema: string; registrationId: number }> = [];
    for (const registrationId of this.modifiedTables) {
      const schema = await this.getSchemaForRegistrationId(registrationId);
      result.push({ schema, registrationId });
    }
    return result;
  }

  /**
   * Ensure the session is open for editing
   */
  private ensureOpen(): void {
    if (this.sessionState !== 'open') {
      throw new Error(`Edit session is ${this.sessionState}, cannot make edits`);
    }
  }

  // ============================================================
  // UNDO / REDO
  // ============================================================

  /**
   * Check if there are operations to undo
   */
  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Check if there are operations to redo
   */
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Get the number of undoable operations
   */
  get undoCount(): number {
    return this.undoStack.length;
  }

  /**
   * Get the number of redoable operations
   */
  get redoCount(): number {
    return this.redoStack.length;
  }

  /**
   * Undo the last operation.
   *
   * @returns Description of the undone operation, or null if nothing to undo
   *
   * @example
   * ```typescript
   * const session = await EditSession.start(egdb, 'sde.DEFAULT');
   * const id = await session.insert('PARCELS', { attributes: { Name: 'Test' } });
   *
   * // Undo the insert
   * const undone = await session.undo();
   * console.log(undone); // { type: 'insert', tableName: 'PARCELS', objectId: 123 }
   *
   * // Redo the insert
   * await session.redo();
   * ```
   */
  async undo(): Promise<{ type: EditOperationType; tableName: string; objectId: number } | null> {
    this.ensureOpen();

    const operation = this.undoStack.pop();
    if (!operation) {
      return null;
    }

    await this.reverseOperation(operation);
    this.redoStack.push(operation);

    return {
      type: operation.type,
      tableName: operation.tableName,
      objectId: operation.objectId,
    };
  }

  /**
   * Redo the last undone operation.
   *
   * @returns Description of the redone operation, or null if nothing to redo
   */
  async redo(): Promise<{ type: EditOperationType; tableName: string; objectId: number } | null> {
    this.ensureOpen();

    const operation = this.redoStack.pop();
    if (!operation) {
      return null;
    }

    await this.reapplyOperation(operation);
    this.undoStack.push(operation);

    return {
      type: operation.type,
      tableName: operation.tableName,
      objectId: operation.objectId,
    };
  }

  /**
   * Reverse an operation (for undo)
   */
  private async reverseOperation(op: EditOperation): Promise<void> {
    const tableInfo = await this.getTableInfo(op.tableName);
    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
    const deletesTable = `${schema}.${this.quoteId(`D${regId}`)}`;

    switch (op.type) {
      case 'insert':
        // Reverse INSERT: delete from A table
        {
          const sql = driver === 'sqlserver'
            ? `DELETE FROM ${addsTable} WHERE OBJECTID = @p0 AND SDE_STATE_ID = @p1`
            : `DELETE FROM ${addsTable} WHERE objectid = $1 AND sde_state_id = $2`;
          await this.connection.execute(sql, [op.objectId, this.stateId]);
        }
        break;

      case 'update':
        if (op.wasInAddsTable) {
          // Was already in A table - restore previous values
          await this.restoreATableRow(tableInfo, op.objectId, op.previousAttributes!, op.previousGeometry, op.srid);
        } else {
          // Was D+A approach - remove from both tables
          {
            const delASql = driver === 'sqlserver'
              ? `DELETE FROM ${addsTable} WHERE OBJECTID = @p0 AND SDE_STATE_ID = @p1`
              : `DELETE FROM ${addsTable} WHERE objectid = $1 AND sde_state_id = $2`;
            await this.connection.execute(delASql, [op.objectId, this.stateId]);

            const delDSql = driver === 'sqlserver'
              ? `DELETE FROM ${deletesTable} WHERE SDE_DELETES_ROW_ID = @p0 AND SDE_STATE_ID = @p1`
              : `DELETE FROM ${deletesTable} WHERE sde_deletes_row_id = $1 AND sde_state_id = $2`;
            await this.connection.execute(delDSql, [op.objectId, this.stateId]);
          }
        }
        break;

      case 'delete':
        if (op.wasInAddsTable) {
          // Was in A table - re-insert
          await this.reinsertToATable(tableInfo, op.objectId, op.previousAttributes!, op.previousGeometry, op.srid);
        } else {
          // Was marked in D table - remove from D table
          const sql = driver === 'sqlserver'
            ? `DELETE FROM ${deletesTable} WHERE SDE_DELETES_ROW_ID = @p0 AND SDE_STATE_ID = @p1`
            : `DELETE FROM ${deletesTable} WHERE sde_deletes_row_id = $1 AND sde_state_id = $2`;
          await this.connection.execute(sql, [op.objectId, this.stateId]);
        }
        break;
    }
  }

  /**
   * Reapply an operation (for redo)
   */
  private async reapplyOperation(op: EditOperation): Promise<void> {
    const tableInfo = await this.getTableInfo(op.tableName);
    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
    const deletesTable = `${schema}.${this.quoteId(`D${regId}`)}`;

    switch (op.type) {
      case 'insert':
        // Redo INSERT: re-insert to A table
        await this.reinsertToATable(tableInfo, op.objectId, op.newAttributes!, op.newGeometry, op.srid);
        break;

      case 'update':
        if (op.wasInAddsTable) {
          // Was already in A table - apply new values
          await this.restoreATableRow(tableInfo, op.objectId, op.newAttributes!, op.newGeometry, op.srid);
        } else {
          // Need D+A approach again
          {
            // Insert D table entry
            const delSql = driver === 'sqlserver'
              ? `INSERT INTO ${deletesTable} (SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT) VALUES (@p0, @p1, @p2)`
              : `INSERT INTO ${deletesTable} (sde_state_id, sde_deletes_row_id, deleted_at) VALUES ($1, $2, $3)`;
            await this.connection.execute(delSql, [this.stateId, op.objectId, this.stateId]);

            // Insert A table entry with merged values
            const merged = { ...op.previousAttributes!, ...op.newAttributes! };
            await this.reinsertToATable(tableInfo, op.objectId, merged, op.newGeometry ?? op.previousGeometry, op.srid);
          }
        }
        break;

      case 'delete':
        if (op.wasInAddsTable) {
          // Was in A table - delete from A table
          const sql = driver === 'sqlserver'
            ? `DELETE FROM ${addsTable} WHERE OBJECTID = @p0 AND SDE_STATE_ID = @p1`
            : `DELETE FROM ${addsTable} WHERE objectid = $1 AND sde_state_id = $2`;
          await this.connection.execute(sql, [op.objectId, this.stateId]);
        } else {
          // Mark in D table again
          const sql = driver === 'sqlserver'
            ? `INSERT INTO ${deletesTable} (SDE_STATE_ID, SDE_DELETES_ROW_ID, DELETED_AT) VALUES (@p0, @p1, @p2)`
            : `INSERT INTO ${deletesTable} (sde_state_id, sde_deletes_row_id, deleted_at) VALUES ($1, $2, $3)`;
          await this.connection.execute(sql, [this.stateId, op.objectId, this.stateId]);
        }
        break;
    }
  }

  /**
   * Restore values in an A table row
   */
  private async restoreATableRow(
    tableInfo: TableInfo,
    objectId: number,
    attributes: Record<string, unknown>,
    geometry: Geometry | null | undefined,
    srid?: number
  ): Promise<void> {
    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
    const shapeField = tableInfo.shapeFieldName;

    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 0;

    for (const [key, value] of Object.entries(attributes)) {
      const keyLower = key.toLowerCase();
      if (keyLower === 'objectid' || keyLower === 'sde_state_id') continue;
      if (shapeField && keyLower === shapeField.toLowerCase()) continue;

      setClauses.push(
        `${this.quoteId(key)} = ${driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`}`
      );
      values.push(value);
      paramIndex++;
    }

    // Handle geometry
    if (shapeField && geometry && isValidGeometry(geometry)) {
      const geomSrid = srid ?? geometry.srid ?? 0;
      const wkt = geometryToWkt(geometry);

      if (driver === 'sqlserver') {
        setClauses.push(`${this.quoteId(shapeField)} = geometry::STGeomFromText(@p${paramIndex}, ${geomSrid})`);
      } else {
        setClauses.push(`${this.quoteId(shapeField)} = ST_GeomFromText($${paramIndex + 1}, ${geomSrid})`);
      }
      values.push(wkt);
      paramIndex++;
    }

    if (setClauses.length === 0) return;

    values.push(objectId, this.stateId);
    const oidParam = driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`;
    const stateParam = driver === 'sqlserver' ? `@p${paramIndex + 1}` : `$${paramIndex + 2}`;

    const sql = `UPDATE ${addsTable} SET ${setClauses.join(', ')} WHERE OBJECTID = ${oidParam} AND SDE_STATE_ID = ${stateParam}`;
    await this.connection.execute(sql, values);
  }

  /**
   * Re-insert a row to the A table
   */
  private async reinsertToATable(
    tableInfo: TableInfo,
    objectId: number,
    attributes: Record<string, unknown>,
    geometry: Geometry | null | undefined,
    srid?: number
  ): Promise<void> {
    const table = await this.getTable(tableInfo.name);
    const regId = requireRegistrationId(tableInfo);
    const driver = this.connection.driver;
    const schema = this.quoteId(tableInfo.schema);
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
    const shapeField = tableInfo.shapeFieldName;
    const metadata = table.metadata;

    const writableFields = metadata.fields.filter(f =>
      f.type !== 6 && // OID
      f.name.toLowerCase() !== 'objectid' &&
      f.name.toLowerCase() !== 'globalid' &&
      f.type !== 7 // GEOMETRY
    );

    const columns: string[] = [
      this.quoteId('OBJECTID'),
      this.quoteId('SDE_STATE_ID')
    ];
    const params: string[] = [
      driver === 'sqlserver' ? '@p0' : '$1',
      driver === 'sqlserver' ? '@p1' : '$2'
    ];
    const values: unknown[] = [objectId, this.stateId];
    let paramIndex = 2;

    for (const field of writableFields) {
      const value = attributes[field.name];
      if (value !== undefined) {
        columns.push(this.quoteId(field.name));
        params.push(driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`);
        values.push(value);
        paramIndex++;
      }
    }

    // Handle geometry
    if (shapeField && geometry && isValidGeometry(geometry)) {
      const geomSrid = srid ?? geometry.srid ?? 0;
      const wkt = geometryToWkt(geometry);

      columns.push(this.quoteId(shapeField));
      if (driver === 'sqlserver') {
        params.push(`geometry::STGeomFromText(@p${paramIndex}, ${geomSrid})`);
      } else {
        params.push(`ST_GeomFromText($${paramIndex + 1}, ${geomSrid})`);
      }
      values.push(wkt);
    }

    const sql = `INSERT INTO ${addsTable} (${columns.join(', ')}) VALUES (${params.join(', ')})`;
    await this.connection.execute(sql, values);
  }
}
