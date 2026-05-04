/**
 * Parse SQL Server and PostGIS geometry types
 *
 * Converts WKB (Well-Known Binary) to our internal Geometry format.
 */

import type { Geometry as InternalGeometry, GeometryType } from '../types';
import type { Geometry as GeoJSONGeometry } from 'geojson';
import { type Logger, consoleLogger } from '../logger';

/**
 * Module-level logger used by the parser's "unsupported geometry" warnings.
 *
 * The parser is a stateless utility called from many places (table reads,
 * direct WKB parsing in tests/scripts), so threading a logger through every
 * call site is impractical. We use a module-level setter instead — the
 * geodatabase calls `setParserLogger(config.logger)` on connect so the
 * configured logger receives parser warnings too.
 *
 * Caveat: this is process-wide global state. If two `EnterpriseGeodatabase`
 * connections in the same process configure different loggers, the
 * last-wins. Acceptable for the typical "one process, one logger" shape;
 * applications that need stricter isolation should configure a single
 * logger upstream.
 */
let parserLogger: Logger = consoleLogger;

export function setParserLogger(logger: Logger): void {
  parserLogger = logger;
}

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
      parserLogger.warn(`Unsupported geometry type: ${baseType}`);
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
      parserLogger.warn(`Unsupported geometry type in collection: ${baseType}`);
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

// =============================================================================
// SDEBINARY PARSING
// =============================================================================
//
// Esri SDEBINARY is a compressed geometry format used in legacy ArcSDE storage
// where geometries are stored in "f-tables" (e.g., sde.f13) rather than as
// native SQL geometry types.
//
// Format structure:
// - 8-byte header
// - Coordinates as LEB128 varints with 6-bit encoding
// - First coordinate is absolute
// - Subsequent coordinates are delta-encoded in REVERSE order
//
// Decode formulas (verified 100% on 74 polygons):
// - First coordinates: storage = ((raw >> 6) << 5) | (raw & 63)
// - Deltas: sign in bit6 (1=positive, 0=negative)
//           if positive and bit5=0, subtract 32 from decoded value
// =============================================================================

/**
 * Read a LEB128 variable-length integer from a buffer
 */
function readVarInt(buffer: Buffer, offset: number): { value: bigint; bytesRead: number } {
  let value = 0n;
  let shift = 0n;
  let bytesRead = 0;
  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead]!;
    bytesRead++;
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) break;
  }
  return { value, bytesRead };
}

/**
 * Decode storage value from 6-bit encoded raw varint
 * Formula: storage = ((raw >> 6) << 5) | (raw & 63)
 */
function sdeDecodeStorage(raw: bigint): bigint {
  return ((raw >> 6n) << 5n) | (raw & 63n);
}

/**
 * Decode a delta value from 6-bit encoded raw varint
 * - bit6 encodes sign: 1 = positive, 0 = negative
 * - For positive values with bit5=0, subtract 32 (encoding added 32 to set bit5)
 */
function sdeDecodeDelta(raw: bigint): bigint {
  const bit5 = (raw >> 5n) & 1n;
  const bit6 = (raw >> 6n) & 1n;

  let absValue = sdeDecodeStorage(raw);

  // If positive (bit6=1) and bit5=0, the encoding added 32
  if (bit6 === 1n && bit5 === 0n) {
    absValue -= 32n;
  }

  // bit6=1 means positive, bit6=0 means negative
  return bit6 === 1n ? absValue : -absValue;
}

/**
 * Spatial reference parameters needed to convert storage units to real coordinates
 */
export interface SpatialReferenceParams {
  falsex: number;
  falsey: number;
  xyunits: number;
  srid?: number;
}

/**
 * Threshold for identifying absolute coordinates (vs deltas)
 * Values larger than this are likely absolute coordinates marking part boundaries
 */
const SDE_ABSOLUTE_COORD_THRESHOLD = 10000000n;

/**
 * Threshold for bytes-per-point ratio to detect curve geometries
 * Simple polygons: ~5-6 bytes/point
 * Curve polygons: ~20-25 bytes/point
 */
const SDE_CURVE_BYTES_PER_POINT_THRESHOLD = 12;

/**
 * Result of parsing SDEBINARY - includes metadata about the parse
 */
