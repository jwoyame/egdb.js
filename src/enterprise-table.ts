/**
 * EnterpriseTable - Read and write features from an enterprise geodatabase table
 */

import type { IDatabaseConnection } from './connections/connection';
import { parseDefinitionXml } from './parsers/gdb-items-parser';
import { parseWkb } from './parsers/geometry-parser';
import { geometryToWkt, isValidGeometry } from './parsers/geometry-writer';
import type {
  TableInfo,
  TableMetadata,
  FieldDefinition,
  Feature,
  Geometry,
  FieldType,
  QueryOptions,
  SpatialQueryOptions,
  SpatialQueryGeometry,
  SpatialRelationship,
} from './types';
import { buildIntegerList } from './utils/sql-helpers';

/** Options for insert operations */
export interface InsertOptions {
  /** SRID to use for geometry (defaults to table's spatial reference) */
  srid?: number;
}

/** Options for update operations */
export interface UpdateOptions {
  /** SRID to use for geometry updates */
  srid?: number;
}

/** Function type for getting version state lineage */
type StateLineageGetter = (versionName: string) => Promise<number[] | null>;

/** Function type for setting version context */
type VersionSetter = (versionName: string) => Promise<void>;

export class EnterpriseTable {
  private connection: IDatabaseConnection;
  private tableInfo: TableInfo;
  private _metadata: TableMetadata | null = null;
  private getStateLineage?: StateLineageGetter;
  private setVersionContext?: VersionSetter;

  private constructor(
    connection: IDatabaseConnection,
    tableInfo: TableInfo,
    getStateLineage?: StateLineageGetter,
    setVersionContext?: VersionSetter
  ) {
    this.connection = connection;
    this.tableInfo = tableInfo;
    this.getStateLineage = getStateLineage;
    this.setVersionContext = setVersionContext;
  }

  /**
   * Open a table for reading
   */
  static async open(
    connection: IDatabaseConnection,
    tableInfo: TableInfo,
    getStateLineage?: StateLineageGetter,
    setVersionContext?: VersionSetter
  ): Promise<EnterpriseTable> {
    const table = new EnterpriseTable(connection, tableInfo, getStateLineage, setVersionContext);
    await table.loadMetadata();
    return table;
  }

  /**
   * Get table name
   */
  get name(): string {
    return this.tableInfo.name;
  }

  /**
   * Get table metadata
   */
  get metadata(): TableMetadata {
    if (!this._metadata) {
      throw new Error('Metadata not loaded');
    }
    return this._metadata;
  }

  /**
   * Check if table is versioned
   */
  get isVersioned(): boolean {
    return this.tableInfo.isVersioned ?? false;
  }

  /**
   * Get registration ID (for versioned tables)
   */
  get registrationId(): number | undefined {
    return this.tableInfo.registrationId;
  }

  /**
   * Quote identifier based on database driver
   */
  private quoteId(name: string): string {
    return this.connection.driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
  }

  /**
   * Whether the table's metadata advertises an OBJECTID column. Views
   * may not have one; getFeature/getFeatures rely on it for the WHERE
   * clause and surface a clear error when missing.
   */
  private hasObjectIdColumn(): boolean {
    return !!this._metadata?.fields.some(f => f.name.toLowerCase() === 'objectid');
  }

  /**
   * Get fully qualified table name
   */
  private get qualifiedTableName(): string {
    return `${this.quoteId(this.tableInfo.schema)}.${this.quoteId(this.tableInfo.name)}`;
  }

