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
  /**
   * Third arc point (segmentType=1, IsPoint=0). In modern Esri SDE
   * encoding (10.x+) this is a point lying ON the arc — typically the arc
   * midpoint — not the geometric circle center. Together with the chord
   * endpoints (source[startPointIndex] and source[startPointIndex+1]),
   * three points uniquely define the arc; the true circumcenter and sweep
   * direction are derived from them. The legacy field name "center" is
   * preserved for backward compatibility.
   */
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
// Curve densification — turn SegmentModifier records into sampled line segments.
//
// We use tolerance-based adaptive sampling, matching the approach Esri uses
// for `Densify` and `arcpy.management.Densify`. The caller specifies a maximum
// perpendicular deviation from the true curve (the "sagitta" tolerance), and
// the densifier picks a per-curve segment count that respects it.
//
// For circular arcs of radius r, the per-segment chord-to-arc deviation as a
// function of the per-segment central angle θ is:
//
//     sagitta(θ) = r * (1 − cos(θ/2))
//
// So for a target tolerance T:
//
//     θ_max = 2 * arccos(1 − T/r)        // when 0 < T < 2r
//     N     = ceil(|sweep| / θ_max)       // segments needed for the full arc
//
// We additionally clamp by `maxAngle` (so very large radii don't produce
// over-long chords), `minSegments` (visual smoothness on small features), and
// `maxSegments` (safety cap).
//
// For cubic Beziers, exact tolerance is harder. We use adaptive subdivision
// (recursive de Casteljau) until the control polygon is "flat enough" against
// the chord (max signed area / max perpendicular distance < tolerance), which
// is the standard high-quality approach used by font rasterizers and
// vector-graphics libraries.
// =============================================================================

const TWO_PI = 2 * Math.PI;

/**
 * Options for curve densification.
 *
 * The defaults are tuned for sub-foot-precision data (FL state plane, UTM,
 * etc.). For latitude/longitude data, set `tolerance` to a small value in
 * degrees (e.g. 1e-6).
 */
export interface DensifyOptions {
  /**
   * Maximum perpendicular distance from any chord to the true curve, in the
   * data's coordinate units. Smaller values yield more points. Default 0.01.
   */
  tolerance?: number;
  /**
   * Maximum angular step per arc segment, in radians. Caps chord length on
   * very-large-radius arcs where tolerance alone permits long chords.
   * Default π/16 (≈11.25°).
   */
  maxAngle?: number;
  /** Minimum samples per curve (default 4). */
  minSegments?: number;
  /** Maximum samples per curve, safety cap (default 256). */
  maxSegments?: number;
  /**
   * Override: when set, sample exactly this many segments per curve and
   * ignore tolerance / maxAngle. Useful for uniform sampling in tests.
   */
  segmentsPerCurve?: number;
}

interface ResolvedOptions {
  tolerance: number;
  maxAngle: number;
  minSegments: number;
  maxSegments: number;
  segmentsPerCurve?: number;
}

function resolveOptions(opts: DensifyOptions): ResolvedOptions {
  return {
    tolerance: opts.tolerance ?? 0.01,
    maxAngle: opts.maxAngle ?? Math.PI / 16,
    minSegments: opts.minSegments ?? 4,
    maxSegments: opts.maxSegments ?? 256,
    segmentsPerCurve: opts.segmentsPerCurve,
  };
}

/**
 * Compute the signed sweep angle for an arc going from `startAngle` to
 * `endAngle` in the specified direction. Returns a positive value for CCW,
 * negative for CW.
 */
function arcSweepAngle(startAngle: number, endAngle: number, isCCW: boolean): number {
  let sweep = endAngle - startAngle;
  if (isCCW) {
    if (sweep <= 0) sweep += TWO_PI;
  } else {
    if (sweep >= 0) sweep -= TWO_PI;
  }
  return sweep;
}

/**
 * Sagitta-based segment count for a circular arc with the given sweep and
 * radius, respecting the resolved tolerance options.
 */
function arcSegmentCount(absSweep: number, radius: number, opts: ResolvedOptions): number {
  if (opts.segmentsPerCurve !== undefined) {
    return Math.max(1, opts.segmentsPerCurve);
  }
  // Per-segment angle bound from sagitta tolerance.
  // Sagitta s = r * (1 − cos(θ/2)); solve for θ.
  let segAngle: number;
  if (radius <= 0) {
    segAngle = opts.maxAngle;
  } else {
    const ratio = opts.tolerance / radius;
    if (ratio >= 2) {
      // Tolerance dominates; one segment suffices for any sweep.
      segAngle = opts.maxAngle;
    } else if (ratio <= 0) {
      segAngle = opts.maxAngle;
    } else {
      const tolAngle = 2 * Math.acos(1 - ratio);
      segAngle = Math.min(tolAngle, opts.maxAngle);
    }
  }
  if (!Number.isFinite(segAngle) || segAngle <= 0) segAngle = opts.maxAngle;
  let n = Math.ceil(absSweep / segAngle);
  if (n < opts.minSegments) n = opts.minSegments;
  if (n > opts.maxSegments) n = opts.maxSegments;
  if (n < 1) n = 1;
  return n;
}

