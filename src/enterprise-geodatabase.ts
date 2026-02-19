/**
 * EnterpriseGeodatabase - Main class for accessing enterprise geodatabases
 *
 * Supports SQL Server and PostgreSQL backends.
 */

import type { IDatabaseConnection } from './connections/connection';
import { SqlServerConnection } from './connections/sqlserver';
import { PostgreSQLConnection } from './connections/postgresql';
import { EnterpriseTable } from './enterprise-table';
import { parseGdbItems } from './parsers/gdb-items-parser';
import type { GdbItemRow } from './parsers/gdb-items-parser';
import type { ConnectionConfig, TableInfo, VersionInfo } from './types';

export class EnterpriseGeodatabase {
  private connection: IDatabaseConnection;
  private config: ConnectionConfig;
  private _version: string | null = null;
  private _tables: TableInfo[] | null = null;

  private constructor(config: ConnectionConfig, connection: IDatabaseConnection) {
    this.config = config;
    this.connection = connection;
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
      const rows = await this.connection.query<{
        MAJOR: number;
        MINOR: number;
        BUGFIX: number;
      }>('SELECT MAJOR, MINOR, BUGFIX FROM sde.SDE_version');

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

    const sql = `
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
        i.DatasetInfo2
      FROM sde.GDB_ITEMS i
      JOIN sde.GDB_ITEMTYPES t ON i.Type = t.UUID
      WHERE t.Name IN ('Table', 'Feature Class')
      ORDER BY i.Name
    `;

    const rows = await this.connection.query<GdbItemRow & { TypeName: string }>(sql);

    // Convert TypeName to Type UUID for parser
    const itemRows: GdbItemRow[] = rows.map((row) => ({
      ...row,
      Type:
        row.TypeName === 'Feature Class'
          ? 'CA1C6E90-7896-4692-AA21-F8BB7063C4AD'
          : '77C1E6B3-9EB4-4A1D-B686-E1CADD1E3ADA',
    }));

    this._tables = parseGdbItems(itemRows);
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

    return EnterpriseTable.open(this.connection, tableInfo);
  }

  /**
   * List geodatabase versions
   */
  async listVersions(): Promise<VersionInfo[]> {
    const sql = `
      SELECT
        name,
        owner,
        description,
        parent_name,
        creation_time,
        modified_time
      FROM sde.SDE_versions
      ORDER BY name
    `;

    try {
      const rows = await this.connection.query<{
        name: string;
        owner: string;
        description?: string;
        parent_name?: string;
        creation_time?: Date;
        modified_time?: Date;
      }>(sql);

      return rows.map((row) => ({
        name: row.name,
        owner: row.owner,
        description: row.description,
        parentName: row.parent_name,
        createTime: row.creation_time,
        modifiedTime: row.modified_time,
      }));
    } catch {
      // Not all geodatabases have versioning enabled
      return [];
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
   * Close the geodatabase connection
   */
  async close(): Promise<void> {
    await this.connection.close();
  }
}
