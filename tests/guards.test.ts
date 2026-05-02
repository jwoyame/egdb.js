/**
 * Unit tests for type guard utilities
 */

import { describe, it, expect } from 'vitest';
import {
  requireRegistrationId,
  requireDefined,
  requireVersioned,
  requireValidStateId,
} from '../src/utils/guards';
import type { TableInfo } from '../src/types';

describe('requireRegistrationId', () => {
  it('should return registrationId when defined', () => {
    const tableInfo: TableInfo = {
      name: 'TestTable',
      physicalName: 'dbo.TestTable',
      schema: 'dbo',
      isFeatureClass: true,
      isVersioned: true,
      registrationId: 42,
    };
    expect(requireRegistrationId(tableInfo)).toBe(42);
  });

  it('should throw when registrationId is undefined', () => {
    const tableInfo: TableInfo = {
      name: 'TestTable',
      physicalName: 'dbo.TestTable',
      schema: 'dbo',
      isFeatureClass: true,
      isVersioned: false,
    };
    expect(() => requireRegistrationId(tableInfo)).toThrow(/not registered for versioning/);
    expect(() => requireRegistrationId(tableInfo)).toThrow(/TestTable/);
  });
});

describe('requireDefined', () => {
  it('should return value when defined', () => {
    expect(requireDefined('hello', 'test')).toBe('hello');
    expect(requireDefined(0, 'test')).toBe(0);
    expect(requireDefined(false, 'test')).toBe(false);
    expect(requireDefined('', 'test')).toBe('');
  });

  it('should throw when value is undefined', () => {
    expect(() => requireDefined(undefined, 'Version not found')).toThrow('Version not found');
  });

  it('should throw when value is null', () => {
    expect(() => requireDefined(null, 'State ID required')).toThrow('State ID required');
  });
});

describe('requireVersioned', () => {
  it('should not throw when table is versioned', () => {
    const tableInfo: TableInfo = {
      name: 'VersionedTable',
      physicalName: 'dbo.VersionedTable',
      schema: 'dbo',
      isFeatureClass: true,
      isVersioned: true,
      registrationId: 1,
    };
    expect(() => requireVersioned(tableInfo)).not.toThrow();
  });

  it('should throw when table is not versioned', () => {
    const tableInfo: TableInfo = {
      name: 'NonVersionedTable',
      physicalName: 'dbo.NonVersionedTable',
      schema: 'dbo',
      isFeatureClass: false,
      isVersioned: false,
    };
    expect(() => requireVersioned(tableInfo)).toThrow(/not registered for versioned editing/);
    expect(() => requireVersioned(tableInfo)).toThrow(/NonVersionedTable/);
  });
});

describe('requireValidStateId', () => {
  it('should return state ID when valid', () => {
    expect(requireValidStateId(0, 'test')).toBe(0);
    expect(requireValidStateId(1, 'test')).toBe(1);
    expect(requireValidStateId(12345, 'test')).toBe(12345);
  });

  it('should throw when state ID is undefined', () => {
    expect(() => requireValidStateId(undefined, 'Version')).toThrow(/state ID is required/);
  });

  it('should throw when state ID is null', () => {
    expect(() => requireValidStateId(null, 'Version')).toThrow(/state ID is required/);
  });

  it('should throw when state ID is negative', () => {
    expect(() => requireValidStateId(-1, 'test')).toThrow(/invalid state ID/);
  });

  it('should throw when state ID is not an integer', () => {
    expect(() => requireValidStateId(1.5, 'test')).toThrow(/invalid state ID/);
  });

  it('should throw when state ID is NaN', () => {
    expect(() => requireValidStateId(NaN, 'test')).toThrow(/invalid state ID/);
  });

  it('should throw when state ID is Infinity', () => {
    expect(() => requireValidStateId(Infinity, 'test')).toThrow(/invalid state ID/);
  });

  it('should include context in error message', () => {
    expect(() => requireValidStateId(-1, 'Parent version')).toThrow(/Parent version/);
  });
});
