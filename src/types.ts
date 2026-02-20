/**
 * Type definitions for egdb.js
 *
 * These types are structurally compatible with gdb.js types.
 * TypeScript's structural typing means they work interchangeably.
 *
 * Both libraries use the same enum values and interface shapes,
 * allowing seamless data exchange between file and enterprise geodatabases.
 */

/**
 * Field types (matches gdb.js GDBFieldType enum values)
 * @see GDBFieldType alias for gdb.js compatibility
 */
export enum FieldType {
  SMALLINTEGER = 0,
  INTEGER = 1,
  FLOAT = 2,
  DOUBLE = 3,
  STRING = 4,
  DATE = 5,
  OID = 6,
  GEOMETRY = 7,
  BLOB = 8,
  RASTER = 9,
  GUID = 10,
  GLOBALID = 11,
  XML = 12,
  INT64 = 13,
  DATEONLY = 14,
  TIMEONLY = 15,
  DATETIMEWITHOFFSET = 16,
}

/** Geometry types */
export type GeometryType =
  | 'Point'
  | 'MultiPoint'
  | 'LineString'
  | 'MultiLineString'
  | 'Polygon'
  | 'MultiPolygon';

/** Connection configuration */
export interface ConnectionConfig {
  driver: 'sqlserver' | 'postgresql';
  server: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  options?: {
    encrypt?: boolean;
    trustServerCertificate?: boolean;
    connectionTimeout?: number;
    requestTimeout?: number;
  };
}

/** SQL Server specific config */
export interface SqlServerConfig extends Omit<ConnectionConfig, 'driver'> {
  driver: 'sqlserver';
}

/** PostgreSQL specific config */
export interface PostgreSQLConfig extends Omit<ConnectionConfig, 'driver'> {
  driver: 'postgresql';
  ssl?: boolean | object;
}

/** Table information */
export interface TableInfo {
  name: string;
  physicalName: string;
  schema: string;
  isFeatureClass: boolean;
  geometryType?: GeometryType;
  shapeFieldName?: string;
}

/** Field definition */
export interface FieldDefinition {
  name: string;
  type: FieldType;
  typeName: string;
  alias?: string;
  nullable: boolean;
  length?: number;
  precision?: number;
  scale?: number;
  defaultValue?: unknown;
}

/** Spatial reference */
export interface SpatialReference {
  srid?: number;
  wkid?: number;
  wkt?: string;
  xOrigin?: number;
  yOrigin?: number;
  xyScale?: number;
  zOrigin?: number;
  zScale?: number;
  mOrigin?: number;
  mScale?: number;
  xyTolerance?: number;
  zTolerance?: number;
  mTolerance?: number;
}

/** Table metadata */
export interface TableMetadata {
  name: string;
  physicalName: string;
  schema: string;
  featureCount: number;
  fields: FieldDefinition[];
  isFeatureClass: boolean;
  geometryType?: GeometryType;
  shapeFieldName?: string;
  spatialReference?: SpatialReference;
}

/** Geometry object */
export interface Geometry {
  type: GeometryType;
  coordinates: unknown;
  bbox?: [number, number, number, number];
  srid?: number;
}

/** Feature record */
export interface Feature {
  id: number;
  attributes: Record<string, unknown>;
  geometry?: Geometry | null;
}

/** Version information */
export interface VersionInfo {
  name: string;
  owner: string;
  description?: string;
  parentName?: string;
  createTime?: Date;
  modifiedTime?: Date;
}

/**
 * Query options for filtering and paginating results
 *
 * @warning The `where` clause is NOT parameterized and is vulnerable to SQL injection
 * if user input is included directly. Only use with trusted/sanitized input or
 * for internal queries. Future versions will add parameterized query support.
 */
export interface QueryOptions {
  /**
   * SQL WHERE clause (without the WHERE keyword).
   * WARNING: Not parameterized - do not include untrusted user input directly.
   * @example "Status = 'Active' AND Area > 1000"
   */
  where?: string;
  /** Fields to include in output (default: all fields) */
  outFields?: string[];
  /**
   * ORDER BY clause. Required when using `limit` with SQL Server,
   * otherwise defaults to OBJECTID.
   */
  orderBy?: string;
  /** Maximum number of features to return */
  limit?: number;
  /** Number of features to skip (for pagination) */
  offset?: number;
}

/**
 * Alias for gdb.js compatibility
 * @see FieldType
 */
export { FieldType as GDBFieldType };
