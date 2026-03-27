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
  | 'MultiPolygon'
  | 'GeometryCollection';

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
  /** Registration ID for versioned tables (used to find A/D delta tables) */
  registrationId?: number;
  /** Whether the table is registered as versioned */
  isVersioned?: boolean;
  /** Enterprise versioned view name (e.g., "pa.TableName_evw") if one exists */
  evwViewName?: string;
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

/** Coordinate-based geometry types */
export type CoordinateGeometryType = Exclude<GeometryType, 'GeometryCollection'>;

/** Coordinate-based geometry object */
export interface CoordinateGeometry {
  type: CoordinateGeometryType;
  coordinates: unknown;
  bbox?: [number, number, number, number];
  srid?: number;
}

/** GeometryCollection object */
export interface GeometryCollectionType {
  type: 'GeometryCollection';
  geometries: Geometry[];
  bbox?: [number, number, number, number];
  srid?: number;
}

/** Geometry object (union of coordinate-based and collection types) */
export type Geometry = CoordinateGeometry | GeometryCollectionType;

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
  /** State ID for this version (used for versioned queries) */
  stateId?: number;
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
  /**
   * Version to query from (for versioned tables).
   * Format: "owner.name" (e.g., "sde.DEFAULT") or just "name" for sde-owned versions.
   * If not specified, reads from the base table (state 0).
   */
  version?: string;
}

// ============================================================
// SPATIAL QUERY TYPES
// ============================================================

/**
 * Geometry input for spatial queries.
 * Supports multiple formats for flexibility.
 */
export type SpatialQueryGeometry =
  | Geometry                                                  // GeoJSON geometry
  | { wkt: string; srid?: number }                           // WKT string
  | { wkb: Buffer; srid?: number }                           // WKB buffer
  | { envelope: [number, number, number, number]; srid?: number }; // [minX, minY, maxX, maxY]

/**
 * Spatial relationship types for filtering.
 * Maps to SQL Server ST* methods and PostGIS ST_* functions.
 */
export type SpatialRelationship =
  | 'intersects'   // Features that intersect the query geometry
  | 'contains'     // Features that contain the query geometry
  | 'within'       // Features that are within the query geometry
  | 'touches'      // Features that touch (share boundary) with query geometry
  | 'overlaps'     // Features that overlap the query geometry
  | 'crosses'      // Features that cross the query geometry
  | 'disjoint';    // Features that do not intersect the query geometry

/**
 * Extended query options with spatial support.
 * Extends base QueryOptions with spatial filtering capabilities.
 */
export interface SpatialQueryOptions extends QueryOptions {
  /**
   * Spatial filter geometry.
   * Features will be filtered based on their spatial relationship to this geometry.
   */
  geometry?: SpatialQueryGeometry;

  /**
   * Spatial relationship to test (default: 'intersects').
   * Determines how features relate to the query geometry.
   */
  spatialRelationship?: SpatialRelationship;

  /**
   * Distance for proximity queries (in coordinate system units).
   * When specified, finds features within this distance of the query geometry.
   * Overrides spatialRelationship.
   */
  distance?: number;

  /**
   * Return the distance from each feature to the query geometry.
   * When true, adds a `_distance` property to feature attributes.
   */
  returnDistance?: boolean;
}

// ============================================================
// RECONCILE/POST TYPES
// ============================================================

/** Represents a change to a single feature */
export interface FeatureChange {
  /** Table name */
  table: string;
  /** Registration ID of the table */
  registrationId: number;
  /** OBJECTID of the changed feature */
  objectId: number;
  /** State ID where the change occurred */
  stateId: number;
  /** Type of change */
  changeType: 'insert' | 'update' | 'delete';
}

/** Changes made in a version since a given state */
export interface VersionChanges {
  /** Features inserted (new OBJECTIDs) */
  inserts: FeatureChange[];
  /** Features updated (exist in base, modified in version) */
  updates: FeatureChange[];
  /** Features deleted */
  deletes: FeatureChange[];
}

