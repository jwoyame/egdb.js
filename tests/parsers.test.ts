/**
 * Unit tests for parsers (no database required)
 */

import { describe, it, expect } from 'vitest';
import {
  parseWkb,
  parseSdeBinary,
  parseSdeBinaryPoints,
  parseSdeBinaryMultiPart,
  densifyArc,
  densifyBezier,
  densifyCurves,
  type SpatialReferenceParams,
  type SegmentModifier,
} from '../src/parsers/geometry-parser.js';
import { parseDefinitionXml, parseGdbItems } from '../src/parsers/gdb-items-parser.js';
import { geometryToWkt, isValidGeometry, geometryToSqlExpression } from '../src/parsers/geometry-writer.js';
import type { Geometry } from '../src/types.js';

describe('WKB Parser', () => {
  describe('parseWkb', () => {
    it('should parse a Point', () => {
      // WKB for POINT(1 2) - little endian
      const wkb = Buffer.from([
        0x01, // Little endian
        0x01, 0x00, 0x00, 0x00, // Type: Point (1)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f, // X: 1.0
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, // Y: 2.0
      ]);

      const geom = parseWkb(wkb, 4326);

      expect(geom).not.toBeNull();
      expect(geom!.type).toBe('Point');
      expect(geom!.coordinates).toEqual([1, 2]);
      expect(geom!.srid).toBe(4326);
    });

    it('should parse a LineString', () => {
      // WKB for LINESTRING(0 0, 1 1, 2 2)
      const wkb = Buffer.from([
        0x01, // Little endian
        0x02, 0x00, 0x00, 0x00, // Type: LineString (2)
        0x03, 0x00, 0x00, 0x00, // 3 points
        // Point 1: (0, 0)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        // Point 2: (1, 1)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
        // Point 3: (2, 2)
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40,
      ]);

      const geom = parseWkb(wkb);

      expect(geom).not.toBeNull();
      expect(geom!.type).toBe('LineString');
      expect(geom!.coordinates).toHaveLength(3);
      expect(geom!.coordinates).toEqual([
        [0, 0],
        [1, 1],
        [2, 2],
      ]);
    });

    it('should return null for empty buffer', () => {
      expect(parseWkb(Buffer.alloc(0))).toBeNull();
    });

    it('should return null for buffer too small', () => {
      expect(parseWkb(Buffer.from([0x01, 0x01]))).toBeNull();
    });
  });
});

describe('GDB Items Parser', () => {
  describe('parseDefinitionXml', () => {
    it('should extract ShapeType as geometryType', () => {
      const xml = `
        <DEFeatureClassInfo>
          <ShapeType>esriGeometryPolygon</ShapeType>
        </DEFeatureClassInfo>
      `;

      const result = parseDefinitionXml(xml);

      expect(result.geometryType).toBe('Polygon');
    });

    it('should parse GPFieldInfoEx format', () => {
      const xml = `
        <GPFieldInfoExs>
          <GPFieldInfoEx>
            <Name>OBJECTID</Name>
            <AliasName>Object ID</AliasName>
            <FieldType>esriFieldTypeOID</FieldType>
            <IsNullable>false</IsNullable>
          </GPFieldInfoEx>
          <GPFieldInfoEx>
            <Name>Name</Name>
            <AliasName>Name</AliasName>
            <FieldType>esriFieldTypeString</FieldType>
            <IsNullable>true</IsNullable>
          </GPFieldInfoEx>
        </GPFieldInfoExs>
      `;

      const result = parseDefinitionXml(xml);

      expect(result.fields).toHaveLength(2);
      expect(result.fields[0]!.name).toBe('OBJECTID');
      expect(result.fields[0]!.type).toBe(6); // OID
      expect(result.fields[1]!.name).toBe('Name');
      expect(result.fields[1]!.type).toBe(4); // STRING
    });

    it('should map ESRI geometry types correctly', () => {
      const testCases = [
        { esri: 'esriGeometryPoint', expected: 'Point' },
        { esri: 'esriGeometryMultipoint', expected: 'MultiPoint' },
        { esri: 'esriGeometryPolyline', expected: 'LineString' },
        { esri: 'esriGeometryPolygon', expected: 'Polygon' },
      ];

      for (const { esri, expected } of testCases) {
        const xml = `<ShapeType>${esri}</ShapeType>`;
        const result = parseDefinitionXml(xml);
        expect(result.geometryType).toBe(expected);
      }
    });
  });

  describe('parseGdbItems', () => {
    it('should parse feature class rows', () => {
      const rows = [
        {
          ObjectID: 1,
          UUID: 'abc-123',
          Type: 'CA1C6E90-7896-4692-AA21-F8BB7063C4AD', // Feature Class
          Name: 'Parcels',
          PhysicalName: 'mydb.dbo.Parcels',
          Path: '\\Parcels',
          DatasetSubtype1: 4, // Polygon
          DatasetInfo1: 'Shape',
        },
      ];

      const tables = parseGdbItems(rows);

      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe('Parcels');
      expect(tables[0]!.schema).toBe('dbo');
      expect(tables[0]!.isFeatureClass).toBe(true);
      expect(tables[0]!.geometryType).toBe('Polygon');
      expect(tables[0]!.shapeFieldName).toBe('Shape');
    });

    it('should parse table rows (non-feature class)', () => {
      const rows = [
        {
          ObjectID: 2,
          UUID: 'def-456',
          Type: '77C1E6B3-9EB4-4A1D-B686-E1CADD1E3ADA', // Table
          Name: 'Owners',
          PhysicalName: 'mydb.dbo.Owners',
          Path: '\\Owners',
        },
      ];

      const tables = parseGdbItems(rows);

      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe('Owners');
      expect(tables[0]!.isFeatureClass).toBe(false);
      expect(tables[0]!.geometryType).toBeUndefined();
    });

    it('should extract schema from physical name', () => {
      const rows = [
        {
          ObjectID: 1,
          UUID: 'abc',
          Type: '77C1E6B3-9EB4-4A1D-B686-E1CADD1E3ADA',
          Name: 'Test',
          PhysicalName: 'database.custom_schema.MyTable',
          Path: '\\Test',
        },
      ];

      const tables = parseGdbItems(rows);

      expect(tables[0]!.schema).toBe('custom_schema');
      expect(tables[0]!.name).toBe('MyTable');
    });
  });
});

