/**
 * Read-only statistics helper for versioned tables.
 */

import type { IDatabaseConnection } from '../connections/connection';
import type { TableInfo } from '../types';
import { buildIntegerList } from '../utils/sql-helpers';

function quoteId(driver: 'sqlserver' | 'postgresql', name: string): string {
  return driver === 'sqlserver' ? `[${name}]` : `"${name}"`;
}

/**
 * Count A/D rows per table for a given set of state IDs. Pure read-only
 * statistics; never mutates.
 *
 * @param connection Database connection
 * @param tables All tables in geodatabase
 * @param stateIds State IDs to analyze
 * @returns Statistics per table (only entries with non-zero counts)
 */
export async function getVersionStats(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  stateIds: number[]
): Promise<Map<string, { adds: number; deletes: number }>> {
  const stats = new Map<string, { adds: number; deletes: number }>();

  if (stateIds.length === 0) {
    return stats;
  }

  const stateList = buildIntegerList(stateIds, 'getVersionStats');
  const driver = connection.driver;

  for (const table of tables) {
    if (!table.isVersioned || !table.registrationId) continue;

    const regId = table.registrationId;
    const schema = table.schema;

    const qSchema = quoteId(driver, schema);
    const aTable = `${qSchema}.${quoteId(driver, `a${regId}`)}`;
    const dTable = `${qSchema}.${quoteId(driver, `D${regId}`)}`;

    const addCountSql = driver === 'sqlserver'
      ? `SELECT COUNT(*) as cnt FROM ${aTable} WHERE SDE_STATE_ID IN (${stateList})`
      : `SELECT COUNT(*) as cnt FROM ${aTable} WHERE sde_state_id IN (${stateList})`;

    const deleteCountSql = driver === 'sqlserver'
      ? `SELECT COUNT(*) as cnt FROM ${dTable} WHERE SDE_STATE_ID IN (${stateList})`
      : `SELECT COUNT(*) as cnt FROM ${dTable} WHERE sde_state_id IN (${stateList})`;

    const [addResult, deleteResult] = await Promise.all([
      connection.query<{ cnt: number }>(addCountSql),
      connection.query<{ cnt: number }>(deleteCountSql),
    ]);

    const adds = addResult[0]?.cnt ?? 0;
    const deletes = deleteResult[0]?.cnt ?? 0;

    if (adds > 0 || deletes > 0) {
      stats.set(table.name, { adds, deletes });
    }
  }

  return stats;
}
