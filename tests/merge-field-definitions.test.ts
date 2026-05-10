import { describe, test, expect } from 'vitest';
import { mergeFieldDefinitions } from '../src/enterprise-table';
import type { FieldDefinition, FieldType } from '../src/types';

// Builders to keep tests readable.
const xmlField = (name: string, alias?: string): FieldDefinition => ({
  name,
  type: 4 as FieldType, // STRING
  typeName: 'nvarchar',
  alias: alias ?? `XML alias for ${name}`,
  nullable: true,
  length: 255,
});

const liveField = (name: string): FieldDefinition => ({
  name,
  type: 4 as FieldType,
  typeName: 'nvarchar',
  nullable: true,
  length: 100,
});

describe('mergeFieldDefinitions', () => {
  test('XML wins where both sources have a field (XML alias preserved)', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID', 'Parcel ID')],
      [liveField('PARCELID')],
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('PARCELID');
    expect(out[0]?.alias).toBe('Parcel ID');
    expect(out[0]?.length).toBe(255);
  });

  test('INFORMATION_SCHEMA-only fields are appended (post-SDE-registration ALTER)', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID')],
      [liveField('PARCELID'), liveField('LOWPARCELID')],
      undefined,
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID', 'LOWPARCELID']);
    // The post-registration column gets the INFORMATION_SCHEMA shape
    // (no rich alias).
    expect(out[1]?.alias).toBeUndefined();
  });

  test('XML-only fields are kept (rare: SDE catalog tracks something INFORMATION_SCHEMA does not)', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID'), xmlField('GHOST')],
      [liveField('PARCELID')],
      undefined,
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID', 'GHOST']);
  });

  test('case-insensitive merge: same column with different casing is one entry, XML wins', () => {
    const out = mergeFieldDefinitions(
      [xmlField('Shape_Length', 'XML Shape_Length')],
      [liveField('shape_length')],
      undefined,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.name).toBe('Shape_Length');
    expect(out[0]?.alias).toBe('XML Shape_Length');
  });

  test('shape field is excluded from both sides', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID'), xmlField('Shape')],
      [liveField('Shape'), liveField('LOWPARCELID')],
      'Shape',
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID', 'LOWPARCELID']);
  });

  test('shape filter is case-insensitive', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID'), xmlField('SHAPE')],
      [liveField('shape')],
      'Shape',
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID']);
  });

  test('empty XML uses INFORMATION_SCHEMA wholesale (view path)', () => {
    const out = mergeFieldDefinitions(
      [],
      [liveField('PID'), liveField('PARCELID'), liveField('SITEADDRESS')],
      undefined,
    );
    expect(out.map(f => f.name)).toEqual(['PID', 'PARCELID', 'SITEADDRESS']);
  });

  test('empty INFORMATION_SCHEMA falls back to XML (no live ALTER detected)', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID'), xmlField('OWNERNME1')],
      [],
      undefined,
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID', 'OWNERNME1']);
  });

  test('order preserved: XML order first, then INFORMATION_SCHEMA-only in ordinal order', () => {
    const out = mergeFieldDefinitions(
      [xmlField('A'), xmlField('B'), xmlField('C')],
      [liveField('A'), liveField('B'), liveField('NEW1'), liveField('C'), liveField('NEW2')],
      undefined,
    );
    expect(out.map(f => f.name)).toEqual(['A', 'B', 'C', 'NEW1', 'NEW2']);
  });

  test('Putnam case: pa.TAXPARCEL with LOWPARCELID added post-registration', () => {
    // Reproduces the actual production diff finding. XML was frozen
    // before LOWPARCELID was ALTER-TABLE-added.
    const xml = ['OBJECTID', 'PARCELID', 'BUILDING', 'GlobalID']
      .map(n => xmlField(n));
    const live = ['OBJECTID', 'PARCELID', 'LOWPARCELID', 'BUILDING', 'GlobalID']
      .map(n => liveField(n));
    const out = mergeFieldDefinitions(xml, live, 'Shape');
    expect(out.map(f => f.name)).toContain('LOWPARCELID');
    expect(out.find(f => f.name === 'PARCELID')?.alias).toBe('XML alias for PARCELID');
  });

  test('SDE-internal columns are dropped: GDB_GEOMATTR_DATA, SDE_STATE_ID', () => {
    const out = mergeFieldDefinitions(
      [xmlField('PARCELID')],
      [liveField('PARCELID'), liveField('GDB_GEOMATTR_DATA'), liveField('SDE_STATE_ID')],
      'Shape',
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID']);
  });

  test('SDE-internal column filter is case-insensitive', () => {
    const out = mergeFieldDefinitions(
      [],
      [liveField('PARCELID'), liveField('gdb_geomattr_data'), liveField('Sde_State_Id')],
      undefined,
    );
    expect(out.map(f => f.name)).toEqual(['PARCELID']);
  });
});