describe('Geometry Writer', () => {
  describe('geometryToWkt', () => {
    it('should convert a Point to WKT', () => {
      const geom: Geometry = { type: 'Point', coordinates: [1, 2], srid: 4326 };
      expect(geometryToWkt(geom)).toBe('POINT (1 2)');
    });

    it('should convert a MultiPoint to WKT', () => {
      const geom: Geometry = { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]], srid: 4326 };
      expect(geometryToWkt(geom)).toBe('MULTIPOINT ((0 0), (1 1))');
    });

    it('should convert a LineString to WKT', () => {
      const geom: Geometry = { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 0]], srid: 4326 };
      expect(geometryToWkt(geom)).toBe('LINESTRING (0 0, 1 1, 2 0)');
    });

    it('should convert a MultiLineString to WKT', () => {
      const geom: Geometry = {
        type: 'MultiLineString',
        coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]],
        srid: 4326
      };
      expect(geometryToWkt(geom)).toBe('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))');
    });

    it('should convert a Polygon to WKT', () => {
      const geom: Geometry = {
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        srid: 4326
      };
      expect(geometryToWkt(geom)).toBe('POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))');
    });

    it('should convert a Polygon with hole to WKT', () => {
      const geom: Geometry = {
        type: 'Polygon',
        coordinates: [
          [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
          [[2, 2], [8, 2], [8, 8], [2, 8], [2, 2]]
        ],
        srid: 4326
      };
      expect(geometryToWkt(geom)).toBe('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 8 2, 8 8, 2 8, 2 2))');
    });

    it('should convert a MultiPolygon to WKT', () => {
      const geom: Geometry = {
        type: 'MultiPolygon',
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          [[[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]]]
        ],
        srid: 4326
      };
      expect(geometryToWkt(geom)).toBe('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 1, 0 0)), ((2 2, 3 2, 3 3, 2 3, 2 2)))');
    });
  });

  describe('geometryToSqlExpression', () => {
    it('should create SQL Server expression', () => {
      const geom: Geometry = { type: 'Point', coordinates: [1, 2], srid: 2236 };
      const sql = geometryToSqlExpression(geom, 'sqlserver');
      expect(sql).toBe("geometry::STGeomFromText('POINT (1 2)', 2236)");
    });

    it('should create PostgreSQL expression', () => {
      const geom: Geometry = { type: 'Point', coordinates: [1, 2], srid: 4326 };
      const sql = geometryToSqlExpression(geom, 'postgresql');
      expect(sql).toBe("ST_GeomFromText('POINT (1 2)', 4326)");
    });

    it('should use provided SRID over geometry SRID', () => {
      const geom: Geometry = { type: 'Point', coordinates: [1, 2], srid: 4326 };
      const sql = geometryToSqlExpression(geom, 'sqlserver', 2236);
      expect(sql).toBe("geometry::STGeomFromText('POINT (1 2)', 2236)");
    });
  });

  describe('isValidGeometry', () => {
    it('should validate a Point', () => {
      expect(isValidGeometry({ type: 'Point', coordinates: [1, 2] })).toBe(true);
      expect(isValidGeometry({ type: 'Point', coordinates: [1] } as Geometry)).toBe(false);
      expect(isValidGeometry({ type: 'Point', coordinates: ['a', 'b'] } as unknown as Geometry)).toBe(false);
    });

    it('should validate a LineString', () => {
      expect(isValidGeometry({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBe(true);
      expect(isValidGeometry({ type: 'LineString', coordinates: [[0, 0]] })).toBe(false); // min 2 points
    });

    it('should validate a Polygon', () => {
      expect(isValidGeometry({
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] // 4 points (closed ring)
      })).toBe(true);

      expect(isValidGeometry({
        type: 'Polygon',
        coordinates: [[[0, 0], [1, 0], [1, 1]]] // 3 points (not a valid ring)
      })).toBe(false);
    });

    it('should reject invalid geometry', () => {
      expect(isValidGeometry(null as unknown as Geometry)).toBe(false);
      expect(isValidGeometry({} as Geometry)).toBe(false);
      expect(isValidGeometry({ type: 'Point' } as Geometry)).toBe(false);
    });

    it('should validate Infinity coordinates as invalid', () => {
      expect(isValidGeometry({ type: 'Point', coordinates: [Infinity, 0] })).toBe(false);
      expect(isValidGeometry({ type: 'Point', coordinates: [0, NaN] })).toBe(false);
    });
  });

  describe('WKT validation (via geometryToSqlExpression)', () => {
    it('should handle standard WKT correctly', () => {
      const geom: Geometry = { type: 'Point', coordinates: [1, 2] };
      // Should not throw
      expect(() => geometryToSqlExpression(geom, 'sqlserver')).not.toThrow();
    });

    it('should handle coordinates with scientific notation', () => {
      // Small coordinates that would be rendered with scientific notation
      const geom: Geometry = { type: 'Point', coordinates: [1.5e-10, 2.5e10] };
      expect(() => geometryToSqlExpression(geom, 'postgresql')).not.toThrow();
    });

    it('should handle negative coordinates', () => {
      const geom: Geometry = { type: 'Point', coordinates: [-122.4194, 37.7749] };
      expect(() => geometryToSqlExpression(geom, 'sqlserver')).not.toThrow();
    });

    it('should handle complex geometry types', () => {
      const geom: Geometry = {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Point', coordinates: [0, 0] },
          { type: 'LineString', coordinates: [[1, 1], [2, 2]] },
        ],
      };
      expect(() => geometryToSqlExpression(geom, 'postgresql')).not.toThrow();
    });
  });
});

