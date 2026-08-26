/**
 * Geometry writer - Convert GeoJSON to WKT/WKB for database insertion
 */

import type { Geometry, GeometryType, CoordinateGeometry, GeometryCollectionType, CompoundCurveType, CurvePolygonType, CurveSegment } from '../types';
import { consoleLogger, type Logger } from '../logger';

// Process-wide, mirroring setParserLogger in geometry-parser.ts (last-wins if
// two connections configure different loggers).
let writerLogger: Logger = consoleLogger;

export function setWriterLogger(logger: Logger): void {
  writerLogger = logger;
}

/**
 * The same decision every write site makes -- but it says something when the
 * answer is no.
 *
 * When a geometry fails `isValidGeometry`, the write sites omit the SHAPE
 * column and the insert/update still succeeds, so the feature quietly ends up
 * with no geometry. That silence hid a live bug for seven weeks. Call sites use
 * this instead of `isValidGeometry` so an unwritable geometry at least leaves a
 * trace.
 *
 * Deliberately still returns a boolean rather than throwing: several callers
 * pass geometry that is legitimately dropped (degenerate T-junction lines,
 * collapsed hole rings), and turning those into exceptions is a separate
 * decision that needs its own measurement first.
 */
export function isWritableGeometry(geometry: Geometry, context: string): boolean {
  if (isValidGeometry(geometry)) return true;
  const type = (geometry as { type?: string } | null | undefined)?.type ?? 'unknown';
  writerLogger.warn(
    `[egdb] ${context}: geometry of type "${type}" is not writable; ` +
    'the SHAPE column will be omitted and the feature will have no geometry',
  );
  return false;
}

/**
 * Convert a GeoJSON-style geometry to WKT (Well-Known Text)
 * WKT is easier to work with than WKB and SQL Server/PostgreSQL can parse it natively
 */
// WKT type keyword per geometry type, used to write empty geometries as
// "<TYPE> EMPTY".
const WKT_TYPE_NAME: Record<string, string> = {
  Point: 'POINT',
  MultiPoint: 'MULTIPOINT',
  LineString: 'LINESTRING',
  MultiLineString: 'MULTILINESTRING',
  Polygon: 'POLYGON',
  MultiPolygon: 'MULTIPOLYGON',
  CircularString: 'CIRCULARSTRING',
  CompoundCurve: 'COMPOUNDCURVE',
  CurvePolygon: 'CURVEPOLYGON',
};

// ---------------------------------------------------------------------------
// Curve geometry (CircularString / CompoundCurve / CurvePolygon)
//
// Syntax rules below are not guesses -- each was checked against SQL Server:
//   * inside COMPOUNDCURVE a straight run is a BARE parenthesised point list.
//     "COMPOUNDCURVE (CIRCULARSTRING (...), LINESTRING (...))" is REJECTED;
//     "COMPOUNDCURVE (CIRCULARSTRING (...), (10 0, 0 0))" is accepted.
//   * CIRCULARSTRING needs an ODD number of points, at least 3 (each arc is
//     start / through / end, sharing endpoints). A 4-point one is rejected.
//   * STGeomFromText rejects an unclosed CURVEPOLYGON ring and a
//     non-contiguous COMPOUNDCURVE, but SILENTLY accepts collinear arcs and
//     duplicate points -- so those are checked here.
// ---------------------------------------------------------------------------

function isPositionList(v: unknown, min: number): v is [number, number][] {
  return (
    Array.isArray(v) &&
    v.length >= min &&
    v.every(
      p => Array.isArray(p) && p.length >= 2 &&
           typeof p[0] === 'number' && typeof p[1] === 'number' &&
           Number.isFinite(p[0]) && Number.isFinite(p[1]),
    )
  );
}