  /**
   * Load table metadata from GDB_ITEMS Definition XML
   */
  private async loadMetadata(): Promise<void> {
    // Get Definition XML from GDB_ITEMS
    const sql = this.connection.driver === 'sqlserver'
      ? `SELECT Definition, DatasetSubtype1 FROM sde.GDB_ITEMS WHERE PhysicalName = @p0`
      : `SELECT "definition" as "Definition", "datasetsubtype1" as "DatasetSubtype1" FROM sde.gdb_items WHERE "physicalname" = $1`;

    const rows = await this.connection.query<{
      Definition: string;
      DatasetSubtype1: number;
    }>(sql, [this.tableInfo.physicalName]);

    let fields: FieldDefinition[] = [];
    let geometryType = this.tableInfo.geometryType;

    if (rows.length > 0 && rows[0]?.Definition) {
      const parsed = parseDefinitionXml(rows[0].Definition);
      fields = parsed.fields;
      // Use geometry type from Definition XML if available (more accurate)
      if (parsed.geometryType) {
        geometryType = parsed.geometryType;
      }
    }

    // Fallback to INFORMATION_SCHEMA if no fields from Definition XML
    if (fields.length === 0) {
      fields = await this.getFieldsFromSchema();
    }

    // Get feature count
    const countSql = `SELECT COUNT(*) as cnt FROM ${this.qualifiedTableName}`;
    const countResult = await this.connection.query<{ cnt: number }>(countSql);
    const featureCount = countResult[0]?.cnt ?? 0;

    this._metadata = {
      name: this.tableInfo.name,
      physicalName: this.tableInfo.physicalName,
      schema: this.tableInfo.schema,
      featureCount,
      fields,
      isFeatureClass: this.tableInfo.isFeatureClass,
      geometryType,
      shapeFieldName: this.tableInfo.shapeFieldName,
    };
  }

  /**
   * Get fields from INFORMATION_SCHEMA (fallback)
   */
  private async getFieldsFromSchema(): Promise<FieldDefinition[]> {
    const sql = this.connection.driver === 'sqlserver'
      ? `
        SELECT
          COLUMN_NAME,
          DATA_TYPE,
          CHARACTER_MAXIMUM_LENGTH,
          NUMERIC_PRECISION,
          NUMERIC_SCALE,
          IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1
        ORDER BY ORDINAL_POSITION
      `
      : `
        SELECT
          column_name as "COLUMN_NAME",
          data_type as "DATA_TYPE",
          character_maximum_length as "CHARACTER_MAXIMUM_LENGTH",
          numeric_precision as "NUMERIC_PRECISION",
          numeric_scale as "NUMERIC_SCALE",
          is_nullable as "IS_NULLABLE"
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `;

    const rows = await this.connection.query<{
      COLUMN_NAME: string;
      DATA_TYPE: string;
      CHARACTER_MAXIMUM_LENGTH?: number;
      NUMERIC_PRECISION?: number;
      NUMERIC_SCALE?: number;
      IS_NULLABLE: string;
    }>(sql, [this.tableInfo.schema, this.tableInfo.name]);

    return rows.map((row) => ({
      name: row.COLUMN_NAME,
      type: this.mapSqlType(row.DATA_TYPE),
      typeName: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      length: row.CHARACTER_MAXIMUM_LENGTH,
      precision: row.NUMERIC_PRECISION,
      scale: row.NUMERIC_SCALE,
    }));
  }

  /**
   * Map SQL Server data type to FieldType
   */
  private mapSqlType(sqlType: string): FieldType {
    const typeMap: Record<string, FieldType> = {
      int: 1, // INTEGER
      smallint: 0, // SMALLINTEGER
      bigint: 13, // INT64
      float: 3, // DOUBLE
      real: 2, // FLOAT
      decimal: 3,
      numeric: 3,
      varchar: 4, // STRING
      nvarchar: 4,
      char: 4,
      nchar: 4,
      text: 4,
      ntext: 4,
      datetime: 5, // DATE
      datetime2: 5,
      date: 14, // DATEONLY
      time: 15, // TIMEONLY
      uniqueidentifier: 10, // GUID
      geometry: 7, // GEOMETRY
      geography: 7,
      varbinary: 8, // BLOB
      image: 8,
    };
    return (typeMap[sqlType.toLowerCase()] ?? 4) as FieldType; // Default to STRING
  }