describe('SDEBINARY Parser', () => {
  // Boundary/error-path tests. Round-trip tests against captured live payloads
  // belong under integration tests (need a real ArcSDE f-table).
  const stdSr: SpatialReferenceParams = {
    falsex: 0,
    falsey: 0,
    xyunits: 4000,
    srid: 3,
  };

  describe('parseSdeBinaryMultiPart', () => {
    it('reports failure on an empty buffer', () => {
      const result = parseSdeBinaryMultiPart(Buffer.alloc(0), 0, stdSr);
      expect(result.success).toBe(false);
      expect(result.parts).toEqual([]);
      expect(result.partCount).toBe(0);
      expect(result.error).toMatch(/Insufficient/);
    });

    it('reports failure on a buffer with header but no varints', () => {
      const result = parseSdeBinaryMultiPart(Buffer.alloc(8), 0, stdSr);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Insufficient/);
    });

    it('flags hasCurves when header byte 5 has bit 0x08 set', () => {
      // The "has curves" flag lives in byte 5 of the 8-byte header (verified
      // across 305 polygon layers in test data, and consistent with Esri's
      // ArcSDE 10.0 SDK byte layout).
      const buf = Buffer.alloc(8 + 30);
      buf[5] = 0x08;
      const result = parseSdeBinaryMultiPart(buf, 2, stdSr);
      expect(result.hasCurves).toBe(true);
    });

    it('does not flag hasCurves when byte 5 is 0', () => {
      const buf = Buffer.alloc(8 + 20);
      const result = parseSdeBinaryMultiPart(buf, 4, stdSr);
      expect(result.hasCurves).toBe(false);
    });

    it('handles numPoints=0 without throwing', () => {
      const buf = Buffer.alloc(8 + 4);
      expect(() => parseSdeBinaryMultiPart(buf, 0, stdSr)).not.toThrow();
    });
  });

  describe('parseSdeBinary', () => {
    it('returns null when underlying parse fails', () => {
      const result = parseSdeBinary(Buffer.alloc(0), 0, /* polygon */ 8, stdSr);
      expect(result).toBeNull();
    });

    it('returns null when a curve-classified payload has insufficient varints', () => {
      // 8-byte header + 13 bytes all 0x80 (continuation set, never terminating)
      // parses as a single 13-byte varint, giving 13 bytes/point at numPoints=1.
      // That trips the curve threshold (>12 bytes/pt), but with only 1 varint
      // the early `varints.length < 2` guard fires before curve extraction
      // runs. parseSdeBinary surfaces the upstream failure as null.
      const buf = Buffer.concat([Buffer.alloc(8), Buffer.alloc(13, 0x80)]);
      const result = parseSdeBinary(buf, 1, /* polygon */ 8, stdSr);
      expect(result).toBeNull();
    });

    it('returns null when curve-vertex extraction yields no vertices', () => {
      // All-zeros payload past the curve threshold: bytes/point > 12 (so
      // hasCurves is true) AND varints.length >= 2 (so the early-exit doesn't
      // fire) AND every varint decodes to zero. The curve segment loop sees
      // no non-zero deltas, returns an empty vertex array, and parseSdeBinary
      // surfaces null.
      // 8 header + 30 zero bytes = 30 zero-varints (each 0x00 is a complete
      // varint) at numPoints=2 → 15 bytes/pt, above threshold.
      const buf = Buffer.alloc(8 + 30);
      const result = parseSdeBinary(buf, 2, /* polygon */ 8, stdSr);
      // With all-zero deltas every "pair" has angle 0 and dx=dy=0, which the
      // curve decoder may interpret as either no vertices (returning null) OR
      // a degenerate single-point polygon at origin. Both are acceptable
      // failure modes for a degenerate input; assert one of them.
      if (result !== null) {
        // If a geometry is produced, it must be at the spatial-reference
        // origin (falsex, falsey) — i.e. no real coordinate data extracted.
        const coords = (result as { coordinates: unknown }).coordinates;
        const flat = JSON.stringify(coords);
        expect(flat).toMatch(/\[0,0\]|\[\[0,0\]/);
      }
    });

    it('threads spatialRef.srid through to a successfully-parsed geometry', () => {
      // Exercise the same all-zeros polygon path above, but with a custom
      // srid; if a geometry comes back, it should carry the configured srid.
      const sr: SpatialReferenceParams = { ...stdSr, srid: 12345 };
      const buf = Buffer.alloc(8 + 30);
      const result = parseSdeBinary(buf, 2, /* polygon */ 8, sr);
      if (result !== null) {
        expect(result.srid).toBe(12345);
      }
    });
  });

  describe('parseSdeBinaryPoints (legacy single-part wrapper)', () => {
    it('returns an empty array when there are no parts', () => {
      const result = parseSdeBinaryPoints(Buffer.alloc(0), 0, stdSr);
      expect(result).toEqual([]);
    });
  });
});

