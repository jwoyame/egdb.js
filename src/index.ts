/**
 * egdb.js - Enterprise Geodatabase library for Node.js
 *
 * Read and write ArcGIS Enterprise Geodatabases (SQL Server, PostgreSQL)
 */

// Main classes
export { EnterpriseGeodatabase, LockTimeoutError } from './enterprise-geodatabase';
export { EnterpriseTable } from './enterprise-table';
export { EditSession } from './edit-session';
export type { VersionedInsertOptions, VersionedUpdateOptions } from './edit-session';

// Types
export type {
  ConnectionConfig,
  SqlServerConfig,
  PostgreSQLConfig,
  TableInfo,
  TableMetadata,
  FieldDefinition,
  Feature,
  Geometry,
  GeometryType,
  SpatialReference,
  VersionInfo,
  QueryOptions,
  // Spatial query types
  SpatialQueryOptions,
  SpatialQueryGeometry,
  SpatialRelationship,
  // Reconcile/Post types
  FeatureChange,
  VersionChanges,
  Conflict,
  DetailedConflict,
  FieldConflict,
  ConflictResolution,
  ConflictResolver,
  ReconcileOptions,
  ReconcileResult,
  PostOptions,
  PostResult,
  CompressOptions,
  CompressResult,
} from './types';

// Enums
export { FieldType } from './types';

// Parsers (for advanced usage)
export { parseWkb, geometryToGeoJSON, setParserLogger } from './parsers/geometry-parser';
export { parseGdbItems, parseDefinitionXml, ITEM_TYPE_UUIDS } from './parsers/gdb-items-parser';
export type { GdbItemRow } from './parsers/gdb-items-parser';
export { geometryToWkt, geometryToSqlExpression, isValidGeometry } from './parsers/geometry-writer';

// Connection interface (for custom implementations)
export type { IDatabaseConnection } from './connections/connection';

// Logger (for routing library warnings/errors)
export type { Logger } from './logger';
export { consoleLogger } from './logger';

// Reconcile module (for advanced usage)
export {
  findCommonAncestor,
  getStatesInRange,
  getAllChanges,
  getChangesSummary,
  detectConflicts,
  detectDetailedConflicts,
  getConflictsSummary,
  compressStates,
  removeOrphanedStates,
  getVersionStats,
  cleanupStaleLocks,
  InsufficientPrivilegeError,
} from './reconcile';
export type { StaleLockCleanupResult } from './reconcile';

// Unified geodatabase access (works with both gdb.js and egdb.js)
export {
  openGeodatabase,
  isFileGeodatabase,
  parseConnectionString,
} from './unified';
export type {
  UnifiedGeodatabaseConfig,
  ITable,
  IGeodatabase,
} from './unified';
