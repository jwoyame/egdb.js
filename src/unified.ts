/**
 * Unified geodatabase access layer
 *
 * Provides a common interface for accessing both File Geodatabases (via gdb.js)
 * and Enterprise Geodatabases (via egdb.js).
 *
 * This allows applications to work with either data source transparently.
 */

import { EnterpriseGeodatabase } from './enterprise-geodatabase';
import { EnterpriseTable } from './enterprise-table';
import type {
  ConnectionConfig,
  TableInfo,
  TableMetadata,
  Feature,
  Geometry,
  FieldDefinition,
  GeometryType,
} from './types';

// Re-export types for convenience
export type {
  Feature,
  Geometry,
  FieldDefinition,
  TableInfo,
  TableMetadata,
  GeometryType,
};

/**
 * Unified geodatabase configuration
 */
export type UnifiedGeodatabaseConfig =
  | { type: 'file'; path: string }
  | { type: 'enterprise'; connection: ConnectionConfig };

/**
 * Unified table interface
 *
 * Both gdb.js TableHandle and egdb.js EnterpriseTable implement this interface.
 */
export interface ITable {
  readonly name: string;
  readonly metadata: TableMetadata;
  stream(): AsyncIterable<Feature>;
  getFeature(id: number): Promise<Feature | null>;
  close(): Promise<void>;
}

/**
 * Unified geodatabase interface
 *
 * Both gdb.js Geodatabase and egdb.js EnterpriseGeodatabase implement this interface.
 */
export interface IGeodatabase {
  readonly source: string;
  listTables(): Promise<TableInfo[]>;
  openTable(name: string): Promise<ITable>;
  close(): Promise<void>;
}

/**
 * Adapter to make EnterpriseGeodatabase implement IGeodatabase
 */
class EnterpriseGeodatabaseAdapter implements IGeodatabase {
  constructor(private egdb: EnterpriseGeodatabase) {}

  get source(): string {
    return this.egdb.source;
  }

  async listTables(): Promise<TableInfo[]> {
    return this.egdb.listTables();
  }

  async openTable(name: string): Promise<ITable> {
    const table = await this.egdb.openTable(name);
    return new EnterpriseTableAdapter(table);
  }

  async close(): Promise<void> {
    return this.egdb.close();
  }
}

/**
 * Adapter to make EnterpriseTable implement ITable
 */
class EnterpriseTableAdapter implements ITable {
  constructor(private table: EnterpriseTable) {}

  get name(): string {
    return this.table.name;
  }

  get metadata(): TableMetadata {
    return this.table.metadata;
  }

  stream(): AsyncIterable<Feature> {
    return this.table.stream();
  }

  getFeature(id: number): Promise<Feature | null> {
    return this.table.getFeature(id);
  }

  close(): Promise<void> {
    return this.table.close();
  }
}

/**
 * Open a geodatabase from a unified configuration
 *
 * @example
 * ```typescript
 * // Open a file geodatabase
 * const fileGdb = await openGeodatabase({
 *   type: 'file',
 *   path: './data/parcels.gdb'
 * });
 *
 * // Open an enterprise geodatabase
 * const enterpriseGdb = await openGeodatabase({
 *   type: 'enterprise',
 *   connection: {
 *     driver: 'sqlserver',
 *     server: 'localhost',
 *     database: 'parcel_fabric',
 *     user: 'sde',
 *     password: process.env.DB_PASSWORD!
 *   }
 * });
 *
 * // Same API for both
 * const tables = await gdb.listTables();
 * const parcels = await gdb.openTable('ParcelFabric_Parcels');
 * for await (const feature of parcels.stream()) {
 *   console.log(feature.id, feature.attributes);
 * }
 * ```
 */
export async function openGeodatabase(config: UnifiedGeodatabaseConfig): Promise<IGeodatabase> {
  if (config.type === 'file') {
    // Dynamic import to avoid requiring gdb.js as a dependency
    try {
      // @ts-expect-error - gdb.js is an optional peer dependency
      const gdbjs = await import('@etchgis/gdb.js');
      const gdb = await gdbjs.Geodatabase.open(config.path);

      // Wrap gdb.js Geodatabase to match IGeodatabase interface
      return {
        get source() {
          return config.path;
        },
        async listTables() {
          const tables = await gdb.listTables();
          // Map gdb.js TableInfo to our TableInfo format
          return tables.map((t: { name: string; tableNumber: number; isFeatureClass: boolean }) => ({
            name: t.name,
            physicalName: t.name,
            schema: '',
            isFeatureClass: t.isFeatureClass,
          }));
        },
        async openTable(name: string) {
          const table = await gdb.openTable(name);

          // Build metadata from gdb.js TableHandle properties
          const hasGeometry = !!table.geometryMetadata;
          const fields: FieldDefinition[] = table.fields.map((f: {
            name: string;
            type: number;
            typeName?: string;
            alias?: string;
            nullable: boolean;
            length?: number;
            precision?: { precision?: number; scale?: number };
            defaultValue?: unknown;
          }) => ({
            name: f.name,
            type: f.type,
            typeName: f.typeName || 'Unknown',
            alias: f.alias,
            nullable: f.nullable,
            length: f.length,
            precision: f.precision?.precision,
            scale: f.precision?.scale,
            defaultValue: f.defaultValue,
          }));

          const metadata: TableMetadata = {
            name,
            physicalName: name,
            schema: '',
            featureCount: table.recordCount,
            fields,
            isFeatureClass: hasGeometry,
            geometryType: table.geometryMetadata?.type as GeometryType | undefined,
            shapeFieldName: table.geometryMetadata?.fieldName,
          };

          return {
            get name() {
              return name;
            },
            get metadata() {
              return metadata;
            },
            stream() {
              return table.stream();
            },
            async getFeature(id: number) {
              return table.getFeature(id);
            },
            async close() {
              await table.close();
            },
          };
        },
        async close() {
          await gdb.close();
        },
      };
    } catch (error) {
      throw new Error(
        `Failed to load @etchgis/gdb.js for file geodatabase access. ` +
          `Install it with: yarn add @etchgis/gdb.js. ` +
          `Error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Enterprise geodatabase
  const egdb = await EnterpriseGeodatabase.connect(config.connection);
  return new EnterpriseGeodatabaseAdapter(egdb);
}

/**
 * Check if a geodatabase source is a file or enterprise
 */
export function isFileGeodatabase(source: string): boolean {
  return source.endsWith('.gdb') || source.includes('.gdb/');
}

/**
 * Parse a connection string into a configuration
 *
 * Supports formats:
 * - File: /path/to/data.gdb
 * - Enterprise: sqlserver://user:pass@host:port/database
 * - Enterprise: postgresql://user:pass@host:port/database
 */
export function parseConnectionString(connectionString: string): UnifiedGeodatabaseConfig {
  if (isFileGeodatabase(connectionString)) {
    return { type: 'file', path: connectionString };
  }

  const url = new URL(connectionString);
  const driver = url.protocol.replace(':', '') as 'sqlserver' | 'postgresql';

  if (driver !== 'sqlserver' && driver !== 'postgresql') {
    throw new Error(`Unsupported driver: ${driver}. Use sqlserver:// or postgresql://`);
  }

  return {
    type: 'enterprise',
    connection: {
      driver,
      server: url.hostname,
      port: url.port ? parseInt(url.port, 10) : undefined,
      database: url.pathname.slice(1), // Remove leading /
      user: url.username,
      password: url.password,
    },
  };
}