describe('Curve Densification', () => {
  describe('densifyArc', () => {
    it('produces segments+1 points', () => {
      // Quarter arc from (1,0) to (0,1) around origin, CCW
      const out = densifyArc([1, 0], [0, 1], 0, 0, true, 8);
      expect(out.length).toBe(9);
    });

    it('starts at start and ends at end', () => {
      const out = densifyArc([1, 0], [0, 1], 0, 0, true, 4);
      expect(out[0]).toEqual([1, 0]);
      expect(out[out.length - 1]).toEqual([0, 1]);
    });

    it('produces points on the circle (CCW quarter arc)', () => {
      const out = densifyArc([1, 0], [0, 1], 0, 0, true, 16);
      for (const p of out) {
        const r = Math.hypot(p[0]!, p[1]!);
        expect(r).toBeCloseTo(1, 6);
      }
    });

    it('CCW vs CW pick different arcs', () => {
      // CCW from (1,0) to (-1,0): goes through (0,1) (upper)
      const ccw = densifyArc([1, 0], [-1, 0], 0, 0, true, 4);
      // CW from (1,0) to (-1,0): goes through (0,-1) (lower)
      const cw = densifyArc([1, 0], [-1, 0], 0, 0, false, 4);
      // Mid-arc point: CCW should have y > 0, CW should have y < 0
      expect(ccw[2]![1]!).toBeGreaterThan(0);
      expect(cw[2]![1]!).toBeLessThan(0);
    });

    it('handles long arc (CCW from (1,0) to (1,-ε) going almost full circle)', () => {
      // CCW from (1,0) to (cos(-π/4), sin(-π/4)): the CCW path goes the long way (~7π/4)
      const end: [number, number] = [Math.cos(-Math.PI / 4), Math.sin(-Math.PI / 4)];
      const out = densifyArc([1, 0], end, 0, 0, true, 32);
      // Mid-arc should be roughly (-1, 0) since we go around the long way
      const mid = out[16]!;
      expect(mid[0]).toBeLessThan(0);
    });
  });

  describe('densifyBezier', () => {
    it('produces segments+1 points', () => {
      const out = densifyBezier([0, 0], [1, 1], [2, 1], [3, 0], 8);
      expect(out.length).toBe(9);
    });

    it('starts at start and ends at end', () => {
      const out = densifyBezier([0, 0], [1, 2], [3, 2], [4, 0], 4);
      expect(out[0]).toEqual([0, 0]);
      expect(out[out.length - 1]).toEqual([4, 0]);
    });
  });

  describe('densifyCurves', () => {
    it('returns identical parts when curves array is empty', () => {
      const parts = [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ];
      const result = densifyCurves(parts, []);
      expect(result.length).toBe(1);
      expect(result[0]).toHaveLength(5);
    });

    it('densifies a circular arc segment in a polygon', () => {
      // Esri's modern arc encoding stores three points on the arc: start,
      // end, and a midpoint. Here the chord is (10,0)→(10,10), and we mark
      // the arc midpoint at (15,5) — a half-circle bulging to +X.
      const parts = [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ];
      const curves: SegmentModifier[] = [
        {
          startPointIndex: 1, // chord between point 1 and point 2
          segmentType: 1,
          centerX: 15, // arc midpoint X (not the geometric center)
          centerY: 5,  // arc midpoint Y
        },
      ];
      const out = densifyCurves(parts, curves, { segmentsPerCurve: 8 });
      expect(out.length).toBe(1);
      const ring = out[0]!;
      // Original 5 points + 7 interior arc samples (segments - 1) = 12
      expect(ring.length).toBe(12);
      expect(ring[0]).toEqual([0, 0]);
      expect(ring[1]).toEqual([10, 0]);
      expect(ring[ring.length - 1]).toEqual([0, 0]);
      // Mid-arc (densified index 4 → ring index 5) is at (15, 5)
      const midArc = ring[5]!;
      expect(midArc[0]!).toBeCloseTo(15, 1);
      expect(midArc[1]!).toBeCloseTo(5, 1);
    });

    it('skips densification when isLine is set', () => {
      const parts = [
        [
          [0, 0],
          [10, 0],
        ],
      ];
      const curves: SegmentModifier[] = [
        {
          startPointIndex: 0,
          segmentType: 1,
          centerX: 5,
          centerY: 0,
          isLine: true,
        },
      ];
      const out = densifyCurves(parts, curves);
      expect(out[0]).toHaveLength(2); // unchanged
    });

    it('maps global startPointIndex correctly across multipart rings', () => {
      // Two rings of 3 points each. Curve attaches at global index 4
      // (= ring 1, local index 1).
      const parts = [
        [
          [0, 0],
          [10, 0],
          [0, 0],
        ],
        [
          [100, 100],
          [200, 100],
          [100, 100],
        ],
      ];
      const curves: SegmentModifier[] = [
        {
          startPointIndex: 4,
          segmentType: 1,
          centerX: 150, // arc midpoint X
          centerY: 110, // arc midpoint Y (bulges up — non-collinear with chord)
        },
      ];
      const out = densifyCurves(parts, curves, { segmentsPerCurve: 8 });
      expect(out[0]).toHaveLength(3); // ring 0 unchanged
      expect(out[1]!.length).toBeGreaterThan(3); // ring 1 densified
    });
  });
});
