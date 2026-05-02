/**
 * Type guard utilities for runtime validation
 *
 * These guards replace non-null assertions (!) with explicit runtime checks
 * that provide better error messages.
 */

import type { TableInfo } from '../types';

/**
 * Require a table to have a registration ID (versioning enabled).
 * @throws Error if not registered
 */
export function requireRegistrationId(tableInfo: TableInfo): number {
  if (tableInfo.registrationId === undefined) {
    throw new Error(
      `Table ${tableInfo.name} is not registered for versioning ` +
        `(no registration_id in SDE_table_registry)`
    );
  }
  return tableInfo.registrationId;
}

/**
 * Require a value to be defined.
 * Generic replacement for non-null assertions.
 */
export function requireDefined<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

/**
 * Require a table to be versioned.
 * @throws Error if table is not versioned
 */
export function requireVersioned(tableInfo: TableInfo): void {
  if (!tableInfo.isVersioned) {
    throw new Error(`Table ${tableInfo.name} is not registered for versioned editing`);
  }
}

/**
 * Require a state ID to be valid (non-negative integer).
 * State ID 0 is valid (represents the base/default state).
 */
export function requireValidStateId(stateId: number | undefined | null, context: string): number {
  if (stateId === undefined || stateId === null) {
    throw new Error(`${context}: state ID is required`);
  }
  if (typeof stateId !== 'number' || !Number.isFinite(stateId) || !Number.isInteger(stateId) || stateId < 0) {
    throw new Error(`${context}: invalid state ID ${stateId}`);
  }
  return stateId;
}
