/**
 * Parse SQL Server and PostGIS geometry types
 *
 * Converts WKB (Well-Known Binary) to our internal Geometry format.
 */

import type { Geometry as InternalGeometry, GeometryType } from '../types';
import type { Geometry as GeoJSONGeometry } from 'geojson';

/**
 * Parse Well-Known Binary (WKB) to Geometry
 *
 * This handles standard OGC WKB format, which both SQL Server (.STAsBinary())
 * and PostGIS (ST_AsBinary()) can produce.
 */
export function parseWkb(wkb: Buffer, srid?: number): InternalGeometry | null {
  if (!wkb || wkb.length < 5) return null;

  let offset = 0;

  // Byte order (1 = little endian, 0 = big endian)
  const byteOrder = wkb.readUInt8(offset);
  offset += 1;

  const isLittleEndian = byteOrder === 1;

  // Geometry type (with optional Z/M flags in high bits)
  const geomType = isLittleEndian
    ? wkb.readUInt32LE(offset)
    : wkb.readUInt32BE(offset);
  offset += 4;

  // Parse type modifiers - WKB encodes dimension flags in two ways:
  //
  // 1. EWKB (PostGIS extended WKB) uses high bits:
  //    - 0x20000000: has SRID
  //    - 0x80000000: has Z coordinate
  //    - 0x40000000: has M coordinate
  //
  // 2. ISO WKB uses type offsets (OGC 06-103r4):
  //    - Base type 1-7 for 2D (Point=1, LineString=2, etc.)
  //    - +1000 for Z (e.g., PointZ=1001)
  //    - +2000 for M (e.g., PointM=2001)
  //    - +3000 for ZM (e.g., PointZM=3001)
  //
  // We detect both formats: check high bits first, then fall back to type/1000
  const hasEwkbSrid = (geomType & 0x20000000) !== 0;
  const baseType = geomType & 0xff;
  // EWKB Z flag OR ISO type 1xxx or 3xxx (odd thousands digit)
  const hasZ = (geomType & 0x80000000) !== 0 || ((geomType / 1000) | 0) % 2 === 1;
  // EWKB M flag OR ISO type 2xxx or 3xxx (thousands digit >= 2)
  const hasM = (geomType & 0x40000000) !== 0 || ((geomType / 1000) | 0) >= 2;

  // Read SRID if EWKB
  let parsedSrid = srid;
  if (hasEwkbSrid) {
    parsedSrid = isLittleEndian
      ? wkb.readUInt32LE(offset)
      : wkb.readUInt32BE(offset);
    offset += 4;
  }

  const coordDims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

  switch (baseType) {
    case 1: // Point
      return parsePoint(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 2: // LineString
      return parseLineString(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 3: // Polygon
      return parsePolygon(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 4: // MultiPoint
      return parseMultiPoint(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 5: // MultiLineString
      return parseMultiLineString(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 6: // MultiPolygon
      return parseMultiPolygon(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 7: // GeometryCollection
      return parseGeometryCollection(wkb, offset, isLittleEndian, parsedSrid);
    default:
      console.warn(`Unsupported geometry type: ${baseType}`);
      return null;
  }
}

function readDouble(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
}

function readUInt32(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function readCoordinate(
  buf: Buffer,
  offset: number,
  littleEndian: boolean,
  dims: number
): { coord: number[]; newOffset: number } {
  const coord: number[] = [];
  for (let d = 0; d < dims; d++) {
    coord.push(readDouble(buf, offset + d * 8, littleEndian));
  }
  return { coord, newOffset: offset + dims * 8 };
}

function parsePoint(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): InternalGeometry {
  const { coord } = readCoordinate(wkb, offset, littleEndian, coordDims);

  return {
    type: 'Point',
    coordinates: coord.length === 2 ? coord : coord.slice(0, 2),
    srid,
  };
}

function parseLineString(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): InternalGeometry {
  const numPoints = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][] = [];
  for (let i = 0; i < numPoints; i++) {
    const { coord, newOffset } = readCoordinate(wkb, offset, littleEndian, coordDims);
    coordinates.push(coord.length === 2 ? coord : coord.slice(0, 2));
    offset = newOffset;
  }

  return {
    type: 'LineString',
    coordinates,
    srid,
  };
}

function parsePolygon(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): InternalGeometry {
  const numRings = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][][] = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = readUInt32(wkb, offset, littleEndian);
    offset += 4;

    const ring: number[][] = [];
    for (let i = 0; i < numPoints; i++) {
      const { coord, newOffset } = readCoordinate(wkb, offset, littleEndian, coordDims);
      ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
      offset = newOffset;
    }
    coordinates.push(ring);
  }

  return {
    type: 'Polygon',
    coordinates,
    srid,
  };
}

function parseMultiPoint(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): InternalGeometry {
  const numPoints = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][] = [];
  for (let i = 0; i < numPoints; i++) {
    // Skip WKB header for each point (5 bytes: byte order + type)
    offset += 5;
    const { coord, newOffset } = readCoordinate(wkb, offset, littleEndian, coordDims);
    coordinates.push(coord.length === 2 ? coord : coord.slice(0, 2));
    offset = newOffset;
  }

  return {
    type: 'MultiPoint',
    coordinates,
    srid,
  };
}

function parseMultiLineString(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): InternalGeometry {
  const numLines = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][][] = [];
  for (let l = 0; l < numLines; l++) {
    // Skip WKB header for each linestring
    offset += 5;
    const numPoints = readUInt32(wkb, offset, littleEndian);
    offset += 4;

    const line: number[][] = [];
    for (let i = 0; i < numPoints; i++) {
      const { coord, newOffset } = readCoordinate(wkb, offset, littleEndian, coordDims);
      line.push(coord.length === 2 ? coord : coord.slice(0, 2));
      offset = newOffset;
    }
    coordinates.push(line);
  }

  return {
    type: 'MultiLineString',
    coordinates,
    srid,
  };
}

function parseMultiPolygon(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): InternalGeometry {
  const numPolygons = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][][][] = [];
  for (let p = 0; p < numPolygons; p++) {
    // Skip WKB header for each polygon
    offset += 5;
    const numRings = readUInt32(wkb, offset, littleEndian);
    offset += 4;

    const polygon: number[][][] = [];
    for (let r = 0; r < numRings; r++) {
      const numPoints = readUInt32(wkb, offset, littleEndian);
      offset += 4;

      const ring: number[][] = [];
      for (let i = 0; i < numPoints; i++) {
        const { coord, newOffset } = readCoordinate(wkb, offset, littleEndian, coordDims);
        ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
        offset = newOffset;
      }
      polygon.push(ring);
    }
    coordinates.push(polygon);
  }

  return {
    type: 'MultiPolygon',
    coordinates,
    srid,
  };
}

/**
 * Parse a geometry and return both the geometry and the new offset.
 * Used for parsing GeometryCollection members.
 */
function parseGeometryAtOffset(
  wkb: Buffer,
  offset: number,
  srid?: number
): { geometry: InternalGeometry | null; newOffset: number } {
  if (wkb.length < offset + 5) {
    return { geometry: null, newOffset: offset };
  }

  const byteOrder = wkb.readUInt8(offset);
  offset += 1;

  const isLittleEndian = byteOrder === 1;
  const geomType = isLittleEndian
    ? wkb.readUInt32LE(offset)
    : wkb.readUInt32BE(offset);
  offset += 4;

  // See parseWkb() for explanation of EWKB vs ISO WKB type encoding
  const hasEwkbSrid = (geomType & 0x20000000) !== 0;
  const baseType = geomType & 0xff;
  const hasZ = (geomType & 0x80000000) !== 0 || ((geomType / 1000) | 0) % 2 === 1;
  const hasM = (geomType & 0x40000000) !== 0 || ((geomType / 1000) | 0) >= 2;

  let parsedSrid = srid;
  if (hasEwkbSrid) {
    parsedSrid = isLittleEndian
      ? wkb.readUInt32LE(offset)
      : wkb.readUInt32BE(offset);
    offset += 4;
  }

  const coordDims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);

  switch (baseType) {
    case 1: { // Point
      const geometry = parsePoint(wkb, offset, isLittleEndian, coordDims, parsedSrid);
      return { geometry, newOffset: offset + coordDims * 8 };
    }
    case 2: { // LineString
      const numPoints = readUInt32(wkb, offset, isLittleEndian);
      const geometry = parseLineString(wkb, offset, isLittleEndian, coordDims, parsedSrid);
      return { geometry, newOffset: offset + 4 + numPoints * coordDims * 8 };
    }
    case 3: { // Polygon
      const result = parsePolygonWithOffset(wkb, offset, isLittleEndian, coordDims, parsedSrid);
      return result;
    }
    case 4: { // MultiPoint
      const numPoints = readUInt32(wkb, offset, isLittleEndian);
      let newOffset = offset + 4;
      for (let i = 0; i < numPoints; i++) {
        newOffset += 5 + coordDims * 8; // header + point coords
      }
      const geometry = parseMultiPoint(wkb, offset, isLittleEndian, coordDims, parsedSrid);
      return { geometry, newOffset };
    }
    case 5: { // MultiLineString
      const result = parseMultiLineStringWithOffset(wkb, offset, isLittleEndian, coordDims, parsedSrid);
      return result;
    }
    case 6: { // MultiPolygon
      const result = parseMultiPolygonWithOffset(wkb, offset, isLittleEndian, coordDims, parsedSrid);
      return result;
    }
    case 7: { // Nested GeometryCollection
      const result = parseGeometryCollectionWithOffset(wkb, offset, isLittleEndian, parsedSrid);
      return result;
    }
    default:
      console.warn(`Unsupported geometry type in collection: ${baseType}`);
      return { geometry: null, newOffset: offset };
  }
}

function parsePolygonWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): { geometry: InternalGeometry; newOffset: number } {
  const numRings = readUInt32(wkb, offset, littleEndian);
  let currentOffset = offset + 4;

  const coordinates: number[][][] = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = readUInt32(wkb, currentOffset, littleEndian);
    currentOffset += 4;

    const ring: number[][] = [];
    for (let i = 0; i < numPoints; i++) {
      const { coord, newOffset } = readCoordinate(wkb, currentOffset, littleEndian, coordDims);
      ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
      currentOffset = newOffset;
    }
    coordinates.push(ring);
  }

  return {
    geometry: { type: 'Polygon', coordinates, srid },
    newOffset: currentOffset,
  };
}

function parseMultiLineStringWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): { geometry: InternalGeometry; newOffset: number } {
  const numLines = readUInt32(wkb, offset, littleEndian);
  let currentOffset = offset + 4;

  const coordinates: number[][][] = [];
  for (let l = 0; l < numLines; l++) {
    currentOffset += 5; // Skip WKB header
    const numPoints = readUInt32(wkb, currentOffset, littleEndian);
    currentOffset += 4;

    const line: number[][] = [];
    for (let i = 0; i < numPoints; i++) {
      const { coord, newOffset } = readCoordinate(wkb, currentOffset, littleEndian, coordDims);
      line.push(coord.length === 2 ? coord : coord.slice(0, 2));
      currentOffset = newOffset;
    }
    coordinates.push(line);
  }

  return {
    geometry: { type: 'MultiLineString', coordinates, srid },
    newOffset: currentOffset,
  };
}

function parseMultiPolygonWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number
): { geometry: InternalGeometry; newOffset: number } {
  const numPolygons = readUInt32(wkb, offset, littleEndian);
  let currentOffset = offset + 4;

  const coordinates: number[][][][] = [];
  for (let p = 0; p < numPolygons; p++) {
    currentOffset += 5; // Skip WKB header
    const numRings = readUInt32(wkb, currentOffset, littleEndian);
    currentOffset += 4;

    const polygon: number[][][] = [];
    for (let r = 0; r < numRings; r++) {
      const numPoints = readUInt32(wkb, currentOffset, littleEndian);
      currentOffset += 4;

      const ring: number[][] = [];
      for (let i = 0; i < numPoints; i++) {
        const { coord, newOffset } = readCoordinate(wkb, currentOffset, littleEndian, coordDims);
        ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
        currentOffset = newOffset;
      }
      polygon.push(ring);
    }
    coordinates.push(polygon);
  }

  return {
    geometry: { type: 'MultiPolygon', coordinates, srid },
    newOffset: currentOffset,
  };
}

function parseGeometryCollectionWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  srid?: number
): { geometry: InternalGeometry; newOffset: number } {
  const numGeometries = readUInt32(wkb, offset, littleEndian);
  let currentOffset = offset + 4;

  const geometries: InternalGeometry[] = [];
  for (let i = 0; i < numGeometries; i++) {
    const result = parseGeometryAtOffset(wkb, currentOffset, srid);
    if (result.geometry) {
      geometries.push(result.geometry);
    }
    currentOffset = result.newOffset;
  }

  return {
    geometry: { type: 'GeometryCollection', geometries, srid } as InternalGeometry,
    newOffset: currentOffset,
  };
}

function parseGeometryCollection(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  srid?: number
): InternalGeometry {
  const { geometry } = parseGeometryCollectionWithOffset(wkb, offset, littleEndian, srid);
  return geometry;
}

/**
 * Convert Geometry to GeoJSON format
 */
export function geometryToGeoJSON(geometry: InternalGeometry): GeoJSONGeometry {
  // Handle GeometryCollection separately since it uses 'geometries' not 'coordinates'
  if (geometry.type === 'GeometryCollection') {
    const geomCollection = geometry as { type: 'GeometryCollection'; geometries: InternalGeometry[] };
    return {
      type: 'GeometryCollection',
      geometries: geomCollection.geometries.map(g => geometryToGeoJSON(g)),
    } as unknown as GeoJSONGeometry;
  }

  // GeoJSON Geometry is a union type, so we cast through unknown
  return {
    type: geometry.type,
    coordinates: (geometry as { coordinates: unknown }).coordinates,
  } as unknown as GeoJSONGeometry;
}