/**
 * Compute the circumcenter of the unique circle through three points.
 * Returns null if the points are collinear (no finite circle).
 */
function circumcenterFromThreePoints(
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
): { x: number; y: number } | null {
  const ax = p2[0] - p1[0];
  const ay = p2[1] - p1[1];
  const bx = p3[0] - p1[0];
  const by = p3[1] - p1[1];
  const d = 2 * (ax * by - ay * bx);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const cx = p1[0] + (by * a2 - ay * b2) / d;
  const cy = p1[1] + (ax * b2 - bx * a2) / d;
  return { x: cx, y: cy };
}

/**
 * Sample points along a circular arc.
 *
 * Returns `segments + 1` points: start, interior samples, end. By default
 * `segments` is computed adaptively from the tolerance options. Pass a number
 * to use a fixed segment count instead.
 *
 * `isCCW` picks which of the two possible arcs to use. The Esri `IsMinor`
 * flag is redundant given start, end, center, and `isCCW`.
 */
export function densifyArc(
  start: readonly [number, number],
  end: readonly [number, number],
  centerX: number,
  centerY: number,
  isCCW: boolean,
  optionsOrSegments?: DensifyOptions | number,
): number[][] {
  const opts: ResolvedOptions =
    typeof optionsOrSegments === "number"
      ? resolveOptions({ segmentsPerCurve: optionsOrSegments })
      : resolveOptions(optionsOrSegments ?? {});

  const startAngle = Math.atan2(start[1] - centerY, start[0] - centerX);
  const endAngle = Math.atan2(end[1] - centerY, end[0] - centerX);
  const sweep = arcSweepAngle(startAngle, endAngle, isCCW);

  // Average of the two start/end radii; equal for well-formed arcs, robust to
  // tiny numerical noise.
  const r0 = Math.hypot(start[0] - centerX, start[1] - centerY);
  const r1 = Math.hypot(end[0] - centerX, end[1] - centerY);
  const radius = (r0 + r1) / 2;

  const segments = arcSegmentCount(Math.abs(sweep), radius, opts);

  const out: number[][] = [[start[0], start[1]]];
  for (let i = 1; i < segments; i++) {
    const angle = startAngle + (sweep * i) / segments;
    out.push([centerX + radius * Math.cos(angle), centerY + radius * Math.sin(angle)]);
  }
  out.push([end[0], end[1]]);
  return out;
}

/**
 * Maximum perpendicular distance from a cubic Bezier's control polygon to
 * its chord. Used as a "flatness" metric for adaptive subdivision: a Bezier
 * is "flat enough" when both interior control points lie within `tolerance`
 * of the chord, since the curve itself is bounded by the convex hull of its
 * control points.
 */
function bezierFlatness(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
): number {
  const ux = 3 * p1[0] - 2 * p0[0] - p3[0];
  const uy = 3 * p1[1] - 2 * p0[1] - p3[1];
  const vx = 3 * p2[0] - p0[0] - 2 * p3[0];
  const vy = 3 * p2[1] - p0[1] - 2 * p3[1];
  return Math.max(ux * ux + uy * uy, vx * vx + vy * vy);
}

/**
 * Subdivide a cubic Bezier at t=0.5 using de Casteljau's algorithm.
 */