export interface SdeBinaryParseResult {
  /** Parsed coordinate rings (for polygons) or coordinate arrays */
  parts: number[][][];
  /** Whether this geometry contains curves/arcs (not fully decoded) */
  hasCurves: boolean;
  /** Number of parts detected */
  partCount: number;
  /**
   * Whether decoding was successful.
   *
   * NOTE: `success: true` for curve geometries does not imply exact
   * coordinates. The current curve decoder is empirically off by ~1.7% on
   * the studied dataset (hundreds of feet at typical map scales). When the
   * geometry contains curves AND parsing succeeded, `approximate` is set
   * — consumers that need exact coordinates must check this flag and
   * either reject or densify upstream.
   */
  success: boolean;
  /**
   * True iff the returned coordinates are approximations rather than exact
   * decodings. Currently set only for curve geometries (~1.7% error). Always
   * undefined / false when `hasCurves` is false.
   */
  approximate?: boolean;
  /** Error message if parsing failed */
  error?: string;
}

/**
 * Detect if SDEBINARY data contains curve/arc geometry based on data density
 *
 * @param pointsBuffer - Raw binary data
 * @param numPoints - Expected number of points
 * @returns true if this appears to be curve geometry
 */
function sdeDetectCurveGeometry(pointsBuffer: Buffer, numPoints: number): boolean {
  if (numPoints === 0) return false;
  const bytesPerPoint = (pointsBuffer.length - 8) / numPoints; // Exclude 8-byte header
  return bytesPerPoint > SDE_CURVE_BYTES_PER_POINT_THRESHOLD;
}

/**
 * Parse curve geometry by extracting curve vertices
 *
 * Curve geometries store segment-based data with zeros as separators.
 * Each segment contains:
 * - Pair 0: Total chord magnitude (SKIP - not a vertex)
 * - Pair 1+: Coordinate deltas with same angle as pair 0
 * - Perpendicular pairs: Curve shape parameters (skip for vertex extraction)
 *
 * VERIFIED: Pair 1 matches shapefile point with 1.7% error
 *
 * @param varints - All varints from the buffer (starting after header)
 * @returns Array of storage coordinates (curve vertices)
 */
function sdeDecodeCurveVertices(varints: bigint[]): { x: bigint; y: bigint }[] {
  if (varints.length < 2) {
    return [];
  }

  // First coordinate is absolute
  const firstX = sdeDecodeStorage(varints[0]!);
  const firstY = sdeDecodeStorage(varints[1]!);

  // Collect all coordinate deltas, then apply them cumulatively
  // This approach is simpler and avoids tracking segment positions incorrectly
  const deltas: { dx: bigint; dy: bigint }[] = [];

  // Parse segments (separated by zeros)
  let segStart = 2;

  for (let i = 2; i <= varints.length; i++) {
    if (i === varints.length || varints[i] === 0n) {
      if (i > segStart) {
        const vals = varints.slice(segStart, i);

        // Decode pairs in this segment
        const pairs: { dx: bigint; dy: bigint; angle: number }[] = [];
        for (let j = 0; j + 1 < vals.length; j += 2) {
          const dx = sdeDecodeDelta(vals[j]!);
          const dy = sdeDecodeDelta(vals[j + 1]!);
          pairs.push({ dx, dy, angle: Math.atan2(Number(dy), Number(dx)) });
        }

        if (pairs.length >= 2) {
          // Pair 0 is the total chord - use its angle as reference.
          // Optional-chain + ?? 0 is unreachable given the length guard above,
          // but matches the project's anti-! posture.
          const baseAngle = pairs[0]?.angle ?? 0;

          // Extract coordinate deltas (pairs with similar angle to chord)
          for (let p = 1; p < pairs.length; p++) {
            const pair = pairs[p];
            if (pair === undefined) continue; // unreachable given loop bounds; matches anti-! posture

            // Skip metadata pairs: deltas with magnitude > 40 million storage units
            // are curve metadata (type indicators, flags), not coordinate deltas
            // 40 million storage units = 10,000 feet at xyunits=4000 (~2 miles)
            // This is generous - typical polygon segments are much smaller
            const absDx = pair.dx < 0n ? -pair.dx : pair.dx;
            const absDy = pair.dy < 0n ? -pair.dy : pair.dy;
            if (absDx > 40000000n || absDy > 40000000n) {
              continue;
            }

            const angleDiff = Math.abs(pair.angle - baseAngle);

            // Same direction (within 45°) = coordinate delta
            if (angleDiff < Math.PI / 4 || angleDiff > Math.PI * 7 / 4) {
              deltas.push({ dx: pair.dx, dy: pair.dy });
            }
          }
        }
      }
      segStart = i + 1;
    }
  }

  // Build vertices by applying deltas cumulatively
  const vertices: { x: bigint; y: bigint }[] = [{ x: firstX, y: firstY }];
  let cx = firstX;
  let cy = firstY;

  for (const d of deltas) {
    cx += d.dx;
    cy += d.dy;
    vertices.push({ x: cx, y: cy });
  }

  return vertices;
}

