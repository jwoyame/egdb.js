/**
 * Geometry writer - Convert GeoJSON to WKT/WKB for database insertion
 */

import type { Geometry, GeometryType, CoordinateGeometry, GeometryCollectionType } from '../types';

/**
 * Convert a GeoJSON-style geometry to WKT (Well-Known Text)
 * WKT is easier to work with than WKB and SQL Server/PostgreSQL can parse it natively
 */
export function geometryToWkt(geometry: Geometry): string {
  const type = geometry.type;

  // Handle GeometryCollection separately
  if (type === 'GeometryCollection') {
    const geomCollection = geometry as GeometryCollectionType;
    const wktParts = geomCollection.geometries.map(g => geometryToWkt(g));
    return `GEOMETRYCOLLECTION (${wktParts.join(', ')})`;
  }

  // For coordinate-based geometries
  const coords = (geometry as CoordinateGeometry).coordinates;

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
