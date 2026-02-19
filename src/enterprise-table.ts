/**
 * EnterpriseTable - Read features from an enterprise geodatabase table
 */

import type { IDatabaseConnection } from './connections/connection';
import { parseDefinitionXml } from './parsers/gdb-items-parser';
import { parseWkb } from './parsers/geometry-parser';
import type {
  TableInfo,
  TableMetadata,
  FieldDefinition,
  Feature,
  Geometry,
  FieldType,
  QueryOptions,
} from './types';

export class EnterpriseTable {
  private connection: IDatabaseConnection;
  private tableInfo: TableInfo;
  private _metadata: TableMetadata | null = null;

  private constructor(connection: IDatabaseConnection, tableInfo: TableInfo) {
    this.connection = connection;
    this.tableInfo = tableInfo;
  }

  /**
   * Open a table for reading
   */
  static async open(connection: IDatabaseConnection, tableInfo: TableInfo): Promise<EnterpriseTable> {
    const table = new EnterpriseTable(connection, tableInfo);
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
   * Load table metadata from GDB_ITEMS Definition XML
   */
  private async loadMetadata(): Promise<void> {
    // Get Definition XML from GDB_ITEMS
    const sql = `
      SELECT Definition, DatasetSubtype1
      FROM sde.GDB_ITEMS
      WHERE PhysicalName = @p0
    `;

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
    const countSql = `SELECT COUNT(*) as cnt FROM [${this.tableInfo.schema}].[${this.tableInfo.name}]`;
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
    const sql = `
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
   */
  private buildSelectClause(outFields?: string[]): string {
    const shapeField = this.tableInfo.shapeFieldName;
    const driver = this.connection.driver;

    if (!shapeField) {
      // No geometry - select all or specified fields
      if (outFields && outFields.length > 0) {
        return outFields.map((f) => `[${f}]`).join(', ');
      }
      return '*';
    }

    // Get non-geometry columns, filtering out computed/virtual columns
    const isValidColumn = (name: string) => {
      // Exclude geometry field
      if (name.toLowerCase() === shapeField.toLowerCase()) return false;
      // Exclude computed columns (contain parentheses or dots followed by function names)
      if (name.includes('(') || name.includes(')')) return false;
      if (/\.\w+\(/.test(name)) return false;
      return true;
    };

    let columns: string;
    if (outFields && outFields.length > 0) {
      columns = outFields
        .filter(isValidColumn)
        .map((f) => `[${f}]`)
        .join(', ');
    } else if (this._metadata?.fields && this._metadata.fields.length > 0) {
      columns = this._metadata.fields
        .filter((f) => isValidColumn(f.name))
        .map((f) => `[${f.name}]`)
        .join(', ');
    } else {
      // Fallback to * if no field info available
      columns = '*';
    }

    // Add geometry as WKB
    const geomColumns = driver === 'sqlserver'
      ? `[${shapeField}].STAsBinary() as [${shapeField}_WKB], [${shapeField}].STSrid as [${shapeField}_SRID]`
      : `ST_AsBinary("${shapeField}") as "${shapeField}_WKB", ST_SRID("${shapeField}") as "${shapeField}_SRID"`;

    // Handle case where columns is * (can't combine with explicit geometry columns easily)
    if (columns === '*') {
      // Select all non-geometry columns by excluding the shape field
      if (driver === 'sqlserver') {
        // For SQL Server, we need to list columns explicitly when adding geometry functions
        // For now, just select everything and add geometry columns
        return `*, [${shapeField}].STAsBinary() as [${shapeField}_WKB], [${shapeField}].STSrid as [${shapeField}_SRID]`;
      } else {
        return `*, ST_AsBinary("${shapeField}") as "${shapeField}_WKB", ST_SRID("${shapeField}") as "${shapeField}_SRID"`;
      }
    }

    return `${columns}, ${geomColumns}`;
  }

  /**
   * Stream all features from the table
   */
  async *stream(options?: QueryOptions): AsyncIterable<Feature> {
    const selectFields = this.buildSelectClause(options?.outFields);
    const shapeField = this.tableInfo.shapeFieldName;

    let sql = `SELECT ${selectFields} FROM [${this.tableInfo.schema}].[${this.tableInfo.name}]`;

    if (options?.where) {
      // WARNING: This is vulnerable to SQL injection!
      // In production, use parameterized queries with a proper query builder
      sql += ` WHERE ${options.where}`;
    }

    if (options?.orderBy) {
      sql += ` ORDER BY ${options.orderBy}`;
    }

    if (options?.limit) {
      sql += ` OFFSET ${options.offset ?? 0} ROWS FETCH NEXT ${options.limit} ROWS ONLY`;
    }

    for await (const row of this.connection.stream(sql)) {
      yield this.rowToFeature(row, shapeField);
    }
  }

  /**
   * Get a single feature by ID
   */
  async getFeature(id: number): Promise<Feature | null> {
    const selectFields = this.buildSelectClause();
    const shapeField = this.tableInfo.shapeFieldName;

    const sql = `SELECT ${selectFields} FROM [${this.tableInfo.schema}].[${this.tableInfo.name}] WHERE OBJECTID = @p0`;

    const rows = await this.connection.query(sql, [id]);

    if (rows.length === 0) return null;

    return this.rowToFeature(rows[0]!, shapeField);
  }

  /**
   * Get multiple features by IDs
   */
  async getFeatures(ids: number[]): Promise<Feature[]> {
    if (ids.length === 0) return [];

    const selectFields = this.buildSelectClause();
    const shapeField = this.tableInfo.shapeFieldName;

    // Build parameterized query
    const params = ids.map((_, i) => `@p${i}`).join(', ');
    const sql = `SELECT ${selectFields} FROM [${this.tableInfo.schema}].[${this.tableInfo.name}] WHERE OBJECTID IN (${params})`;

    const rows = await this.connection.query(sql, ids);

    return rows.map((row) => this.rowToFeature(row, shapeField));
  }

  /**
   * Count features (optionally with WHERE clause)
   */
  async count(where?: string): Promise<number> {
    let sql = `SELECT COUNT(*) as cnt FROM [${this.tableInfo.schema}].[${this.tableInfo.name}]`;

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

  /**
   * Close the table (no-op for enterprise, connection is shared)
   */
  async close(): Promise<void> {
    // Nothing to do - connection is managed by EnterpriseGeodatabase
  }
}
