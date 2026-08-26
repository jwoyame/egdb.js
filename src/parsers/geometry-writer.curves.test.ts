/**
 * Curve geometry: validation and WKT.
 *
 * A parcel fabric stores true arcs, and SQL Server handles them natively. egdb
 * previously could not: `isValidGeometry` looked for `.coordinates`, which
 * CompoundCurve and CurvePolygon do not have, so every curve SHAPE was judged
 * invalid and silently dropped by the write path.
 *
 * The WKT shapes asserted here were checked against SQL Server 2019 -- in
 * particular that a straight run inside COMPOUNDCURVE is a bare parenthesised
 * point list, since "LINESTRING (...)" there is rejected.
 */
import { describe, it, expect } from 'vitest';
import { isValidGeometry, geometryToWkt } from './geometry-writer';

const arc = { type: 'CircularString' as const, coordinates: [[0, 0], [5, 5], [10, 0]] as [number, number][] };
const back = { type: 'LineString' as const, coordinates: [[10, 0], [0, 0]] as [number, number][] };
const compound: any = { type: 'CompoundCurve', segments: [arc, back], srid: 2236 };
const curvePolygon: any = { type: 'CurvePolygon', rings: [compound], srid: 2236 };

describe('curve geometry is writable', () => {
  it('accepts a CircularString, CompoundCurve and CurvePolygon', () => {
    expect(isValidGeometry(arc as any)).toBe(true);
    expect(isValidGeometry(compound)).toBe(true);
    expect(isValidGeometry(curvePolygon)).toBe(true);
  });

  it('emits the WKT SQL Server accepts', () => {
    expect(geometryToWkt(arc as any)).toBe('CIRCULARSTRING (0 0, 5 5, 10 0)');
    // Straight run is bare parentheses -- "LINESTRING (...)" here is rejected
    // by STGeomFromText.
    expect(geometryToWkt(compound)).toBe('COMPOUNDCURVE (CIRCULARSTRING (0 0, 5 5, 10 0), (10 0, 0 0))');
    expect(geometryToWkt(curvePolygon)).toBe(
      'CURVEPOLYGON (COMPOUNDCURVE (CIRCULARSTRING (0 0, 5 5, 10 0), (10 0, 0 0)))',
    );
  });
});

describe('curve geometry that SQL Server would reject or store meaninglessly', () => {
  it('rejects an even-length CircularString', () => {
    expect(isValidGeometry({ type: 'CircularString', coordinates: [[0, 0], [5, 5], [10, 0], [1, 1]] } as any)).toBe(false);
  });

  it('rejects a degenerate arc (duplicate points)', () => {
    expect(isValidGeometry({ type: 'CircularString', coordinates: [[0, 0], [0, 0], [10, 0]] } as any)).toBe(false);
  });

  it('rejects a CompoundCurve whose segments do not join', () => {
    expect(isValidGeometry({ type: 'CompoundCurve', segments: [arc, { type: 'LineString', coordinates: [[99, 99], [0, 0]] }] } as any)).toBe(false);
  });

  it('rejects an unclosed CurvePolygon ring', () => {
    expect(isValidGeometry({ type: 'CurvePolygon', rings: [{ type: 'LineString', coordinates: [[0, 0], [1, 0], [1, 1], [9, 9]] }] } as any)).toBe(false);
  });

  it('rejects a CurvePolygon with no rings', () => {
    expect(isValidGeometry({ type: 'CurvePolygon', rings: [] } as any)).toBe(false);
  });
});
