/**
 * Type definitions for egdb.js
 *
 * These types are structurally compatible with gdb.js types.
 * TypeScript's structural typing means they work interchangeably.
 */

/** Field types (matches gdb.js GDBFieldType enum values) */
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

/** Query options */
export interface QueryOptions {
  where?: string;
  outFields?: string[];
  orderBy?: string;
  limit?: number;
  offset?: number;
}