  /**
   * Build SELECT clause with geometry as WKB
   * @param outFields Specific fields to include (optional)
   * @param forVersionedQuery If true, always uses explicit column names (no *)
   */
  private buildSelectClause(outFields?: string[], forVersionedQuery = false): string {
    const shapeField = this.tableInfo.shapeFieldName;
    const driver = this.connection.driver;

    // Get non-geometry columns, filtering out computed/virtual columns
    const isValidColumn = (name: string) => {
      // Exclude geometry field (handled separately)
      if (shapeField && name.toLowerCase() === shapeField.toLowerCase()) return false;
      // Exclude computed columns (contain parentheses or dots followed by function names)
      if (name.includes('(') || name.includes(')')) return false;
      if (/\.\w+\(/.test(name)) return false;
      // Exclude SDE_STATE_ID - only present in A tables, not base tables
      if (name.toLowerCase() === 'sde_state_id') return false;
      return true;
    };

    let columns: string;
    if (outFields && outFields.length > 0) {
      columns = outFields
        .filter(isValidColumn)
        .map((f) => this.quoteId(f))
        .join(', ');
    } else if (this._metadata?.fields && this._metadata.fields.length > 0) {
      columns = this._metadata.fields
        .filter((f) => isValidColumn(f.name))
        .map((f) => this.quoteId(f.name))
        .join(', ');
    } else if (forVersionedQuery) {
      // For versioned queries, we MUST have explicit columns
      // This should not happen if metadata is loaded properly
      throw new Error('Cannot build versioned query without field metadata');
    } else {
      // Fallback to * if no field info available (non-versioned only)
      columns = '*';
    }

    if (!shapeField) {
      // No geometry - return just the columns
      return columns;
    }

    // Add geometry as WKB
    const qShape = this.quoteId(shapeField);
    const qWkb = this.quoteId(`${shapeField}_WKB`);
    const qSrid = this.quoteId(`${shapeField}_SRID`);

    const geomColumns = driver === 'sqlserver'
      ? `${qShape}.STAsBinary() as ${qWkb}, ${qShape}.STSrid as ${qSrid}`
      : `ST_AsBinary(${qShape}) as ${qWkb}, ST_SRID(${qShape}) as ${qSrid}`;

    // Handle case where columns is * (can't combine with explicit geometry columns easily)
    if (columns === '*') {
      return `*, ${geomColumns}`;
    }

    return `${columns}, ${geomColumns}`;
  }

  /**
   * Build a query using the enterprise versioned view (*_evw).
   * Assumes setVersionContext has already been called.
   */
  private buildEvwQuery(whereClause?: string, outFields?: string[]): string {
    const evwViewName = this.tableInfo.evwViewName!;
    const selectFields = this.buildSelectClause(outFields);

    let sql = `SELECT ${selectFields} FROM ${evwViewName}`;

    if (whereClause) {
      sql += ` WHERE ${whereClause}`;
    }

    return sql;
  }

  /**
   * Build a versioned query that combines base table with A/D delta tables
   */
  private buildVersionedQuery(
    stateIds: number[],
    whereClause?: string,
    outFields?: string[]
  ): string {
    const regId = this.tableInfo.registrationId;
    const schema = this.quoteId(this.tableInfo.schema);
    const driver = this.connection.driver;

    // Build SELECT clause with explicit columns (required for UNION)
    const selectFields = this.buildSelectClause(outFields, true);

    // A and D table names (e.g., a18, D18)
    const addsTable = `${schema}.${this.quoteId(`a${regId}`)}`;
    const deletesTable = `${schema}.${this.quoteId(`D${regId}`)}`;

    // Build state ID list for IN clause
    const stateIdList = buildIntegerList(stateIds, 'versionedQuery');

    // Base WHERE clause
    const baseWhere = whereClause ? ` AND (${whereClause})` : '';

    // Quote OBJECTID based on driver
    const qObjectId = driver === 'sqlserver' ? '[OBJECTID]' : '"objectid"';

    // Query: Base table rows not in deletes UNION adds rows
    // Base table contains rows at state 0 (initial state)
    const sql = `
      SELECT ${selectFields}
      FROM ${this.qualifiedTableName} b
      WHERE b.${qObjectId} NOT IN (
        SELECT SDE_DELETES_ROW_ID FROM ${deletesTable}
        WHERE SDE_STATE_ID IN (${stateIdList})
      )${baseWhere}
      UNION ALL
      SELECT ${selectFields}
      FROM ${addsTable}
      WHERE SDE_STATE_ID IN (${stateIdList})${baseWhere}
    `;

    return sql;
  }

  // ============================================================
  // SPATIAL QUERY SUPPORT
  // ============================================================

  /**
   * Convert a spatial query geometry to SQL expression
   */
  private geometryToSqlExpr(geom: SpatialQueryGeometry): string {
    const driver = this.connection.driver;

    // Handle WKT input
    if ('wkt' in geom) {
      const srid = geom.srid ?? 0;
      return driver === 'sqlserver'
        ? `geometry::STGeomFromText('${geom.wkt}', ${srid})`
        : `ST_GeomFromText('${geom.wkt}', ${srid})`;
    }

    // Handle envelope (bounding box) input
    if ('envelope' in geom) {
      const [minX, minY, maxX, maxY] = geom.envelope;
      const srid = geom.srid ?? 0;
      const wkt = `POLYGON((${minX} ${minY}, ${maxX} ${minY}, ${maxX} ${maxY}, ${minX} ${maxY}, ${minX} ${minY}))`;
      return driver === 'sqlserver'
        ? `geometry::STGeomFromText('${wkt}', ${srid})`
        : `ST_GeomFromText('${wkt}', ${srid})`;
    }

    // Handle WKB input
    if ('wkb' in geom) {
      const srid = geom.srid ?? 0;
      const hex = geom.wkb.toString('hex');
      return driver === 'sqlserver'
        ? `geometry::STGeomFromWKB(0x${hex}, ${srid})`
        : `ST_GeomFromWKB('\\x${hex}', ${srid})`;
    }

    // Handle GeoJSON geometry
    // Note: WKT is safe to embed directly since geometryToWkt only outputs
    // numeric coordinates - no user strings that could contain SQL injection
    const srid = geom.srid ?? 0;
    const wkt = geometryToWkt(geom);
    return driver === 'sqlserver'
      ? `geometry::STGeomFromText('${wkt}', ${srid})`
      : `ST_GeomFromText('${wkt}', ${srid})`;
  }

  /**
   * Build SQL Server spatial WHERE clause
   */
  private buildSqlServerSpatialClause(
    shapeField: string,
    geomExpr: string,
    relationship: SpatialRelationship,
    distance?: number
  ): string {
    const qShape = this.quoteId(shapeField);

    // Distance query
    if (distance !== undefined) {
      return `${qShape}.STDistance(${geomExpr}) <= ${distance}`;
    }

    // Spatial relationship methods
    const methods: Record<SpatialRelationship, string> = {
      intersects: 'STIntersects',
      contains: 'STContains',
      within: 'STWithin',
      touches: 'STTouches',
      overlaps: 'STOverlaps',
      crosses: 'STCrosses',
      disjoint: 'STDisjoint',
    };

    const method = methods[relationship];
    return `${qShape}.${method}(${geomExpr}) = 1`;
  }

  /**
   * Build PostgreSQL/PostGIS spatial WHERE clause
   */
  private buildPostgreSpatialClause(
    shapeField: string,
    geomExpr: string,
    relationship: SpatialRelationship,
    distance?: number
  ): string {
    const qShape = this.quoteId(shapeField);

    // Distance query (uses ST_DWithin for efficiency)
    if (distance !== undefined) {
      return `ST_DWithin(${qShape}, ${geomExpr}, ${distance})`;
    }

    // Spatial relationship functions
    const functions: Record<SpatialRelationship, string> = {
      intersects: 'ST_Intersects',
      contains: 'ST_Contains',
      within: 'ST_Within',
      touches: 'ST_Touches',
      overlaps: 'ST_Overlaps',
      crosses: 'ST_Crosses',
      disjoint: 'ST_Disjoint',
    };

    const func = functions[relationship];
    return `${func}(${qShape}, ${geomExpr})`;
  }

  /**
   * Build spatial WHERE clause based on query options
   */
  private buildSpatialClause(options: SpatialQueryOptions): string | null {
    if (!options.geometry) return null;

    const shapeField = this.tableInfo.shapeFieldName;
    if (!shapeField) {
      throw new Error(`Cannot perform spatial query on table ${this.name}: no geometry field`);
    }

    const geomExpr = this.geometryToSqlExpr(options.geometry);
    const relationship = options.spatialRelationship ?? 'intersects';
    const distance = options.distance;

    if (this.connection.driver === 'sqlserver') {
      return this.buildSqlServerSpatialClause(shapeField, geomExpr, relationship, distance);
    } else {
      return this.buildPostgreSpatialClause(shapeField, geomExpr, relationship, distance);
    }
  }

  /**
   * Build distance SELECT expression for returnDistance option
   */
  private buildDistanceSelect(options: SpatialQueryOptions): string | null {
    if (!options.returnDistance || !options.geometry) return null;

    const shapeField = this.tableInfo.shapeFieldName;
    if (!shapeField) return null;

    const geomExpr = this.geometryToSqlExpr(options.geometry);
    const qShape = this.quoteId(shapeField);

    if (this.connection.driver === 'sqlserver') {
      return `${qShape}.STDistance(${geomExpr}) as _distance`;
    } else {
      return `ST_Distance(${qShape}, ${geomExpr}) as _distance`;
    }
  }

  /**
   * Stream all features from the table
   */
  async *stream(options?: SpatialQueryOptions): AsyncIterable<Feature> {
    const shapeField = this.tableInfo.shapeFieldName;
    const driver = this.connection.driver;

    let sql: string;

    // Check if this is a versioned query
    if (options?.version && this.tableInfo.isVersioned) {
      // Prefer using enterprise versioned view (*_evw) if available
      if (this.tableInfo.evwViewName && this.setVersionContext) {
        // Set version context for the session, then query the evw view
        await this.setVersionContext(options.version);
        sql = this.buildEvwQuery(options.where, options.outFields);
      } else if (this.tableInfo.registrationId && this.getStateLineage) {
        // Fall back to manual UNION query using A/D tables
        const stateIds = await this.getStateLineage(options.version);
        if (!stateIds || stateIds.length === 0) {
          throw new Error(`Version not found or has no state lineage: ${options.version}`);
        }
        sql = this.buildVersionedQuery(stateIds, options.where, options.outFields);
      } else {
        throw new Error(`Cannot query version: table ${this.name} missing evw view and state lineage`);
      }
    } else {
      // Non-versioned query (base table only)
      let selectFields = this.buildSelectClause(options?.outFields);

      // Add distance column if requested
      const distanceSelect = options ? this.buildDistanceSelect(options) : null;
      if (distanceSelect) {
        selectFields += `, ${distanceSelect}`;
      }

      sql = `SELECT ${selectFields} FROM ${this.qualifiedTableName}`;

      // Build WHERE clause combining attribute and spatial filters
      const whereParts: string[] = [];

      if (options?.where) {
        // WARNING: This is vulnerable to SQL injection!
        // In production, use parameterized queries with a proper query builder
        whereParts.push(`(${options.where})`);
      }

      // Add spatial filter
      const spatialClause = options ? this.buildSpatialClause(options) : null;
      if (spatialClause) {
        whereParts.push(`(${spatialClause})`);
      }

      if (whereParts.length > 0) {
        sql += ` WHERE ${whereParts.join(' AND ')}`;
      }
    }

    if (options?.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options?.limit) {
      if (driver === 'sqlserver') {
        // SQL Server requires ORDER BY for OFFSET/FETCH syntax
        // If no orderBy specified, default to OBJECTID for deterministic results
        if (!options?.orderBy) {
          sql += ' ORDER BY OBJECTID';
        }
        sql += ` OFFSET ${options.offset ?? 0} ROWS FETCH NEXT ${options.limit} ROWS ONLY`;
      } else {
        // PostgreSQL uses LIMIT/OFFSET (ORDER BY optional but recommended)
        sql += ` LIMIT ${options.limit}`;
        if (options.offset) {
          sql += ` OFFSET ${options.offset}`;
        }
      }
    }

    for await (const row of this.connection.stream(sql)) {
      yield this.rowToFeature(row, shapeField);
    }
  }

  /**
   * Get a single feature by ID
   */
  async getFeature(id: number): Promise<Feature | null> {
    if (!this.hasObjectIdColumn()) {
      throw new Error(`Table ${this.name} has no OBJECTID column; getFeature(id) is not supported. Use stream({ where: '...' }) to query by another key.`);
    }
    const selectFields = this.buildSelectClause();
    const shapeField = this.tableInfo.shapeFieldName;
    const driver = this.connection.driver;

    const param = driver === 'sqlserver' ? '@p0' : '$1';
    const sql = `SELECT ${selectFields} FROM ${this.qualifiedTableName} WHERE ${this.quoteId('OBJECTID')} = ${param}`;

    const rows = await this.connection.query(sql, [id]);

    if (rows.length === 0) return null;

    return this.rowToFeature(rows[0]!, shapeField);
  }

  /**
   * Get multiple features by IDs
   */
  async getFeatures(ids: number[]): Promise<Feature[]> {
    if (ids.length === 0) return [];
    if (!this.hasObjectIdColumn()) {
      throw new Error(`Table ${this.name} has no OBJECTID column; getFeatures(ids) is not supported. Use stream({ where: '...' }) to query by another key.`);
    }

    const selectFields = this.buildSelectClause();
    const shapeField = this.tableInfo.shapeFieldName;
    const driver = this.connection.driver;

    // Build parameterized query
    const params = ids.map((_, i) => driver === 'sqlserver' ? `@p${i}` : `$${i + 1}`).join(', ');
    const sql = `SELECT ${selectFields} FROM ${this.qualifiedTableName} WHERE ${this.quoteId('OBJECTID')} IN (${params})`;

    const rows = await this.connection.query(sql, ids);

    return rows.map((row) => this.rowToFeature(row, shapeField));
  }

  /**
   * Count features (optionally with WHERE clause)
   */
  async count(where?: string): Promise<number> {
    let sql = `SELECT COUNT(*) as cnt FROM ${this.qualifiedTableName}`;

    if (where) {
      sql += ` WHERE ${where}`;
    }

    const result = await this.connection.query<{ cnt: number }>(sql);
    return result[0]?.cnt ?? 0;
  }

  /**
   * Convert a database row to a Feature
   */
  private rowToFeature(row: Record<string, unknown>, shapeField?: string): Feature {
    const id = (row.OBJECTID ?? row.objectid ?? 0) as number;
    const attributes: Record<string, unknown> = {};
    let geometry: Geometry | null = null;

    for (const [key, value] of Object.entries(row)) {
      // Skip geometry WKB/SRID columns from attributes
      if (shapeField && key.toLowerCase().startsWith(shapeField.toLowerCase())) {
        if (key.endsWith('_WKB') && value) {
          const sridKey = key.replace('_WKB', '_SRID');
          const srid = row[sridKey] as number | undefined;
          geometry = parseWkb(value as Buffer, srid) ?? null;
        }
        continue;
      }

      // Skip OBJECTID from attributes (it's the id)
      if (key.toLowerCase() === 'objectid') continue;

      attributes[key] = value;
    }

    return { id, attributes, geometry };
  }

  /**
   * Query features with a WHERE clause
   *
   * @deprecated Use stream({ where: '...' }) instead
   */
  async *query(where: string): AsyncIterable<Feature> {
    yield* this.stream({ where });
  }

  // ============================================================
  // WRITE OPERATIONS
  // ============================================================

  /**
   * Allocate the next OBJECTID from the i-table (index table)
   * Enterprise geodatabases use i-tables to track OBJECTID sequences
   */
  private async allocateNextObjectId(): Promise<number> {
    const regId = this.tableInfo.registrationId;
    if (!regId) {
      throw new Error(`Table ${this.name} is not registered (no registrationId)`);
    }

    const driver = this.connection.driver;
    const schema = this.tableInfo.schema;
    const iTable = `${this.quoteId(schema)}.${this.quoteId(`i${regId}`)}`;

    if (driver === 'sqlserver') {
      // Atomic update and return of next ID
      // The i-table has: id_type, base_id, num_ids, last_id
      // base_id is the next available ID to allocate
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
      // PostgreSQL version
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
   * Insert a new feature into the table
   * @param feature Feature to insert (id is ignored, will be auto-generated)
   * @param options Insert options
   * @returns The new OBJECTID
   */
  async insert(
    feature: Omit<Feature, 'id'> | { attributes: Record<string, unknown>; geometry?: Geometry | null },
    options?: InsertOptions
  ): Promise<number> {
    if (!this._metadata) {
      throw new Error('Metadata not loaded');
    }
    if (this.tableInfo.readOnly) {
      throw new Error(`Table ${this.name} is read-only (opened via openView); insert is not supported`);
    }

    const driver = this.connection.driver;
    const shapeField = this.tableInfo.shapeFieldName;

    // Allocate next OBJECTID from i-table
    const newObjectId = await this.allocateNextObjectId();

    // Get writable fields (exclude OBJECTID and computed fields)
    const writableFields = this._metadata.fields.filter(f =>
      f.type !== 6 && // OID
      f.name.toLowerCase() !== 'objectid' &&
      f.name.toLowerCase() !== 'globalid' &&
      f.type !== 7 // GEOMETRY (handled separately)
    );

    // Build column names and parameter placeholders
    const columns: string[] = [this.quoteId('OBJECTID')];
    const params: string[] = [driver === 'sqlserver' ? '@p0' : '$1'];
    const values: unknown[] = [newObjectId];
    let paramIndex = 1;

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

    // Build INSERT statement
    const sql = `
      INSERT INTO ${this.qualifiedTableName} (${columns.join(', ')})
      VALUES (${params.join(', ')})
    `;

    await this.connection.execute(sql, values);
    return newObjectId;
  }

  /**
   * Insert multiple features in a batch
   * @param features Features to insert
   * @param options Insert options
   * @returns Array of new OBJECTIDs
   */
  async insertMany(
    features: Array<Omit<Feature, 'id'> | { attributes: Record<string, unknown>; geometry?: Geometry | null }>,
    options?: InsertOptions
  ): Promise<number[]> {
    const ids: number[] = [];

    // For now, insert one at a time
    // Future optimization: batch INSERT with multiple VALUE rows
    for (const feature of features) {
      const id = await this.insert(feature, options);
      ids.push(id);
    }

    return ids;
  }

  /**
   * Update an existing feature
   * @param id OBJECTID of the feature to update
   * @param attributes Attributes to update (partial update)
   * @param options Update options
   * @returns true if updated, false if not found
   */
  async update(
    id: number,
    attributes: Partial<Record<string, unknown>>,
    options?: UpdateOptions
  ): Promise<boolean> {
    if (!this._metadata) {
      throw new Error('Metadata not loaded');
    }
    if (this.tableInfo.readOnly) {
      throw new Error(`Table ${this.name} is read-only (opened via openView); update is not supported`);
    }

    const driver = this.connection.driver;
    const shapeField = this.tableInfo.shapeFieldName;

    // Build SET clauses
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 0;

    for (const [key, value] of Object.entries(attributes)) {
      // Skip OBJECTID and geometry (geometry handled separately)
      if (key.toLowerCase() === 'objectid') continue;
      if (shapeField && key.toLowerCase() === shapeField.toLowerCase()) continue;

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
      return false; // Nothing to update
    }

    // Add OBJECTID parameter
    values.push(id);
    const idParam = driver === 'sqlserver' ? `@p${paramIndex}` : `$${paramIndex + 1}`;

    const sql = `
      UPDATE ${this.qualifiedTableName}
      SET ${setClauses.join(', ')}
      WHERE ${this.quoteId('OBJECTID')} = ${idParam}
    `;

    const result = await this.connection.execute(sql, values);
    return result.rowsAffected > 0;
  }

  /**
   * Delete a feature by OBJECTID
   * @param id OBJECTID of the feature to delete
   * @returns true if deleted, false if not found
   */
  async delete(id: number): Promise<boolean> {
    if (this.tableInfo.readOnly) {
      throw new Error(`Table ${this.name} is read-only (opened via openView); delete is not supported`);
    }
    const driver = this.connection.driver;
    const param = driver === 'sqlserver' ? '@p0' : '$1';

    const sql = `DELETE FROM ${this.qualifiedTableName} WHERE ${this.quoteId('OBJECTID')} = ${param}`;
    const result = await this.connection.execute(sql, [id]);

    return result.rowsAffected > 0;
  }

  /**
   * Delete multiple features by OBJECTID
   * @param ids OBJECTIDs of features to delete
   * @returns Number of features deleted
   */
  async deleteMany(ids: number[]): Promise<number> {
    if (this.tableInfo.readOnly) {
      throw new Error(`Table ${this.name} is read-only (opened via openView); deleteMany is not supported`);
    }
    if (ids.length === 0) return 0;

    const driver = this.connection.driver;

    // Build IN clause with parameters
    const params = ids.map((_, i) =>
      driver === 'sqlserver' ? `@p${i}` : `$${i + 1}`
    ).join(', ');

    const sql = `DELETE FROM ${this.qualifiedTableName} WHERE ${this.quoteId('OBJECTID')} IN (${params})`;
    const result = await this.connection.execute(sql, ids);

    return result.rowsAffected;
  }

  /**
   * Close the table (no-op for enterprise, connection is shared)
   */
  async close(): Promise<void> {
    // Nothing to do - connection is managed by EnterpriseGeodatabase
  }
}
