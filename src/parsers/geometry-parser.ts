/**
 * Parse SQL Server and PostGIS geometry types
 *
 * Converts WKB (Well-Known Binary) to our internal Geometry format.
 */

import type { Geometry as InternalGeometry, GeometryType } from "../types";
import type { Geometry as GeoJSONGeometry } from "geojson";
import { type Logger, consoleLogger } from "../logger";

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
  const hasZ =
    (geomType & 0x80000000) !== 0 || ((geomType / 1000) | 0) % 2 === 1;
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
      return parseLineString(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
    case 3: // Polygon
      return parsePolygon(wkb, offset, isLittleEndian, coordDims, parsedSrid);
    case 4: // MultiPoint
      return parseMultiPoint(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
    case 5: // MultiLineString
      return parseMultiLineString(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
    case 6: // MultiPolygon
      return parseMultiPolygon(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
    case 7: // GeometryCollection
      return parseGeometryCollection(wkb, offset, isLittleEndian, parsedSrid);
    default:
      parserLogger.warn(`Unsupported geometry type: ${baseType}`);
      return null;
  }
}

function readDouble(
  buf: Buffer,
  offset: number,
  littleEndian: boolean,
): number {
  return littleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
}

function readUInt32(
  buf: Buffer,
  offset: number,
  littleEndian: boolean,
): number {
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function readCoordinate(
  buf: Buffer,
  offset: number,
  littleEndian: boolean,
  dims: number,
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
  srid?: number,
): InternalGeometry {
  const { coord } = readCoordinate(wkb, offset, littleEndian, coordDims);

  return {
    type: "Point",
    coordinates: coord.length === 2 ? coord : coord.slice(0, 2),
    srid,
  };
}

function parseLineString(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
): InternalGeometry {
  const numPoints = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][] = [];
  for (let i = 0; i < numPoints; i++) {
    const { coord, newOffset } = readCoordinate(
      wkb,
      offset,
      littleEndian,
      coordDims,
    );
    coordinates.push(coord.length === 2 ? coord : coord.slice(0, 2));
    offset = newOffset;
  }

  return {
    type: "LineString",
    coordinates,
    srid,
  };
}

function parsePolygon(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
): InternalGeometry {
  const numRings = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][][] = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = readUInt32(wkb, offset, littleEndian);
    offset += 4;

    const ring: number[][] = [];
    for (let i = 0; i < numPoints; i++) {
      const { coord, newOffset } = readCoordinate(
        wkb,
        offset,
        littleEndian,
        coordDims,
      );
      ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
      offset = newOffset;
    }
    coordinates.push(ring);
  }

  return {
    type: "Polygon",
    coordinates,
    srid,
  };
}

function parseMultiPoint(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
): InternalGeometry {
  const numPoints = readUInt32(wkb, offset, littleEndian);
  offset += 4;

  const coordinates: number[][] = [];
  for (let i = 0; i < numPoints; i++) {
    // Skip WKB header for each point (5 bytes: byte order + type)
    offset += 5;
    const { coord, newOffset } = readCoordinate(
      wkb,
      offset,
      littleEndian,
      coordDims,
    );
    coordinates.push(coord.length === 2 ? coord : coord.slice(0, 2));
    offset = newOffset;
  }

  return {
    type: "MultiPoint",
    coordinates,
    srid,
  };
}

function parseMultiLineString(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
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
      const { coord, newOffset } = readCoordinate(
        wkb,
        offset,
        littleEndian,
        coordDims,
      );
      line.push(coord.length === 2 ? coord : coord.slice(0, 2));
      offset = newOffset;
    }
    coordinates.push(line);
  }

  return {
    type: "MultiLineString",
    coordinates,
    srid,
  };
}