/** Conflict at the field level */
export interface FieldConflict {
  /** Field name */
  field: string;
  /** Value in child version */
  childValue: unknown;
  /** Value in parent version */
  parentValue: unknown;
  /** Value at common ancestor (base) */
  baseValue: unknown;
}

/** A conflict between parent and child versions */
export interface Conflict {
  /** Table name */
  table: string;
  /** Registration ID of the table */
  registrationId: number;
  /** OBJECTID of the conflicting feature */
  objectId: number;
  /** Type of change in child version */
  childChangeType: 'insert' | 'update' | 'delete';
  /** Type of change in parent version */
  parentChangeType: 'insert' | 'update' | 'delete';
  /** State ID of child's change */
  childStateId: number;
  /** State ID of parent's change */
  parentStateId: number;
}

/** Detailed conflict with field-level information */
export interface DetailedConflict extends Conflict {
  /** Which fields actually conflict (same field changed to different values) */
  fieldConflicts: FieldConflict[];
  /** Fields changed only in child */
  childOnlyChanges: string[];
  /** Fields changed only in parent */
  parentOnlyChanges: string[];
  /** True if conflicts can be auto-merged (different fields changed) */
  autoMergeable: boolean;
  /** Suggested merged values (when autoMergeable) */
  suggestedMerge?: Record<string, unknown>;
}

/** Resolution choice for a conflict */
export type ConflictResolution = 'favor_edit' | 'favor_target' | 'merge';

/** Callback for custom conflict resolution */
export type ConflictResolver = (
  conflict: DetailedConflict
) => Promise<ConflictResolution> | ConflictResolution;

/** Callback to get merged values when resolution is 'merge' */
export type MergeValueProvider = (
  conflict: DetailedConflict
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Reconcile options */
export interface ReconcileOptions {
  /** Default resolution for conflicts (default: 'favor_edit') */
  conflictResolution?: 'favor_edit' | 'favor_target';
  /** Abort if any conflicts detected (default: false) */
  abortOnConflict?: boolean;
  /** Only detect conflicts, don't apply changes (default: false) */
  detectOnly?: boolean;
  /** Auto-merge when possible - different fields changed (default: true) */
  autoMerge?: boolean;
  /** Custom conflict resolver - called for each non-auto-mergeable conflict */
  resolveConflict?: ConflictResolver;
  /** Provide merged values when resolution is 'merge' */
  getMergedValues?: MergeValueProvider;
}

/** Reconcile result */
export interface ReconcileResult {
  /** Whether any conflicts were found */
  hasConflicts: boolean;
  /** Number of conflicts */
  conflictCount: number;
  /** Detailed conflict information */
  conflicts: DetailedConflict[];
  /** Whether changes were applied */
  applied: boolean;
  /** Common ancestor state ID */
  commonAncestorStateId: number;
  /** Number of parent changes applied */
  parentChangesApplied: number;
  /** Number of conflicts auto-merged */
  mergedCount: number;
}

/** Post options */
export interface PostOptions {
  /** Delete the child version after posting (default: false) */
  deleteVersionAfterPost?: boolean;
}

/** Post result */
export interface PostResult {
  /** Number of changes posted */
  changesPosted: number;
  /** New state ID of parent version */
  newParentStateId: number;
}

/** Compression options */
export interface CompressOptions {
  /** Only compress specific tables (default: all versioned tables) */
  tables?: string[];
  /** Remove states that are no longer referenced (default: true) */
  removeOrphanedStates?: boolean;
}

/** Compression result */
export interface CompressResult {
  /** Number of redundant A table rows removed */
  addsRemoved: number;
  /** Number of redundant D table rows removed */
  deletesRemoved: number;
  /** Number of orphaned states removed */
  statesRemoved: number;
}

/**
 * Alias for gdb.js compatibility
 * @see FieldType
 */
export { FieldType as GDBFieldType };
