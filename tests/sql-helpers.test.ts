/**
 * Unit tests for SQL helper utilities
 */

import { describe, it, expect } from 'vitest';
import {
  validateIntegerArray,
  buildIntegerList,
  validatePositiveInteger,
  validateNonNegativeInteger,
} from '../src/utils/sql-helpers';

describe('validateIntegerArray', () => {
  it('should accept valid integer arrays', () => {
    expect(() => validateIntegerArray([1, 2, 3], 'test')).not.toThrow();
    expect(() => validateIntegerArray([0], 'test')).not.toThrow();
    expect(() => validateIntegerArray([-5, 100], 'test')).not.toThrow();
    expect(() => validateIntegerArray([Number.MAX_SAFE_INTEGER], 'test')).not.toThrow();
  });

  it('should accept empty arrays', () => {
    expect(() => validateIntegerArray([], 'test')).not.toThrow();
  });

  it('should reject arrays with NaN', () => {
    expect(() => validateIntegerArray([1, NaN], 'test')).toThrow(/Invalid integer/);
  });

  it('should reject arrays with Infinity', () => {
    expect(() => validateIntegerArray([Infinity], 'test')).toThrow(/Invalid integer/);
    expect(() => validateIntegerArray([-Infinity], 'test')).toThrow(/Invalid integer/);
  });

  it('should reject arrays with non-integers', () => {
    expect(() => validateIntegerArray([1.5], 'test')).toThrow(/Invalid integer/);
    expect(() => validateIntegerArray([1, 2.5, 3], 'test')).toThrow(/Invalid integer/);
  });

  it('should include index in error message', () => {
    expect(() => validateIntegerArray([1, 2, NaN, 4], 'test')).toThrow(/index 2/);
  });

  it('should include context in error message', () => {
    expect(() => validateIntegerArray([NaN], 'stateIds')).toThrow(/stateIds/);
  });
});

describe('buildIntegerList', () => {
  it('should build comma-separated list', () => {
    expect(buildIntegerList([1, 2, 3], 'test')).toBe('1,2,3');
  });

  it('should handle single value', () => {
    expect(buildIntegerList([42], 'test')).toBe('42');
  });

  it('should handle negative values', () => {
    expect(buildIntegerList([-1, 0, 1], 'test')).toBe('-1,0,1');
  });

  it('should throw on empty array', () => {
    expect(() => buildIntegerList([], 'test')).toThrow(/Empty array/);
  });

  it('should throw on invalid values', () => {
    expect(() => buildIntegerList([1, NaN], 'test')).toThrow(/Invalid integer/);
  });

  it('should include context in error message', () => {
    expect(() => buildIntegerList([], 'compressStates')).toThrow(/compressStates/);
  });
});

describe('validatePositiveInteger', () => {
  it('should accept positive integers', () => {
    expect(() => validatePositiveInteger(1, 'id')).not.toThrow();
    expect(() => validatePositiveInteger(100, 'id')).not.toThrow();
    expect(() => validatePositiveInteger(Number.MAX_SAFE_INTEGER, 'id')).not.toThrow();
  });

  it('should reject zero', () => {
    expect(() => validatePositiveInteger(0, 'OBJECTID')).toThrow(/must be a positive integer/);
  });

  it('should reject negative integers', () => {
    expect(() => validatePositiveInteger(-1, 'id')).toThrow(/must be a positive integer/);
  });

  it('should reject non-integers', () => {
    expect(() => validatePositiveInteger(1.5, 'id')).toThrow(/must be a positive integer/);
  });

  it('should reject NaN', () => {
    expect(() => validatePositiveInteger(NaN, 'id')).toThrow(/must be a positive integer/);
  });

  it('should reject Infinity', () => {
    expect(() => validatePositiveInteger(Infinity, 'id')).toThrow(/must be a positive integer/);
  });

  it('should include context in error message', () => {
    expect(() => validatePositiveInteger(0, 'OBJECTID')).toThrow(/OBJECTID/);
  });
});

describe('validateNonNegativeInteger', () => {
  it('should accept zero', () => {
    expect(() => validateNonNegativeInteger(0, 'stateId')).not.toThrow();
  });

  it('should accept positive integers', () => {
    expect(() => validateNonNegativeInteger(1, 'stateId')).not.toThrow();
    expect(() => validateNonNegativeInteger(100, 'stateId')).not.toThrow();
  });

  it('should reject negative integers', () => {
    expect(() => validateNonNegativeInteger(-1, 'stateId')).toThrow(/must be a non-negative integer/);
  });

  it('should reject non-integers', () => {
    expect(() => validateNonNegativeInteger(1.5, 'stateId')).toThrow(/must be a non-negative integer/);
  });

  it('should include context in error message', () => {
    expect(() => validateNonNegativeInteger(-1, 'state_id')).toThrow(/state_id/);
  });
});