function parseMultiPolygon(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
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
        const { coord, newOffset } = readCoordinate(
          wkb,
          offset,
          littleEndian,
          coordDims,
        );
        ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
        offset = newOffset;
      }
      polygon.push(ring);
    }
    coordinates.push(polygon);
  }

  return {
    type: "MultiPolygon",
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
  srid?: number,
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
  const hasZ =
    (geomType & 0x80000000) !== 0 || ((geomType / 1000) | 0) % 2 === 1;
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
    case 1: {
      // Point
      const geometry = parsePoint(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
      return { geometry, newOffset: offset + coordDims * 8 };
    }
    case 2: {
      // LineString
      const numPoints = readUInt32(wkb, offset, isLittleEndian);
      const geometry = parseLineString(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
      return { geometry, newOffset: offset + 4 + numPoints * coordDims * 8 };
    }
    case 3: {
      // Polygon
      const result = parsePolygonWithOffset(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
      return result;
    }
    case 4: {
      // MultiPoint
      const numPoints = readUInt32(wkb, offset, isLittleEndian);
      let newOffset = offset + 4;
      for (let i = 0; i < numPoints; i++) {
        newOffset += 5 + coordDims * 8; // header + point coords
      }
      const geometry = parseMultiPoint(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
      return { geometry, newOffset };
    }
    case 5: {
      // MultiLineString
      const result = parseMultiLineStringWithOffset(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
      return result;
    }
    case 6: {
      // MultiPolygon
      const result = parseMultiPolygonWithOffset(
        wkb,
        offset,
        isLittleEndian,
        coordDims,
        parsedSrid,
      );
      return result;
    }
    case 7: {
      // Nested GeometryCollection
      const result = parseGeometryCollectionWithOffset(
        wkb,
        offset,
        isLittleEndian,
        parsedSrid,
      );
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
  srid?: number,
): { geometry: InternalGeometry; newOffset: number } {
  const numRings = readUInt32(wkb, offset, littleEndian);
  let currentOffset = offset + 4;

  const coordinates: number[][][] = [];
  for (let r = 0; r < numRings; r++) {
    const numPoints = readUInt32(wkb, currentOffset, littleEndian);
    currentOffset += 4;

    const ring: number[][] = [];
    for (let i = 0; i < numPoints; i++) {
      const { coord, newOffset } = readCoordinate(
        wkb,
        currentOffset,
        littleEndian,
        coordDims,
      );
      ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
      currentOffset = newOffset;
    }
    coordinates.push(ring);
  }

  return {
    geometry: { type: "Polygon", coordinates, srid },
    newOffset: currentOffset,
  };
}

function parseMultiLineStringWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
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
      const { coord, newOffset } = readCoordinate(
        wkb,
        currentOffset,
        littleEndian,
        coordDims,
      );
      line.push(coord.length === 2 ? coord : coord.slice(0, 2));
      currentOffset = newOffset;
    }
    coordinates.push(line);
  }

  return {
    geometry: { type: "MultiLineString", coordinates, srid },
    newOffset: currentOffset,
  };
}

function parseMultiPolygonWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  coordDims: number,
  srid?: number,
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
        const { coord, newOffset } = readCoordinate(
          wkb,
          currentOffset,
          littleEndian,
          coordDims,
        );
        ring.push(coord.length === 2 ? coord : coord.slice(0, 2));
        currentOffset = newOffset;
      }
      polygon.push(ring);
    }
    coordinates.push(polygon);
  }

  return {
    geometry: { type: "MultiPolygon", coordinates, srid },
    newOffset: currentOffset,
  };
}

function parseGeometryCollectionWithOffset(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  srid?: number,
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
    geometry: {
      type: "GeometryCollection",
      geometries,
      srid,
    } as InternalGeometry,
    newOffset: currentOffset,
  };
}