/**
 * Parse a single part from varints starting at the given index
 *
 * @param varints - All varints from the buffer
 * @param startIdx - Starting index in varints array
 * @param numPoints - Number of points in this part
 * @returns Parsed storage coordinates and next varint index
 */
function sdeDecodePart(
  varints: bigint[],
  startIdx: number,
  numPoints: number
): { coords: { x: bigint; y: bigint }[]; nextIdx: number } {
  if (startIdx + 1 >= varints.length) {
    return { coords: [], nextIdx: startIdx };
  }

  // First point uses absolute encoding
  const firstX = sdeDecodeStorage(varints[startIdx]!);
  const firstY = sdeDecodeStorage(varints[startIdx + 1]!);

  // Decode deltas
  const numDeltas = numPoints - 1;
  const deltas: { dx: bigint; dy: bigint }[] = [];
  for (let i = 0; i < numDeltas; i++) {
    const idx = startIdx + 2 + i * 2;
    if (idx + 1 >= varints.length) break;
    deltas.push({
      dx: sdeDecodeDelta(varints[idx]!),
      dy: sdeDecodeDelta(varints[idx + 1]!),
    });
  }

  // Reverse deltas for forward order
  const forwardDeltas = deltas.slice().reverse();

  // Reconstruct coordinates
  const coords: { x: bigint; y: bigint }[] = [{ x: firstX, y: firstY }];
  let cx = firstX;
  let cy = firstY;
  for (const d of forwardDeltas) {
    cx += d.dx;
    cy += d.dy;
    coords.push({ x: cx, y: cy });
  }

  // Next index is after all varints for this part (abs + deltas)
  const nextIdx = startIdx + 2 + numDeltas * 2;
  return { coords, nextIdx };
}

/**
 * Detect part boundaries in multi-part geometry by finding large coordinate pairs
 *
 * Multi-part structure:
 * - Each part starts with absolute coordinates (large values)
 * - Each part ends with a closing point also stored as absolute coordinates
 * - Pattern: [abs_start, deltas..., abs_close?, abs_next_start, deltas...]
 *
 * When we see two consecutive large coordinate pairs:
 * - First pair = closing point of previous part
 * - Second pair = start of new part (this is the boundary)
 *
 * @param varints - All decoded varints
 * @returns Array of indices where new parts start (always includes 0)
 */
function sdeDetectPartBoundaries(varints: bigint[]): number[] {
  const boundaries: number[] = [0];

  // Find all large coordinate pairs
  const largePairs: number[] = [];
  for (let i = 0; i < varints.length - 1; i += 2) {
    const decodedX = sdeDecodeStorage(varints[i]!);
    const decodedY = sdeDecodeStorage(varints[i + 1]!);
    if (decodedX > SDE_ABSOLUTE_COORD_THRESHOLD && decodedY > SDE_ABSOLUTE_COORD_THRESHOLD) {
      largePairs.push(i);
    }
  }

  // Process large pairs to find actual part boundaries
  // Skip index 0 (already in boundaries)
  // When two large pairs are consecutive (differ by 2), the second is a boundary
  for (let i = 1; i < largePairs.length; i++) {
    const prev = largePairs[i - 1]!;
    const curr = largePairs[i]!;

    if (curr - prev === 2) {
      // Consecutive large pairs: curr is the new part start
      boundaries.push(curr);
    } else if (i === largePairs.length - 1 || largePairs[i + 1]! - curr !== 2) {
      // Isolated large pair (not followed by another large pair)
      // This could be a single-part closing point at the end
      // Only add as boundary if not the closing point of previous part
      // Check if this is far enough from last boundary to be a real part
      const lastBoundary = boundaries[boundaries.length - 1]!;
      const varintsSinceLastBoundary = curr - lastBoundary;
      // A real part should have at least a few points (6+ varints = 3+ points)
      if (varintsSinceLastBoundary >= 6) {
        boundaries.push(curr);
      }
    }
  }

  return boundaries;
}

