/**
 * Unit tests for parsers (no database required)
 */

import { describe, it, expect } from 'vitest';
import { parseWkb } from '../src/parsers/geometry-parser.js';
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