function parseGeometryCollection(
  wkb: Buffer,
  offset: number,
  littleEndian: boolean,
  srid?: number,
): InternalGeometry {
  const { geometry } = parseGeometryCollectionWithOffset(
    wkb,
    offset,
    littleEndian,
    srid,
  );
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
function readVarInt(
  buffer: Buffer,
  offset: number,
): { value: bigint; bytesRead: number } {
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
 * Polygon envelope (bounding box) in real-world coordinates.
 *
 * Required for parsing multipart non-curved polygons (used for ring-boundary
 * detection via the envelope test) and for locating the raw shape buffer in
 * curved polygons (verified against the buffer's box at scan time).
 */
export interface ParseEnvelope {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/**
 * A curve segment modifier from the raw Extended Shape Buffer (Esri spec
 * Table 3). Present only on curved polygons. Each modifier replaces the
 * straight chord between source[startPointIndex] and source[startPointIndex+1]
 * with a curved segment.
 */
export interface SegmentModifier {
  startPointIndex: number;
  /** 1 = circular arc, 3 = spiral, 4 = bezier, 5 = elliptic arc */
  segmentType: number;
  /** Arc center (segmentType=1, IsPoint=0) */
  centerX?: number;
  centerY?: number;
  /** Arc start/central angles (segmentType=1, IsPoint=1) */
  startAngle?: number;
  centralAngle?: number;
  /** Arc bit flags (segmentType=1) */
  bits?: number;
  isCCW?: boolean;
  isMinor?: boolean;
  isLine?: boolean;
  isPoint?: boolean;
  /** Bezier interior control points (segmentType=4) */
  controlPoint1?: { x: number; y: number };
  controlPoint2?: { x: number; y: number };
  /** Elliptic arc parameters (segmentType=5) */
  rotation?: number;
  semiMajor?: number;
  minorMajorRatio?: number;
}

/**
 * Result of parsing SDEBINARY - includes metadata about the parse.
 *
 * For curved polygons, `parts` contains the source control points (not
 * densified). The caller can densify the curves in the polygon by walking
 * `curves` and replacing the chord between `source[startPointIndex]` and
 * `source[startPointIndex+1]` with sampled points along the curve.
 */
export interface SdeBinaryParseResult {
  /** Parsed coordinate rings: outer array = parts/rings, inner = [x, y] pairs */
  parts: number[][][];
  /** Whether this geometry contains curves */
  hasCurves: boolean;
  /** Number of parts (rings) parsed */
  partCount: number;
  /** Curve segment modifiers (populated only when hasCurves and source data is from raw shape buffer) */
  curves?: SegmentModifier[];
  /** Whether decoding succeeded */
  success: boolean;
  /** Error message if parsing failed */
  error?: string;
}

/**
 * Detect if SDEBINARY data contains curve geometry.
 *
 * Per Esri's ArcSDE 10.0 SDK docs, the 8-byte header has internal bitmask
 * bytes after the length varint. The "has curves" flag for polygons appears
 * in byte 5 with bit 0x08. Verified across 305 polygon layers in test data.
 */
function sdeDetectCurveGeometry(pointsBuffer: Buffer): boolean {
  return pointsBuffer.length > 5 && (pointsBuffer[5]! & 0x08) !== 0;
}

// =============================================================================
// SDEBINARY decoding — see SDE_CURVE_PARSING_FINDINGS.md for the full format
// derivation. The short version:
//
//   Blob layout:
//     bytes 0..7         8-byte header (length varint + internal bitmask bytes)
//     bytes 8..N         varint coordinate stream (densified polygon)
//     bytes N+1..end     raw Esri Extended Shape Buffer (curved polygons only)
//
//   Varint coordinate stream:
//     - Total varints = 2 × numofpts (no marker varints).
//     - First pair of every ring is sdeDecodeStorage-encoded (absolute).
//     - All other pairs in the ring are sdeDecodeDelta-encoded.
//     - Multipart polygons: each ring starts with another absolute pair.
//     - Tiny rings ("stubs") may appear as 1-entry rings; these are SDE
//       topology artifacts that the shapefile exporter collapses.
//
//   For curved polygons: the densified varint stream is approximate (curves
//   become line segments). The raw shape buffer at the end of the blob
//   contains the source control points + curve modifiers per Esri's spec
//   (docs/extended_shape_buffer_format.pdf). Always prefer the raw buffer
//   for curves.
// =============================================================================

interface RawShape {
  shapeType: number;
  basicType: number;
  hasCurves: boolean;
  hasZs: boolean;
  hasMs: boolean;
  numParts: number;
  numPoints: number;
  parts: number[];
  points: { x: number; y: number }[];
  numCurves: number;
  curves: SegmentModifier[];
}

const ESRI_HAS_CURVES_FLAG = 0x20000000;
const ESRI_HAS_ZS_FLAG = 0x80000000;
const ESRI_HAS_MS_FLAG = 0x40000000;

/**
 * Locate Esri's raw uncompressed Extended Shape Buffer at the end of the
 * SDEBINARY blob (curved polygons only). Returns the byte offset of the
 * shape header, or -1 if not found.
 *
 * Strategy: scan for an offset where the next 4 bytes look like a valid
 * ShapeType (basicType in {50..54}, middle bytes zero), the following 32
 * bytes decode as a sane envelope matching the row's eminx/eminy/emaxx/emaxy,
 * and the integer fields downstream (NumParts, NumPoints) are plausible.
 */
function findRawShapeBuffer(buf: Buffer, env: ParseEnvelope): number {
  for (let off = 0; off + 44 <= buf.length; off++) {
    const shapeType = buf.readUInt32LE(off);
    const basicType = shapeType & 0xff;
    if (basicType < 50 || basicType > 54) continue;
    if ((shapeType & 0x00ffff00) !== 0) continue;

    const xMin = buf.readDoubleLE(off + 4);
    const yMin = buf.readDoubleLE(off + 12);
    const xMax = buf.readDoubleLE(off + 20);
    const yMax = buf.readDoubleLE(off + 28);
    if (
      !Number.isFinite(xMin) ||
      !Number.isFinite(yMin) ||
      !Number.isFinite(xMax) ||
      !Number.isFinite(yMax)
    )
      continue;
    if (xMin > xMax || yMin > yMax) continue;
    if (Math.abs(xMin - env.xMin) > 1) continue;
    if (Math.abs(yMin - env.yMin) > 1) continue;
    if (Math.abs(xMax - env.xMax) > 1) continue;
    if (Math.abs(yMax - env.yMax) > 1) continue;

    const numParts = buf.readInt32LE(off + 36);
    if (numParts < 1 || numParts > 1000) continue;
    const numPoints = buf.readInt32LE(off + 40);
    if (numPoints < 3 || numPoints > 1000000) continue;
    if (off + 44 + 4 * numParts + 16 * numPoints > buf.length) continue;

    return off;
  }
  return -1;
}

/**
 * Parse the raw Esri Extended Shape Buffer at the given offset into the blob.
 * Layout per Esri spec Table 3 (`docs/extended_shape_buffer_format.pdf`).
 */
function parseRawShape(buf: Buffer, startOff: number): RawShape | null {
  let off = startOff;
  if (off + 44 > buf.length) return null;

  const shapeType = buf.readUInt32LE(off);
  off += 4;
  const basicType = shapeType & 0xff;
  const hasCurves =
    (shapeType & ESRI_HAS_CURVES_FLAG) !== 0 ||
    ((basicType === 50 || basicType === 51) && (shapeType & 0xff000000) === 0);
  const hasZs = (shapeType & ESRI_HAS_ZS_FLAG) !== 0;
  const hasMs = (shapeType & ESRI_HAS_MS_FLAG) !== 0;

  // Skip envelope (4 doubles, 32 bytes); already validated by findRawShapeBuffer.
  off += 32;

  const numParts = buf.readInt32LE(off);
  off += 4;
  const numPoints = buf.readInt32LE(off);
  off += 4;

  const parts: number[] = [];
  for (let i = 0; i < numParts; i++) {
    parts.push(buf.readInt32LE(off));
    off += 4;
  }

  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < numPoints; i++) {
    points.push({ x: buf.readDoubleLE(off), y: buf.readDoubleLE(off + 8) });
    off += 16;
  }

  if (hasZs) off += 16 + 8 * numPoints;
  if (hasMs) off += 16 + 8 * numPoints;

  let numCurves = 0;
  const curves: SegmentModifier[] = [];
  if (hasCurves && off + 4 <= buf.length) {
    numCurves = buf.readInt32LE(off);
    off += 4;
    for (let i = 0; i < numCurves; i++) {
      if (off + 8 > buf.length) break;
      const startPointIndex = buf.readInt32LE(off);
      off += 4;
      const segmentType = buf.readInt32LE(off);
      off += 4;
      const mod: SegmentModifier = { startPointIndex, segmentType };

      if (segmentType === 1) {
        // Circular arc: 16 bytes (center or angles) + 4 bytes Bits
        if (off + 20 > buf.length) break;
        const f0 = buf.readDoubleLE(off);
        const f1 = buf.readDoubleLE(off + 8);
        const bits = buf.readInt32LE(off + 16);
        off += 20;
        mod.bits = bits;
        mod.isCCW = (bits & 0x08) !== 0;
        mod.isMinor = (bits & 0x10) !== 0;
        mod.isLine = (bits & 0x20) !== 0;
        mod.isPoint = (bits & 0x40) !== 0;
        if (mod.isPoint) {
          mod.startAngle = f0;
          mod.centralAngle = f1;
        } else {
          mod.centerX = f0;
          mod.centerY = f1;
        }
      } else if (segmentType === 4) {
        // Bezier: 32 bytes (2 control points)
        if (off + 32 > buf.length) break;
        mod.controlPoint1 = {
          x: buf.readDoubleLE(off),
          y: buf.readDoubleLE(off + 8),
        };
        mod.controlPoint2 = {
          x: buf.readDoubleLE(off + 16),
          y: buf.readDoubleLE(off + 24),
        };
        off += 32;
      } else if (segmentType === 5) {
        // Elliptic arc: 44 bytes (center + rotation + semiMajor + ratio + bits)
        if (off + 44 > buf.length) break;
        mod.centerX = buf.readDoubleLE(off);
        mod.centerY = buf.readDoubleLE(off + 8);
        mod.rotation = buf.readDoubleLE(off + 16);
        mod.semiMajor = buf.readDoubleLE(off + 24);
        mod.minorMajorRatio = buf.readDoubleLE(off + 32);
        mod.bits = buf.readInt32LE(off + 40);
        off += 44;
      } else {
        // Spiral (3) or unknown — abort; we don't have a layout for these.
        break;
      }

      curves.push(mod);
    }
  }

  return {
    shapeType,
    basicType,
    hasCurves,
    hasZs,
    hasMs,
    numParts,
    numPoints,
    parts,
    points,
    numCurves,
    curves,
  };
}

/**
 * Read all varints from the blob's coordinate stream (after the 8-byte header)
 * up to a maximum count.
 */
function readVarints(
  buf: Buffer,
  maxVarints: number,
): { value: bigint; bytesRead: number; byteOffset: number }[] {
  const out: { value: bigint; bytesRead: number; byteOffset: number }[] = [];
  let off = 8;
  while (off < buf.length && out.length < maxVarints) {
    const byteOffset = off;
    const v = readVarInt(buf, off);
    if (v.bytesRead === 0) break;
    out.push({ value: v.value, bytesRead: v.bytesRead, byteOffset });
    off += v.bytesRead;
  }
  return out;
}

/**
 * Decode the varint coordinate stream of a non-curved polygon.
 *
 * Single-ring (entity & 0x100 == 0): every pair after the first is a delta.
 * Multipart (entity & 0x100 != 0): each ring starts with an absolute pair,
 * detected via the envelope test (storage interpretation falls inside the
 * polygon's envelope iff this is a ring start).
 */
function decodeVarintStream(
  buf: Buffer,
  numofpts: number,
  isMultipart: boolean,
  envelope: ParseEnvelope,
  spatialRef: SpatialReferenceParams,
): number[][][] {
  const { falsex, falsey, xyunits } = spatialRef;
  const varints = readVarints(buf, 2 * numofpts);
  if (varints.length < 2) return [];

  const rings: number[][][] = [];
  let cx = 0n,
    cy = 0n;
  let currentRing: number[][] = [];
  let consumed = 0;

  for (let i = 0; i + 1 < varints.length && consumed < numofpts; i += 2) {
    const xv = varints[i]!;
    const yv = varints[i + 1]!;

    let isAbsolute = consumed === 0;
    if (isMultipart && !isAbsolute) {
      // Try the storage interpretation; if it lands inside the polygon's
      // envelope, this is a ring start. If not, it's a delta.
      const sx = sdeDecodeStorage(xv.value);
      const sy = sdeDecodeStorage(yv.value);
      const realX = Number(sx) / xyunits + falsex;
      const realY = Number(sy) / xyunits + falsey;
      isAbsolute =
        realX >= envelope.xMin - 0.01 &&
        realX <= envelope.xMax + 0.01 &&
        realY >= envelope.yMin - 0.01 &&
        realY <= envelope.yMax + 0.01;
    }

    if (isAbsolute) {
      if (currentRing.length > 0) rings.push(currentRing);
      cx = sdeDecodeStorage(xv.value);
      cy = sdeDecodeStorage(yv.value);
      currentRing = [
        [Number(cx) / xyunits + falsex, Number(cy) / xyunits + falsey],
      ];
    } else {
      cx += sdeDecodeDelta(xv.value);
      cy += sdeDecodeDelta(yv.value);
      currentRing.push([
        Number(cx) / xyunits + falsex,
        Number(cy) / xyunits + falsey,
      ]);
    }
    consumed++;
  }
  if (currentRing.length > 0) rings.push(currentRing);

  return rings;
}

/**
 * Drop "stub" rings: 1-entry rings produced by the SDE varint encoder for
 * tiny degenerate features. These collapse out in the shapefile exporter and
 * carry no meaningful geometry. Callers that want every entry SDE wrote can
 * skip this filter.
 */
function dropStubRings(rings: number[][][]): number[][][] {
  return rings.filter((r) => r.length >= 3);
}

/**
 * Convert a parsed raw shape buffer into the SdeBinaryParseResult shape:
 * one inner array per Parts[] entry, each containing the source control
 * points (not densified) for that ring.
 */
function rawShapeToParts(shape: RawShape): number[][][] {
  const parts: number[][][] = [];
  for (let p = 0; p < shape.numParts; p++) {
    const start = shape.parts[p]!;
    const end = p + 1 < shape.numParts ? shape.parts[p + 1]! : shape.numPoints;
    const ring: number[][] = [];
    for (let i = start; i < end; i++) {
      const pt = shape.points[i]!;
      ring.push([pt.x, pt.y]);
    }
    parts.push(ring);
  }
  return parts;
}

/**
 * Parse SDEBINARY compressed geometry from f-table points column.
 *
 * Returns the first ring as `[x, y]` pairs (legacy compat). Use
 * `parseSdeBinaryMultiPart` for full multipart support.
 *
 * @param pointsBuffer - The points BLOB
 * @param numPoints - The numofpts column value
 * @param spatialRef - Spatial reference (falsex, falsey, xyunits)
 * @param envelope - Polygon envelope from the row (eminx/eminy/emaxx/emaxy).
 *                   Required for multipart and curved polygons; may be omitted
 *                   for single-ring non-curved polygons.
 */
export function parseSdeBinaryPoints(
  pointsBuffer: Buffer,
  numPoints: number,
  spatialRef: SpatialReferenceParams,
  envelope?: ParseEnvelope,
): number[][] {
  const result = parseSdeBinaryMultiPart(
    pointsBuffer,
    numPoints,
    spatialRef,
    envelope,
  );
  return result.parts.length > 0 ? result.parts[0]! : [];
}

/**
 * Parse SDEBINARY with full support for multipart polygons and curved geometry.
 *
 * For curved polygons, returns the source control points (not densified) plus
 * the parsed curve modifiers in `result.curves`. Densify externally if needed.
 *
 * @param pointsBuffer - The points BLOB
 * @param numPoints - The numofpts column value
 * @param spatialRef - Spatial reference (falsex, falsey, xyunits)
 * @param envelope - Polygon envelope. Required when the blob contains
 *                   curves OR when entity has the multipart bit (0x100). For
 *                   simple single-ring polygons the envelope is unused but
 *                   accepting it uniformly keeps the call site simple.
 * @param entity - Optional entity column value. If provided, used to detect
 *                 multipart (entity & 0x100). If omitted, we assume single-ring
 *                 (which is correct for >99% of polygons in typical layers).
 */
export function parseSdeBinaryMultiPart(
  pointsBuffer: Buffer,
  numPoints: number,
  spatialRef: SpatialReferenceParams,
  envelope?: ParseEnvelope,
  entity?: number,
): SdeBinaryParseResult {
  if (pointsBuffer.length < 8 || numPoints < 1) {
    return {
      parts: [],
      hasCurves: false,
      partCount: 0,
      success: false,
      error: "Insufficient buffer or zero points",
    };
  }

  const hasCurves = sdeDetectCurveGeometry(pointsBuffer);

  // Curved polygons: parse the raw shape buffer at the end of the blob.
  // The varint stream is the densified approximation; the raw buffer holds
  // the source control points + curve modifiers per Esri's spec.
  if (hasCurves) {
    if (!envelope) {
      return {
        parts: [],
        hasCurves: true,
        partCount: 0,
        success: false,
        error: "Curved polygon requires envelope to locate raw shape buffer",
      };
    }
    const rawOff = findRawShapeBuffer(pointsBuffer, envelope);
    if (rawOff < 0) {
      return {
        parts: [],
        hasCurves: true,
        partCount: 0,
        success: false,
        error: "Curves flag set but raw shape buffer not located",
      };
    }
    const shape = parseRawShape(pointsBuffer, rawOff);
    if (!shape) {
      return {
        parts: [],
        hasCurves: true,
        partCount: 0,
        success: false,
        error: "Failed to parse raw shape buffer",
      };
    }
    return {
      parts: rawShapeToParts(shape),
      hasCurves: true,
      partCount: shape.numParts,
      curves: shape.curves,
      success: true,
    };
  }

  // Non-curved: decode the varint coordinate stream directly.
  const isMultipart = (entity ?? 0) & 0x100 ? true : false;
  const env: ParseEnvelope = envelope ?? {
    xMin: -Infinity,
    yMin: -Infinity,
    xMax: Infinity,
    yMax: Infinity,
  };
  const allRings = decodeVarintStream(
    pointsBuffer,
    numPoints,
    isMultipart,
    env,
    spatialRef,
  );
  const rings = isMultipart ? dropStubRings(allRings) : allRings;

  return {
    parts: rings,
    hasCurves: false,
    partCount: rings.length,
    success: rings.length > 0,
  };
}

/**
 * Parse SDEBINARY geometry to our internal Geometry format.
 *
 * Entity types in ArcSDE (observed):
 *   1   = Point
 *   2   = LineString
 *   3   = Polygon (simple)
 *   6,7 = LineString variants
 *   8   = Polygon (may contain curves; curves bit is in BLOB byte 5, not entity)
 *   264 = Multipart Polygon (= 8 | 0x100, where 0x100 is the multipart bit)
 *
 * KNOWN LIMITATIONS:
 * - Inner-ring (hole) detection is not implemented. Multipart polygons return
 *   as MultiPolygon (each part = a separate outer ring). For polygons with
 *   holes, callers must run their own ring-orientation analysis on the
 *   returned parts.
 * - Z and M coordinates are not handled; output is always 2D.
 * - Curved polygons return source control points (not densified). Use the
 *   `curves` field on `parseSdeBinaryMultiPart`'s result to densify externally.
 *
 * @param pointsBuffer - Points BLOB from the f-table
 * @param numPoints    - numofpts column value
 * @param entityType   - entity column value
 * @param spatialRef   - falsex/falsey/xyunits
 * @param envelope     - eminx/eminy/emaxx/emaxy from the row. Required for
 *                       multipart and curved polygons.
 */
export function parseSdeBinary(
  pointsBuffer: Buffer,
  numPoints: number,
  entityType: number,
  spatialRef: SpatialReferenceParams,
  envelope?: ParseEnvelope,
): InternalGeometry | null {
  const result = parseSdeBinaryMultiPart(
    pointsBuffer,
    numPoints,
    spatialRef,
    envelope,
    entityType,
  );
  if (!result.success) {
    if (result.error) parserLogger.warn(`SDEBINARY: ${result.error}`);
    return null;
  }

  const { parts } = result;
  if (parts.length === 0) return null;

  const isMultiPart = parts.length > 1 || (entityType & 0x100) !== 0;

  if (entityType === 1) {
    const firstPart = parts[0]!;
    if (firstPart.length === 0) return null;
    return { type: "Point", coordinates: firstPart[0]!, srid: spatialRef.srid };
  }

  if (entityType === 2 || entityType === 6 || entityType === 7) {
    if (isMultiPart) {
      return {
        type: "MultiLineString",
        coordinates: parts,
        srid: spatialRef.srid,
      };
    }
    return {
      type: "LineString",
      coordinates: parts[0]!,
      srid: spatialRef.srid,
    };
  }

  if (isMultiPart) {
    return {
      type: "MultiPolygon",
      coordinates: parts.map((ring) => [ring]),
      srid: spatialRef.srid,
    };
  }

  return { type: "Polygon", coordinates: [parts[0]!], srid: spatialRef.srid };
}

// =============================================================================
// Curve densification — turn SegmentModifier records into sampled line segments
//
// `parseSdeBinaryMultiPart` returns the source control points (un-densified)
// and the curve modifier records. To get GeoJSON-compatible polygons with
// curves rendered as polylines, walk through the source points and replace
// each chord that has an associated curve modifier with sampled points along
// the curve. This is what `densifyCurves` does.
// =============================================================================

const TWO_PI = 2 * Math.PI;

/**
 * Sample points along a circular arc.
 *
 * Returns `segments + 1` points: start, intermediate samples, end.
 *
 * The arc goes from `start` to `end` around `(centerX, centerY)`. `isCCW`
 * picks which of the two possible arcs to use (the counterclockwise or
 * clockwise one). The IsMinor flag is redundant given start, end, center,
 * and isCCW — we don't need it for densification.
 */
export function densifyArc(
  start: readonly [number, number],
  end: readonly [number, number],
  centerX: number,
  centerY: number,
  isCCW: boolean,
  segments = 32,
): number[][] {
  const startAngle = Math.atan2(start[1] - centerY, start[0] - centerX);
  const endAngle = Math.atan2(end[1] - centerY, end[0] - centerX);

  let sweep = endAngle - startAngle;
  if (isCCW) {
    // Counterclockwise: sweep is positive. If the raw difference is negative
    // or zero, we need to wrap the long way around.
    if (sweep <= 0) sweep += TWO_PI;
  } else {
    // Clockwise: sweep is negative. If the raw difference is positive or zero,
    // wrap the long way the other direction.
    if (sweep >= 0) sweep -= TWO_PI;
  }

  // Use the average of |start - center| and |end - center| as the radius.
  // For a well-formed arc these are equal; averaging makes us robust to tiny
  // numerical noise.
  const r0 = Math.hypot(start[0] - centerX, start[1] - centerY);
  const r1 = Math.hypot(end[0] - centerX, end[1] - centerY);
  const radius = (r0 + r1) / 2;

  const out: number[][] = [[start[0], start[1]]];
  for (let i = 1; i < segments; i++) {
    const angle = startAngle + (sweep * i) / segments;
    out.push([centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]);
  }
  out.push([end[0], end[1]]);
  return out;
}

/**
 * Sample points along a cubic Bezier curve from `start` to `end` with two
 * interior control points. Returns `segments + 1` points.
 */
export function densifyBezier(
  start: readonly [number, number],
  control1: readonly [number, number],
  control2: readonly [number, number],
  end: readonly [number, number],
  segments = 32,
): number[][] {
  const out: number[][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;
    out.push([
      w0 * start[0] + w1 * control1[0] + w2 * control2[0] + w3 * end[0],
      w0 * start[1] + w1 * control1[1] + w2 * control2[1] + w3 * end[1],
    ]);
  }
  return out;
}

export interface DensifyOptions {
  /** Segments to sample per curve (default 32) */
  segmentsPerCurve?: number;
}

/**
 * Densify a parsed curved polygon. Walks the source control points across
 * all rings, and wherever a curve modifier attaches, replaces the chord
 * with sampled curve points.
 *
 * `parts` is the per-ring source points returned by `parseSdeBinaryMultiPart`
 * (when `hasCurves` is true). `curves` is the corresponding `result.curves`.
 *
 * Curve modifiers' `startPointIndex` is a global index into the concatenated
 * point sequence across all rings (per Esri spec). This function reconstructs
 * the (ring, local-index) mapping from the parts shape.
 *
 * Currently supports segmentType 1 (Arc) and 4 (Bezier). Other segment types
 * (3 = Spiral, 5 = EllipticArc) fall through to the chord (no densification).
 * Modifiers with `isLine` set are also left as straight chords per Esri spec.
 */
export function densifyCurves(
  parts: number[][][],
  curves: readonly SegmentModifier[],
  options: DensifyOptions = {},
): number[][][] {
  const segmentsPerCurve = options.segmentsPerCurve ?? 32;
  if (curves.length === 0) return parts.map((r) => r.map((p) => [...p]));

  // Map global point index → SegmentModifier (the curve attached at that point).
  const curveAt = new Map<number, SegmentModifier>();
  for (const c of curves) curveAt.set(c.startPointIndex, c);

  // Build per-ring start offsets so we can translate between global and local indices.
  const ringStarts: number[] = [];
  let total = 0;
  for (const ring of parts) {
    ringStarts.push(total);
    total += ring.length;
  }

  const result: number[][][] = [];
  for (let r = 0; r < parts.length; r++) {
    const ring = parts[r]!;
    const ringStart = ringStarts[r]!;
    const newRing: number[][] = [];

    for (let i = 0; i < ring.length; i++) {
      const point = ring[i]!;
      const globalIdx = ringStart + i;
      const curve = curveAt.get(globalIdx);
      const next = i + 1 < ring.length ? ring[i + 1]! : undefined;

      // Always emit the current point.
      newRing.push([point[0]!, point[1]!]);

      if (!curve || !next) continue;
      if (curve.isLine) continue;

      let densified: number[][] | undefined;
      if (
        curve.segmentType === 1 &&
        curve.centerX !== undefined &&
        curve.centerY !== undefined &&
        !curve.isPoint
      ) {
        densified = densifyArc(
          [point[0]!, point[1]!],
          [next[0]!, next[1]!],
          curve.centerX,
          curve.centerY,
          curve.isCCW ?? false,
          segmentsPerCurve,
        );
      } else if (curve.segmentType === 4 && curve.controlPoint1 && curve.controlPoint2) {
        densified = densifyBezier(
          [point[0]!, point[1]!],
          [curve.controlPoint1.x, curve.controlPoint1.y],
          [curve.controlPoint2.x, curve.controlPoint2.y],
          [next[0]!, next[1]!],
          segmentsPerCurve,
        );
      }

      if (densified) {
        // densified[0] === point (already pushed), densified[last] === next
        // (will be pushed by the next loop iteration). Add the interior samples.
        for (let j = 1; j < densified.length - 1; j++) {
          newRing.push([densified[j]![0]!, densified[j]![1]!]);
        }
      }
    }

    result.push(newRing);
  }
  return result;
}

/**
 * Convert Geometry to GeoJSON format
 */
export function geometryToGeoJSON(geometry: InternalGeometry): GeoJSONGeometry {
  // Handle GeometryCollection separately since it uses 'geometries' not 'coordinates'
  if (geometry.type === "GeometryCollection") {
    const geomCollection = geometry as {
      type: "GeometryCollection";
      geometries: InternalGeometry[];
    };
    return {
      type: "GeometryCollection",
      geometries: geomCollection.geometries.map((g) => geometryToGeoJSON(g)),
    } as unknown as GeoJSONGeometry;
  }

  // GeoJSON Geometry is a union type, so we cast through unknown
  return {
    type: geometry.type,
    coordinates: (geometry as { coordinates: unknown }).coordinates,
  } as unknown as GeoJSONGeometry;
}