function samePoint(a: [number, number], b: [number, number]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

export function isValidCircularString(g: unknown): boolean {
  const c = (g as { coordinates?: unknown })?.coordinates;
  if (!isPositionList(c, 3)) return false;
  if (c.length % 2 === 0) return false;           // must be odd
  // Every arc needs three distinct points; SQL Server accepts degenerate ones
  // silently and stores something meaningless.
  for (let i = 0; i + 2 < c.length; i += 2) {
    const [a, b, d] = [c[i]!, c[i + 1]!, c[i + 2]!];
    if (samePoint(a, b) || samePoint(b, d) || samePoint(a, d)) return false;
  }
  return true;
}

function segmentEndpoints(seg: CurveSegment): [[number, number], [number, number]] | null {
  const c = seg.coordinates;
  if (!isPositionList(c, 2)) return null;
  return [c[0]!, c[c.length - 1]!];
}

export function isValidCompoundCurve(g: unknown): boolean {
  const segs = (g as { segments?: unknown })?.segments;
  if (!Array.isArray(segs) || segs.length === 0) return false;
  let prevEnd: [number, number] | null = null;
  for (const seg of segs as CurveSegment[]) {
    if (seg?.type === 'CircularString') {
      if (!isValidCircularString(seg)) return false;
    } else if (seg?.type === 'LineString') {
      if (!isPositionList(seg.coordinates, 2)) return false;
    } else {
      return false;
    }
    const ends = segmentEndpoints(seg);
    if (!ends) return false;
    // Segments must join end-to-start or SQL Server rejects the whole thing.
    if (prevEnd && !samePoint(prevEnd, ends[0])) return false;
    prevEnd = ends[1];
  }
  return true;
}

function ringEndpoints(ring: CompoundCurveType | CurveSegment): [[number, number], [number, number]] | null {
  if (ring.type === 'CompoundCurve') {
    const segs = ring.segments;
    if (!segs?.length) return null;
    const first = segmentEndpoints(segs[0]!);
    const last = segmentEndpoints(segs[segs.length - 1]!);
    return first && last ? [first[0], last[1]] : null;
  }
  return segmentEndpoints(ring);
}

export function isValidCurvePolygon(g: unknown): boolean {
  const rings = (g as { rings?: unknown })?.rings;
  if (!Array.isArray(rings) || rings.length === 0) return false;
  for (const ring of rings as Array<CompoundCurveType | CurveSegment>) {
    if (ring?.type === 'CompoundCurve') {
      if (!isValidCompoundCurve(ring)) return false;
    } else if (ring?.type === 'CircularString') {
      if (!isValidCircularString(ring)) return false;
    } else if (ring?.type === 'LineString') {
      if (!isPositionList(ring.coordinates, 4)) return false;
    } else {
      return false;
    }
    const ends = ringEndpoints(ring);
    if (!ends || !samePoint(ends[0], ends[1])) return false;   // must close
  }
  return true;
}

function positionsToWkt(coords: [number, number][]): string {
  return coords.map(p => `${p[0]} ${p[1]}`).join(', ');
}

function circularStringToWkt(g: { coordinates: [number, number][] }): string {
  return `CIRCULARSTRING (${positionsToWkt(g.coordinates)})`;
}

function compoundCurveBodyToWkt(segs: CurveSegment[]): string {
  return segs
    .map(seg =>
      seg.type === 'CircularString'
        ? circularStringToWkt(seg)
        // Bare parenthesised list -- NOT "LINESTRING (...)".
        : `(${positionsToWkt(seg.coordinates)})`,
    )
    .join(', ');
}

function compoundCurveToWkt(g: CompoundCurveType): string {
  return `COMPOUNDCURVE (${compoundCurveBodyToWkt(g.segments)})`;
}

function curvePolygonToWkt(g: CurvePolygonType): string {
  const rings = g.rings.map(ring => {
    if (ring.type === 'CompoundCurve') return compoundCurveToWkt(ring);
    if (ring.type === 'CircularString') return circularStringToWkt(ring);
    return `(${positionsToWkt(ring.coordinates)})`;
  });
  return `CURVEPOLYGON (${rings.join(', ')})`;
}

export function geometryToWkt(geometry: Geometry): string {
  const type = geometry.type;

  // Handle GeometryCollection separately
  if (type === 'GeometryCollection') {
    const geomCollection = geometry as GeometryCollectionType;
    // An empty collection must be written with the EMPTY keyword. The
    // "GEOMETRYCOLLECTION ()" form is not valid WKT: SQL Server rejects it with
    // error 24114 ("the label ) in the input well-known text (WKT) is not
    // valid") and aborts the whole write (e.g. a parcel merge that touches an
    // empty-Shape line).
    if (geomCollection.geometries.length === 0) return 'GEOMETRYCOLLECTION EMPTY';
    const wktParts = geomCollection.geometries.map(g => geometryToWkt(g));
    return `GEOMETRYCOLLECTION (${wktParts.join(', ')})`;
  }

  // Curve geometries carry `segments` / `rings`, not `coordinates`, so they are
  // handled before the coordinate-based path below.
  if (type === 'CompoundCurve') return compoundCurveToWkt(geometry as CompoundCurveType);
  if (type === 'CurvePolygon') return curvePolygonToWkt(geometry as CurvePolygonType);

  // For coordinate-based geometries
  const coords = (geometry as CoordinateGeometry).coordinates;

  // A geometry with no coordinates must also use EMPTY, not "()". Legacy fabric
  // lines and parcels can carry an empty Shape; writing one back as
  // "LINESTRING ()" / "POLYGON ()" is invalid WKT and SQL Server rejects it the
  // same way. Only shortcut known types so an unknown type still hits the
  // explicit error in the switch below.
  if (!(coords as ArrayLike<unknown> | undefined)?.length && WKT_TYPE_NAME[type]) {
    return `${WKT_TYPE_NAME[type]} EMPTY`;
  }

  switch (type) {
    case 'Point':
      return pointToWkt(coords as [number, number]);

    case 'MultiPoint':
      return multiPointToWkt(coords as [number, number][]);

    case 'LineString':
      return lineStringToWkt(coords as [number, number][]);

    case 'MultiLineString':
      return multiLineStringToWkt(coords as [number, number][][]);

    case 'Polygon':
      return polygonToWkt(coords as [number, number][][]);

    case 'MultiPolygon':
      return multiPolygonToWkt(coords as [number, number][][][]);

    case 'CircularString':
      return circularStringToWkt({ coordinates: coords as [number, number][] });

    default:
      throw new Error(`Unsupported geometry type for WKT conversion: ${type}`);
  }
}

/**
 * Format a coordinate pair
 */
function coordToWkt(coord: [number, number]): string {
  return `${coord[0]} ${coord[1]}`;
}

/**
 * Format a ring (array of coordinates)
 */
function ringToWkt(ring: [number, number][]): string {
  return `(${ring.map(coordToWkt).join(', ')})`;
}

/**
 * Point to WKT
 */
function pointToWkt(coords: [number, number]): string {
  return `POINT (${coordToWkt(coords)})`;
}

/**
 * MultiPoint to WKT
 */
function multiPointToWkt(coords: [number, number][]): string {
  const points = coords.map(c => `(${coordToWkt(c)})`).join(', ');
  return `MULTIPOINT (${points})`;
}

/**
 * LineString to WKT
 */
function lineStringToWkt(coords: [number, number][]): string {
  return `LINESTRING ${ringToWkt(coords)}`;
}

/**
 * MultiLineString to WKT
 */
function multiLineStringToWkt(coords: [number, number][][]): string {
  const lines = coords.map(ringToWkt).join(', ');
  return `MULTILINESTRING (${lines})`;
}

/**
 * Polygon to WKT
 */
function polygonToWkt(coords: [number, number][][]): string {
  const rings = coords.map(ringToWkt).join(', ');
  return `POLYGON (${rings})`;
}

/**
 * MultiPolygon to WKT
 */
function multiPolygonToWkt(coords: [number, number][][][]): string {
  const polygons = coords.map(poly => {
    const rings = poly.map(ringToWkt).join(', ');
    return `(${rings})`;
  }).join(', ');
  return `MULTIPOLYGON (${polygons})`;
}

/**
 * Validate and escape WKT for SQL embedding.
 *
 * WKT grammar allows:
 * - Type names: A-Z (POINT, LINESTRING, POLYGON, etc.)
 * - Dimension markers: Z, M, ZM
 * - EMPTY keyword
 * - Coordinates: digits, minus, period, scientific notation (e/E, +)
 * - Structural: parentheses, commas, whitespace
 *
 * EWKT (Extended WKT with SRID prefix) is NOT supported:
 *   SRID=4326;POINT(1 2)  -- NOT SUPPORTED
 * Callers must strip the SRID prefix and pass it separately via the srid parameter.
 *
 * @throws Error if WKT contains unexpected characters
 */
function validateAndEscapeWkt(wkt: string): string {
  // Allow: letters, digits, parentheses, commas, periods, minus, plus,
  // whitespace, and E/e for scientific notation
  // Pattern explanation:
  // - ^[A-Z\s]+ - starts with geometry type (POINT, MULTILINESTRING, etc.)
  // - (?:EMPTY|\(...\))$ - followed by either EMPTY or parenthesized content
  // - The content allows nested type names for GEOMETRYCOLLECTION
  const validWktPattern = /^[A-Z\s]+(?:EMPTY|\([A-Z0-9.,\s\-+()eE]+\))$/i;

  if (!validWktPattern.test(wkt)) {
    // Provide helpful error message showing the problematic characters
    const invalidChars = wkt.replace(/[A-Z0-9.,\s\-+()eE]/gi, '');
    throw new Error(
      `Invalid WKT format: contains unexpected characters: ${JSON.stringify(invalidChars)}`
    );
  }

  // Escape single quotes (defensive - should never appear in valid WKT)
  return wkt.replace(/'/g, "''");
}

/**
 * Build SQL expression for inserting geometry
 * Returns the SQL fragment to use in an INSERT statement
 */
export function geometryToSqlExpression(
  geometry: Geometry,
  driver: 'sqlserver' | 'postgresql',
  srid?: number
): string {
  const wkt = geometryToWkt(geometry);
  const escapedWkt = validateAndEscapeWkt(wkt);
  const actualSrid = srid ?? geometry.srid ?? 0;

  if (driver === 'sqlserver') {
    // SQL Server uses geometry::STGeomFromText
    return `geometry::STGeomFromText('${escapedWkt}', ${actualSrid})`;
  } else {
    // PostgreSQL uses ST_GeomFromText
    return `ST_GeomFromText('${escapedWkt}', ${actualSrid})`;
  }
}

/**
 * Validate geometry coordinates
 * Returns true if geometry has valid structure
 */
export function isValidGeometry(geometry: Geometry): boolean {
  if (!geometry || !geometry.type) {
    return false;
  }

  // Handle GeometryCollection separately
  if (geometry.type === 'GeometryCollection') {
    const geomCollection = geometry as GeometryCollectionType;
    return (
      Array.isArray(geomCollection.geometries) &&
      geomCollection.geometries.every(g => isValidGeometry(g))
    );
  }

  // Curve geometries carry `segments` / `rings` instead of `coordinates`.
  // Checking `.coordinates` first is exactly the bug that made every curve
  // SHAPE get silently dropped, so they are decided before that test.
  if (geometry.type === 'CompoundCurve') return isValidCompoundCurve(geometry);
  if (geometry.type === 'CurvePolygon') return isValidCurvePolygon(geometry);

  // For coordinate-based geometries
  const coordGeom = geometry as CoordinateGeometry;
  if (!coordGeom.coordinates) {
    return false;
  }

  const coords = coordGeom.coordinates;

  switch (geometry.type) {
    case 'Point':
      return isValidPoint(coords);

    case 'MultiPoint':
      return Array.isArray(coords) && coords.every(isValidPoint);

    case 'LineString':
      return isValidLineString(coords);

    case 'MultiLineString':
      return Array.isArray(coords) && coords.every(isValidLineString);

    case 'Polygon':
      return isValidPolygon(coords);

    case 'MultiPolygon':
      return Array.isArray(coords) && coords.every(isValidPolygon);

    case 'CircularString':
      return isValidCircularString(geometry);

    default:
      return false;
  }
}

function isValidPoint(coords: unknown): coords is [number, number] {
  return (
    Array.isArray(coords) &&
    coords.length >= 2 &&
    typeof coords[0] === 'number' &&
    typeof coords[1] === 'number' &&
    isFinite(coords[0]) &&
    isFinite(coords[1])
  );
}

function isValidLineString(coords: unknown): coords is [number, number][] {
  return (
    Array.isArray(coords) &&
    coords.length >= 2 &&
    coords.every(isValidPoint)
  );
}

function isValidPolygon(coords: unknown): coords is [number, number][][] {
  return (
    Array.isArray(coords) &&
    coords.length >= 1 &&
    coords.every(ring =>
      Array.isArray(ring) &&
      ring.length >= 4 &&
      ring.every(isValidPoint)
    )
  );
}
