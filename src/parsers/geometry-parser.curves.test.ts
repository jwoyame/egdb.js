/**
 * Curve WKB reads (ISO types 8 / 9 / 10).
 *
 * SQL Server's STAsBinary() returns curves natively -- a CurvePolygon comes
 * back as `010A000000...`, not a linearised Polygon. parseWkb used to fall to
 * its `default:` and return null for all three, so a stored curve read back as
 * NO geometry, and a later attribute-only update would then write that null
 * over the real shape.
 *
 * The WKB here is hand-built to the same layout SQL Server emits, so the test
 * does not depend on having a database.
 */
import { describe, it, expect } from 'vitest';
import { parseWkb } from './geometry-parser';

/** little-endian WKB builder */
function wkb(...parts: Array<Buffer | number[]>): Buffer {
  return Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pt = (x: number, y: number) => { const b = Buffer.alloc(16); b.writeDoubleLE(x, 0); b.writeDoubleLE(y, 8); return b; };
const header = (type: number) => wkb([0x01], u32(type));

const circular = (pts: [number, number][]) =>
  wkb(header(8), u32(pts.length), ...pts.map(([x, y]) => pt(x, y)));
const line = (pts: [number, number][]) =>
  wkb(header(2), u32(pts.length), ...pts.map(([x, y]) => pt(x, y)));

describe('parseWkb reads curve geometry', () => {
  it('CircularString (type 8)', () => {
    const g: any = parseWkb(circular([[0, 0], [5, 5], [10, 0]]), 2236);
    expect(g).not.toBeNull();
    expect(g.type).toBe('CircularString');
    expect(g.coordinates).toEqual([[0, 0], [5, 5], [10, 0]]);
    expect(g.srid).toBe(2236);
  });

  it('CompoundCurve (type 9) with a nested arc and straight run', () => {
    const body = wkb(circular([[0, 0], [5, 5], [10, 0]]), line([[10, 0], [0, 0]]));
    const g: any = parseWkb(wkb(header(9), u32(2), body), 2236);
    expect(g.type).toBe('CompoundCurve');
    expect(g.segments).toHaveLength(2);
    expect(g.segments[0].type).toBe('CircularString');
    expect(g.segments[1].type).toBe('LineString');
    expect(g.segments[1].coordinates).toEqual([[10, 0], [0, 0]]);
  });

  it('CurvePolygon (type 10) whose ring is a CompoundCurve', () => {
    const ring = wkb(header(9), u32(2), circular([[0, 0], [5, 5], [10, 0]]), line([[10, 0], [0, 0]]));
    const g: any = parseWkb(wkb(header(10), u32(1), ring), 2236);
    expect(g.type).toBe('CurvePolygon');
    expect(g.rings).toHaveLength(1);
    expect(g.rings[0].type).toBe('CompoundCurve');
    expect(g.rings[0].segments[0].coordinates).toEqual([[0, 0], [5, 5], [10, 0]]);
  });

  it('CurvePolygon with a hole -- second ring is read, not dropped', () => {
    const outer = wkb(header(9), u32(2), circular([[0, 0], [50, 50], [100, 0]]), line([[100, 0], [0, 0]]));
    const hole = line([[10, 5], [20, 5], [20, 15], [10, 5]]);
    const g: any = parseWkb(wkb(header(10), u32(2), outer, hole), 2236);
    expect(g.rings).toHaveLength(2);
    expect(g.rings[1].type).toBe('LineString');
    expect(g.rings[1].coordinates).toHaveLength(4);
  });

  it('does not return null the way it used to', () => {
    // The regression this exists to prevent.
    for (const b of [circular([[0, 0], [5, 5], [10, 0]]), wkb(header(10), u32(1), line([[0, 0], [1, 0], [1, 1], [0, 0]]))]) {
      expect(parseWkb(b, 2236)).not.toBeNull();
    }
  });
});
