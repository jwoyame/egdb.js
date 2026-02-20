/**
 * egdb.js - Enterprise Geodatabase library for Node.js
 *
 * Read and write ArcGIS Enterprise Geodatabases (SQL Server, PostgreSQL)
 */

// Main classes
export { EnterpriseGeodatabase } from './enterprise-geodatabase';
export { EnterpriseTable } from './enterprise-table';

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
} from './types';

// Enums
export { FieldType } from './types';

// Parsers (for advanced usage)
export { parseWkb, geometryToGeoJSON } from './parsers/geometry-parser';
export { parseGdbItems, parseDefinitionXml, ITEM_TYPE_UUIDS } from './parsers/gdb-items-parser';
export type { GdbItemRow } from './parsers/gdb-items-parser';

// Connection interface (for custom implementations)
export type { IDatabaseConnection } from './connections/connection';

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