/**
 * Parse SDEBINARY compressed geometry from f-table points column
 *
 * @param pointsBuffer - The binary points data from the f-table
 * @param numPoints - Number of points in the geometry
 * @param spatialRef - Spatial reference parameters for coordinate conversion
 * @returns Array of [x, y] coordinate pairs in real-world coordinates
 */
export function parseSdeBinaryPoints(
  pointsBuffer: Buffer,
  numPoints: number,
  spatialRef: SpatialReferenceParams
): number[][] {
  const result = parseSdeBinaryMultiPart(pointsBuffer, numPoints, spatialRef);
  // Return first part for backwards compatibility
  return result.parts.length > 0 ? result.parts[0]! : [];
}

/**
 * Parse SDEBINARY with full support for multi-part geometries
 *
 * @param pointsBuffer - The binary points data from the f-table
 * @param numPoints - Total number of points across all parts
 * @param spatialRef - Spatial reference parameters
 * @returns Parse result with all parts and metadata
 */
export function parseSdeBinaryMultiPart(
  pointsBuffer: Buffer,
  numPoints: number,
  spatialRef: SpatialReferenceParams
): SdeBinaryParseResult {
  const { falsex, falsey, xyunits } = spatialRef;

  // Check for curve geometry
  const hasCurves = sdeDetectCurveGeometry(pointsBuffer, numPoints);

  // Read all varints
  const varints: bigint[] = [];
  let offset = 8;
  while (offset < pointsBuffer.length) {
    const v = readVarInt(pointsBuffer, offset);
    if (v.bytesRead === 0) break;
    varints.push(v.value);
    offset += v.bytesRead;
  }

  if (varints.length < 2) {
    return {
      parts: [],
      hasCurves: false,
      partCount: 0,
      success: false,
      error: 'Insufficient varint data',
    };
  }

  // Handle curve geometry using segment-based extraction
  if (hasCurves) {
    const curveVertices = sdeDecodeCurveVertices(varints);

    if (curveVertices.length === 0) {
      return {
        parts: [],
        hasCurves: true,
        partCount: 0,
        success: false,
        error: 'Failed to extract curve vertices',
      };
    }

    // Convert to real coordinates
    const realCoords: number[][] = curveVertices.map(({ x, y }) => [
      Number(x) / xyunits + falsex,
      Number(y) / xyunits + falsey,
    ]);

    // Curve geometries are treated as single-part for now
    // TODO: Multi-part curve detection
    // approximate: true because the curve decoder is empirically off by
    // ~1.7% on the studied dataset. Consumers that need exact coordinates
    // must reject or densify when this flag is set.
    return {
      parts: [realCoords],
      hasCurves: true,
      partCount: 1,
      success: true,
      approximate: true,
    };
  }

  // Detect part boundaries
  const boundaries = sdeDetectPartBoundaries(varints);

  // Calculate points per part based on varint distribution
  // Each part has: 2 varints (abs) + 2*(numPts-1) varints (deltas)
  // But may also have 2 varints for closing point (stored as absolute)
  // So we need to check if the last 2 varints before next boundary are absolute
  const partInfos: { startIdx: number; numPoints: number; hasClosingPoint: boolean }[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const startIdx = boundaries[i]!;
    const endIdx = i + 1 < boundaries.length ? boundaries[i + 1]! : varints.length;
    let numVarints = endIdx - startIdx;

    // Check if this part has an explicit closing point (last 2 varints are large)
    // This happens when there's a next boundary 2 positions after large coords
    let hasClosingPoint = false;
    if (i + 1 < boundaries.length && endIdx >= 2) {
      const closingX = sdeDecodeStorage(varints[endIdx - 2]!);
      const closingY = sdeDecodeStorage(varints[endIdx - 1]!);
      if (closingX > SDE_ABSOLUTE_COORD_THRESHOLD && closingY > SDE_ABSOLUTE_COORD_THRESHOLD) {
        // Last pair before next boundary is absolute - it's the closing point
        hasClosingPoint = true;
        numVarints -= 2; // Don't count closing point in point calculation
      }
    }

    const partNumPoints = numVarints / 2;
    partInfos.push({ startIdx, numPoints: partNumPoints, hasClosingPoint });
  }

  // Decode each part
  const parts: number[][][] = [];

  for (const partInfo of partInfos) {
    const { coords } = sdeDecodePart(varints, partInfo.startIdx, partInfo.numPoints);

    // Convert to real coordinates
    const realCoords: number[][] = coords.map(({ x, y }) => [
      Number(x) / xyunits + falsex,
      Number(y) / xyunits + falsey,
    ]);

    if (realCoords.length > 0) {
      parts.push(realCoords);
    }
  }

  return {
    parts,
    hasCurves: false,
    partCount: parts.length,
    success: parts.length > 0,
  };
}

