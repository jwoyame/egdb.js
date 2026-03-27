/**
 * Functions for detecting conflicts between versions
 */

import type { IDatabaseConnection } from '../connections/connection';
import type {
  TableInfo,
  FeatureChange,
  VersionChanges,
  Conflict,
  DetailedConflict,
  FieldConflict,
} from '../types';
import { readATableRow, readBaseTableRow, normalizeRow } from './read-row-data';

/** Fields to exclude from conflict comparison */
const EXCLUDE_FIELDS = ['OBJECTID', 'SDE_STATE_ID', 'GLOBALID', 'SHAPE', 'SHAPE_WKB', 'SHAPE_SRID'];

/**
 * Check if two values are equal, handling nulls, Buffers, and Dates.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  // Handle Buffer comparison
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) {
    return a.equals(b);
  }

  // Handle Date comparison
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // Handle number comparison with tolerance for floating point
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    // Use relative tolerance for floating point comparison
    const diff = Math.abs(a - b);
    const maxVal = Math.max(Math.abs(a), Math.abs(b));
    return diff < maxVal * 1e-10 || diff < 1e-10;
  }

  return false;
}

/**
 * Compare two rows field-by-field to find which fields differ.
 *
 * @param baseRow Original row data
 * @param modifiedRow Modified row data
 * @param excludeFields Fields to exclude from comparison
 * @returns Array of field names that differ
 */
export function compareRows(
  baseRow: Record<string, unknown>,
  modifiedRow: Record<string, unknown>,
  excludeFields: string[] = EXCLUDE_FIELDS
): string[] {
  const changedFields: string[] = [];
  const excludeSet = new Set(excludeFields.map(f => f.toUpperCase()));

  // Normalize rows to uppercase keys
  const normBase = normalizeRow(baseRow);
  const normModified = normalizeRow(modifiedRow);

  for (const key of Object.keys(normBase)) {
    if (excludeSet.has(key)) continue;

    const baseValue = normBase[key];
    const modifiedValue = normModified[key];

    if (!valuesEqual(baseValue, modifiedValue)) {
      changedFields.push(key);
    }
  }

  return changedFields;
}

/**
 * Detect basic conflicts (row-level) between child and parent changes.
 * A conflict occurs when the same OBJECTID in the same table
 * was modified in both versions since the common ancestor.
 *
 * @param childChanges Changes in child version
 * @param parentChanges Changes in parent version
 * @returns Array of conflicts
 */
export function detectConflicts(
  childChanges: VersionChanges,
  parentChanges: VersionChanges
): Conflict[] {
  const conflicts: Conflict[] = [];

  // Build lookup map for parent changes by table:objectId
  const parentChangeMap = new Map<string, FeatureChange>();

  for (const change of [...parentChanges.inserts, ...parentChanges.updates, ...parentChanges.deletes]) {
    const key = `${change.table}:${change.objectId}`;
    parentChangeMap.set(key, change);
  }

  // Check each child change against parent changes
  for (const childChange of [...childChanges.inserts, ...childChanges.updates, ...childChanges.deletes]) {
    const key = `${childChange.table}:${childChange.objectId}`;
    const parentChange = parentChangeMap.get(key);

    if (parentChange) {
      conflicts.push({
        table: childChange.table,
        registrationId: childChange.registrationId,
        objectId: childChange.objectId,
        childChangeType: childChange.changeType,
        parentChangeType: parentChange.changeType,
        childStateId: childChange.stateId,
        parentStateId: parentChange.stateId
      });
    }
  }

  return conflicts;
}

/**
 * Detect detailed conflicts with field-level analysis.
 * For update-update conflicts, determines which specific fields conflict
 * and whether the conflict can be auto-merged.
 *
 * @param connection Database connection
 * @param tables All tables in geodatabase
 * @param childChanges Changes in child version
 * @param parentChanges Changes in parent version
 * @returns Array of detailed conflicts
 */
export async function detectDetailedConflicts(
  connection: IDatabaseConnection,
  tables: TableInfo[],
  childChanges: VersionChanges,
  parentChanges: VersionChanges
): Promise<DetailedConflict[]> {
  const conflicts: DetailedConflict[] = [];

  // Build lookup for parent changes
  const parentChangeMap = new Map<string, FeatureChange>();
  for (const change of [...parentChanges.inserts, ...parentChanges.updates, ...parentChanges.deletes]) {
    parentChangeMap.set(`${change.table}:${change.objectId}`, change);
  }

  // Check each child change
  for (const childChange of [...childChanges.inserts, ...childChanges.updates, ...childChanges.deletes]) {
    const key = `${childChange.table}:${childChange.objectId}`;
    const parentChange = parentChangeMap.get(key);

    if (!parentChange) continue; // No conflict

    const tableInfo = tables.find(t => t.name === childChange.table);
    if (!tableInfo) continue;

    // For update-update conflicts, do field-level analysis
    if (childChange.changeType === 'update' && parentChange.changeType === 'update') {
      const detailedConflict = await analyzeUpdateConflict(
        connection,
        tableInfo,
        childChange,
        parentChange
      );
      conflicts.push(detailedConflict);
    } else {
      // Non-update conflicts (insert-insert, update-delete, delete-update, delete-delete)
      // These are always row-level conflicts and not auto-mergeable
      conflicts.push({
        table: childChange.table,
        registrationId: childChange.registrationId,
        objectId: childChange.objectId,
        childChangeType: childChange.changeType,
        parentChangeType: parentChange.changeType,
        childStateId: childChange.stateId,
        parentStateId: parentChange.stateId,
        fieldConflicts: [],
        childOnlyChanges: [],
        parentOnlyChanges: [],
        autoMergeable: false
      });
    }
  }

  return conflicts;
}

