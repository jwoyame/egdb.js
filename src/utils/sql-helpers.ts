/**
 * SQL helper utilities for safe query building
 *
 * These utilities prevent SQL injection by validating values before
 * interpolation into SQL strings.
 */

/**
 * Validate that all values are finite integers.
 * @throws Error if any value is invalid
 */
export function validateIntegerArray(values: number[], context: string): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(`Invalid integer at index ${i} in ${context}: ${v}`);
    }
  }
}

/**
 * Build a safe SQL IN clause from validated integer IDs.
 * @returns SQL fragment like "1,2,3" (without parentheses)
 * @throws Error if array is empty or contains invalid values
 */
export function buildIntegerList(values: number[], context: string): string {
  if (values.length === 0) {
    throw new Error(`Empty array provided to ${context}`);
  }
  validateIntegerArray(values, context);
  return values.join(',');
}

/**
 * Validate a single positive integer (for OBJECTID, state_id, etc.)
 *
 * Note: rejects 0. ArcGIS OBJECTIDs start at 1, so this is correct for
 * OBJECTID validation. Use validateNonNegativeInteger if 0 is valid.
 *
 * @throws Error if value is not a positive integer
 */
export function validatePositiveInteger(value: number, context: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${context}: ${value} (must be a positive integer)`);
  }
}

/**
 * Validate a single non-negative integer (for state_id which can be 0)
 * @throws Error if value is not a non-negative integer
 */
export function validateNonNegativeInteger(value: number, context: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${context}: ${value} (must be a non-negative integer)`);
  }
}