function bezierSubdivide(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
): {
  left: [[number, number], [number, number], [number, number], [number, number]];
  right: [[number, number], [number, number], [number, number], [number, number]];
} {
  const m01: [number, number] = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const m12: [number, number] = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
  const m23: [number, number] = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
  const m012: [number, number] = [(m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2];
  const m123: [number, number] = [(m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2];
  const m0123: [number, number] = [(m012[0] + m123[0]) / 2, (m012[1] + m123[1]) / 2];
  return {
    left: [[p0[0], p0[1]], m01, m012, m0123],
    right: [m0123, m123, m23, [p3[0], p3[1]]],
  };
}

/**
 * Sample points along a cubic Bezier curve.
 *
 * By default uses adaptive de Casteljau subdivision until each segment of
 * the control polygon is flat to within `tolerance`. Pass a number to use
 * uniform sampling at that fixed segment count instead.
 *
 * Returns at least `segments + 1` points (or `minSegments + 1` for adaptive
 * mode). The control points may be co-linear; in that case the function
 * still returns at least `minSegments + 1` evenly spaced points so callers
 * always get a polyline they can render.
 */
export function densifyBezier(
  start: readonly [number, number],
  control1: readonly [number, number],
  control2: readonly [number, number],
  end: readonly [number, number],
  optionsOrSegments?: DensifyOptions | number,
): number[][] {
  const opts: ResolvedOptions =
    typeof optionsOrSegments === "number"
      ? resolveOptions({ segmentsPerCurve: optionsOrSegments })
      : resolveOptions(optionsOrSegments ?? {});

  if (opts.segmentsPerCurve !== undefined) {
    const n = Math.max(1, opts.segmentsPerCurve);
    const out: number[][] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
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

  // Adaptive subdivision. We collect points by recursing depth-first; each
  // leaf segment contributes its end point. We start with the start point
  // outside the recursion.
  const out: number[][] = [[start[0], start[1]]];
  const tolSq = opts.tolerance * opts.tolerance;
  // Stack-based to avoid recursion limits on pathological inputs.
  type Frame = { p0: [number, number]; p1: [number, number]; p2: [number, number]; p3: [number, number]; depth: number };
  const stack: Frame[] = [
    {
      p0: [start[0], start[1]],
      p1: [control1[0], control1[1]],
      p2: [control2[0], control2[1]],
      p3: [end[0], end[1]],
      depth: 0,
    },
  ];
  // Pre-order traversal collects points in left-to-right order: process the
  // current frame's left subtree, then push the right subtree.
  const right: Frame[] = [];
  let leafCount = 0;
  const maxDepth = Math.ceil(Math.log2(opts.maxSegments)) + 1;
  while (stack.length > 0 || right.length > 0) {
    const top = stack.pop() ?? right.pop()!;
    if (top.depth >= maxDepth || bezierFlatness(top.p0, top.p1, top.p2, top.p3) <= tolSq) {
      out.push([top.p3[0], top.p3[1]]);
      leafCount++;
      continue;
    }
    const { left, right: rightHalf } = bezierSubdivide(top.p0, top.p1, top.p2, top.p3);
    // Push right first so left is processed first.
    stack.push({
      p0: rightHalf[0],
      p1: rightHalf[1],
      p2: rightHalf[2],
      p3: rightHalf[3],
      depth: top.depth + 1,
    });
    stack.push({
      p0: left[0],
      p1: left[1],
      p2: left[2],
      p3: left[3],
      depth: top.depth + 1,
    });
  }

  // If adaptive sampling produced fewer than minSegments points, fall back to
  // uniform sampling at minSegments to ensure consumers see a smooth polyline.
  if (leafCount < opts.minSegments) {
    return densifyBezier(start, control1, control2, end, opts.minSegments);
  }

  return out;
}

/**
 * Densify a parsed curved polygon. Walks the source control points across
 * all rings, and wherever a curve modifier attaches, replaces the chord with
 * sampled curve points using tolerance-based adaptive sampling.
 *
 * `parts` is the per-ring source points returned by `parseSdeBinaryMultiPart`
 * (when `hasCurves` is true). `curves` is `result.curves` from the same call.
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
  const opts = resolveOptions(options);
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
        // Modern Esri SDE encoding (10.x+) stores circular arcs as three
        // points: start, end, and a third point ON the arc (the "arc
        // midpoint"). The two doubles in the segment modifier are this third
        // point — NOT the geometric center. We compute the true circumcenter
        // from the three points. With three points specified, isCCW and
        // isMinor are redundant: the arc through the midpoint is uniquely
        // defined.
        const center = circumcenterFromThreePoints(
          [point[0]!, point[1]!],
          [curve.centerX, curve.centerY],
          [next[0]!, next[1]!],
        );
        if (center) {
          // CCW direction follows the orientation of (start → midpoint →
          // end): a positive cross product means the three points wind CCW
          // around the circumcenter, so the arc through the midpoint travels
          // CCW from start to end.
          const cross =
            (curve.centerX - point[0]!) * (next[1]! - point[1]!) -
            (curve.centerY - point[1]!) * (next[0]! - point[0]!);
          const isCCW = cross > 0;
          densified = densifyArc(
            [point[0]!, point[1]!],
            [next[0]!, next[1]!],
            center.x,
            center.y,
            isCCW,
            opts,
          );
        } else {
          // Three points are collinear: fall through, leaving the chord.
        }
      } else if (curve.segmentType === 4 && curve.controlPoint1 && curve.controlPoint2) {
        densified = densifyBezier(
          [point[0]!, point[1]!],
          [curve.controlPoint1.x, curve.controlPoint1.y],
          [curve.controlPoint2.x, curve.controlPoint2.y],
          [next[0]!, next[1]!],
          opts,
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