/**
 * Analyze an update-update conflict at the field level.
 */
async function analyzeUpdateConflict(
  connection: IDatabaseConnection,
  tableInfo: TableInfo,
  childChange: FeatureChange,
  parentChange: FeatureChange
): Promise<DetailedConflict> {
  // Read all three versions of the row
  const baseRow = await readBaseTableRow(connection, tableInfo, childChange.objectId);
  const childRow = await readATableRow(connection, tableInfo, childChange.objectId, childChange.stateId);
  const parentRow = await readATableRow(connection, tableInfo, parentChange.objectId, parentChange.stateId);

  // If we can't read all rows, fall back to row-level conflict
  if (!baseRow || !childRow || !parentRow) {
    return {
      table: childChange.table,
      registrationId: childChange.registrationId,
      objectId: childChange.objectId,
      childChangeType: 'update',
      parentChangeType: 'update',
      childStateId: childChange.stateId,
      parentStateId: parentChange.stateId,
      fieldConflicts: [],
      childOnlyChanges: [],
      parentOnlyChanges: [],
      autoMergeable: false
    };
  }

  // Normalize rows for comparison
  const normBase = normalizeRow(baseRow);
  const normChild = normalizeRow(childRow);
  const normParent = normalizeRow(parentRow);

  // Find which fields each version changed from base
  const childChangedFields = compareRows(normBase, normChild);
  const parentChangedFields = compareRows(normBase, normParent);

  // Analyze field-level conflicts
  const fieldConflicts: FieldConflict[] = [];
  const childOnlyChanges: string[] = [];
  const parentOnlyChanges: string[] = [];

  for (const field of childChangedFields) {
    if (parentChangedFields.includes(field)) {
      // Both changed this field - check if to different values
      if (!valuesEqual(normChild[field], normParent[field])) {
        fieldConflicts.push({
          field,
          childValue: normChild[field],
          parentValue: normParent[field],
          baseValue: normBase[field]
        });
      }
      // If same value, not a real conflict (both made same change)
    } else {
      childOnlyChanges.push(field);
    }
  }

  for (const field of parentChangedFields) {
    if (!childChangedFields.includes(field)) {
      parentOnlyChanges.push(field);
    }
  }

  // Auto-mergeable if no field-level conflicts
  const autoMergeable = fieldConflicts.length === 0;

  // Build suggested merge (child values + parent-only changes)
  let suggestedMerge: Record<string, unknown> | undefined;
  if (autoMergeable && parentOnlyChanges.length > 0) {
    suggestedMerge = { ...normChild };
    for (const field of parentOnlyChanges) {
      suggestedMerge[field] = normParent[field];
    }
    // Remove internal fields
    delete suggestedMerge['OBJECTID'];
    delete suggestedMerge['SDE_STATE_ID'];
  }

  return {
    table: childChange.table,
    registrationId: childChange.registrationId,
    objectId: childChange.objectId,
    childChangeType: 'update',
    parentChangeType: 'update',
    childStateId: childChange.stateId,
    parentStateId: parentChange.stateId,
    fieldConflicts,
    childOnlyChanges,
    parentOnlyChanges,
    autoMergeable,
    suggestedMerge
  };
}

/**
 * Get a summary of conflicts.
 */
export function getConflictsSummary(conflicts: DetailedConflict[]): {
  totalConflicts: number;
  autoMergeableCount: number;
  requiresResolutionCount: number;
  byType: Record<string, number>;
  tablesAffected: string[];
} {
  const tablesAffected = new Set<string>();
  const byType: Record<string, number> = {};
  let autoMergeableCount = 0;

  for (const c of conflicts) {
    tablesAffected.add(c.table);

    const typeKey = `${c.childChangeType}-${c.parentChangeType}`;
    byType[typeKey] = (byType[typeKey] ?? 0) + 1;

    if (c.autoMergeable) {
      autoMergeableCount++;
    }
  }

  return {
    totalConflicts: conflicts.length,
    autoMergeableCount,
    requiresResolutionCount: conflicts.length - autoMergeableCount,
    byType,
    tablesAffected: Array.from(tablesAffected)
  };
}