/**
 * Parse SDEBINARY geometry to our internal Geometry format
 *
 * @param pointsBuffer - The binary points data from the f-table
 * @param numPoints - Number of points in the geometry
 * @param entityType - Geometry entity type (from f-table entity column)
 * @param spatialRef - Spatial reference parameters
 * @returns Parsed geometry or null if parsing fails
 *
 * Entity types in ArcSDE (observed):
 * - 1 = Point
 * - 2 = LineString/Polyline
 * - 3 = Polygon (simple, no multi-part)
 * - 4 = MultiPoint (NOT YET HANDLED — falls through to the polygon branch)
 * - 6, 7 = LineString variants
 * - 8 = Polygon (may be simple or contain curves)
 * - 264 = Multi-part Polygon (= 8 | 256, where 256 is the "multi-part" bit)
 *
 * KNOWN LIMITATIONS:
 * - Polygons with holes are misclassified. Each part is treated as a separate
 *   outer ring (MultiPolygon of overlapping outer rings) rather than
 *   outer+inner rings of one Polygon. Spatial queries (containment, area)
 *   over donut polygons will be incorrect.
 * - Ring closure is not enforced. If SDEBINARY omits the closing point,
 *   GeoJSON-strict consumers (turf.js, mapbox-gl) may reject the output.
 * - Z and M coordinates are not handled; the parser returns 2D regardless.
 * - Entity type 8 with high bytes-per-point ratio (~22 bytes/pt) indicates
 *   curve/arc geometry. The current curve decoder returns coordinates with
 *   ~1.7% error and sets `approximate: true` on the parse result.
 * - Multi-part bit-flag handling is incomplete — only entityType === 264
 *   triggers multi-part interpretation; other multi-part variants
 *   (e.g. 2|256 = 258 for multi-linestring) are not detected.
 *
 * The function signature is provisional pending a real internal consumer.
 * Callers should expect breaking changes to entity-type handling and the
 * parts-shape return.
 */
export function parseSdeBinary(
  pointsBuffer: Buffer,
  numPoints: number,
  entityType: number,
  spatialRef: SpatialReferenceParams
): InternalGeometry | null {
  // Use multi-part parser for full support
  const result = parseSdeBinaryMultiPart(pointsBuffer, numPoints, spatialRef);

  if (!result.success) {
    // If curve geometry, we can't decode it yet
    if (result.hasCurves) {
      parserLogger.warn(`SDEBINARY: ${result.error}`);
    }
    return null;
  }

  const { parts } = result;

  if (parts.length === 0) {
    return null;
  }

  // Determine geometry type based on entity type and part count
  const isMultiPart = parts.length > 1 || entityType === 264;

  // Point
  if (entityType === 1) {
    const firstPart = parts[0]!;
    if (firstPart.length > 0) {
      return {
        type: 'Point',
        coordinates: firstPart[0]!,
        srid: spatialRef.srid,
      };
    }
    return null;
  }

  // LineString/Polyline
  if (entityType === 2 || entityType === 6 || entityType === 7) {
    if (isMultiPart) {
      return {
        type: 'MultiLineString',
        coordinates: parts,
        srid: spatialRef.srid,
      };
    }
    return {
      type: 'LineString',
      coordinates: parts[0]!,
      srid: spatialRef.srid,
    };
  }

  // Polygon types (3, 8, 264, and default)
  if (isMultiPart) {
    // Multi-part polygon - each part is an outer ring
    // Note: This treats each part as a separate polygon (MultiPolygon)
    // For polygons with holes, rings would be in the same part array
    return {
      type: 'MultiPolygon',
      coordinates: parts.map(ring => [ring]),
      srid: spatialRef.srid,
    };
  }

  // Single-part polygon
  return {
    type: 'Polygon',
    coordinates: [parts[0]!],
    srid: spatialRef.srid,
  };
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
