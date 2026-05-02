/**
 * Functions for reading actual row data from tables
 * Used for field-level conflict detection
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';
import { requireRegistrationId } from '../utils/guards';

/**
 * Quote an identifier based on database driver.
 */
function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Read actual row data from A table for a specific OBJECTID and state.
 *
 * @param connection Database connection
 * @param tableInfo Table info
 * @param objectId OBJECTID to read
 * @param stateId State ID to read from
 * @returns Row data or null if not found
 */
export async function readATableRow(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  stateId: number
): Promise<Record<string, unknown> | null> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;

  const sql = driver === 'sqlserver'
    ? `SELECT * FROM ${aTable} WHERE [OBJECTID] = @p0 AND [SDE_STATE_ID] = @p1`
    : `SELECT * FROM ${aTable} WHERE "objectid" = $1 AND "sde_state_id" = $2`;

  const rows = await connection.query<Record<string, unknown>>(sql, [objectId, stateId]);
  return rows[0] ?? null;
}

/**
 * Read row from base table (state 0 / non-versioned data).
 *
 * @param connection Database connection
 * @param tableInfo Table info
 * @param objectId OBJECTID to read
 * @returns Row data or null if not found
 */
export async function readBaseTableRow(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number
): Promise<Record<string, unknown> | null> {
  const schema = tableInfo.schema;
  const driver = connection.driver;

  const qSchema = quoteId(driver, schema);
  const tableName = `${qSchema}.${quoteId(driver, tableInfo.name)}`;

  const sql = driver === 'sqlserver'
    ? `SELECT * FROM ${tableName} WHERE [OBJECTID] = @p0`
    : `SELECT * FROM ${tableName} WHERE "objectid" = $1`;

  const rows = await connection.query<Record<string, unknown>>(sql, [objectId]);
  return rows[0] ?? null;
}

/**
 * Get the original row data for a feature at a specific ancestor state.
 * This checks the base table first, then looks for the most recent A table entry
 * at or before the ancestor state.
 *
 * @param connection Database connection
 * @param tableInfo Table info
 * @param objectId OBJECTID to read
 * @param ancestorStateId Ancestor state ID
 * @param stateIds All state IDs up to and including ancestor
 * @returns Row data or null if not found
 */
export async function readRowAtState(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  objectId: number,
  ancestorStateId: number,
  stateIds: number[]
): Promise<Record<string, unknown> | null> {
  const regId = requireRegistrationId(tableInfo);
  const schema = tableInfo.schema;
  const driver = connection.driver;

  // First check if there's an A table entry at or before ancestor
  const statesUpToAncestor = stateIds.filter(s => s <= ancestorStateId);

  if (statesUpToAncestor.length > 0) {
    const stateList = statesUpToAncestor.join(',');
    const qSchema = quoteId(driver, schema);
    const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;

    const sql = driver === 'sqlserver'
      ? `SELECT TOP 1 * FROM ${aTable} WHERE [OBJECTID] = @p0 AND [SDE_STATE_ID] IN (${stateList}) ORDER BY [SDE_STATE_ID] DESC`
      : `SELECT * FROM ${aTable} WHERE "objectid" = $1 AND "sde_state_id" IN (${stateList}) ORDER BY "sde_state_id" DESC LIMIT 1`;

    const rows = await connection.query<Record<string, unknown>>(sql, [objectId]);
    if (rows[0]) {
      return rows[0];
    }
  }

  // Fall back to base table
  return readBaseTableRow(connection, tableInfo, objectId);
}

/**
 * Normalize row data to handle case differences between SQL Server and PostgreSQL.
 * Converts all keys to uppercase for consistent comparison.
 *
 * @param row Row data
 * @returns Row with uppercase keys
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    normalized[key.toUpperCase()] = value;
  }
  return normalized;
}
