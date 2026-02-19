/**
 * Parser for sde.GDB_ITEMS table
 *
 * GDB_ITEMS stores metadata about all geodatabase objects.
 * The Definition column contains XML with detailed schema info.
 */

import type { TableInfo, FieldDefinition, SpatialReference, FieldType, GeometryType } from '../types';

/** Raw GDB_ITEMS row */
export interface GdbItemRow {
  ObjectID: number;
  UUID: string;
  Type: string;
  Name: string;
  PhysicalName: string;
  Path: string;
  DatasetSubtype1?: number;
  DatasetSubtype2?: number;
  DatasetInfo1?: string;
  DatasetInfo2?: string;
  Definition?: string; // XML
}

/** Item types from sde.GDB_ITEMTYPES */
export const ITEM_TYPE_UUIDS = {
  FEATURE_CLASS: 'CA1C6E90-7896-4692-AA21-F8BB7063C4AD',
  TABLE: '77C1E6B3-9EB4-4A1D-B686-E1CADD1E3ADA',
  FEATURE_DATASET: 'DE8A3C7D-0C90-4C8A-B9A5-3B2C7F4C1A3D',
  CODED_VALUE_DOMAIN: 'C3A50D2E-4F7D-4C35-B9A9-4B6C4C1B4E6F',
  RANGE_DOMAIN: 'B2C5A4D3-E6F7-4A8B-9C0D-1E2F3A4B5C6D',
} as const;

/** Geometry type mapping from DatasetSubtype1 */
const GEOMETRY_TYPE_MAP: Record<number, GeometryType> = {
  1: 'Point',
  2: 'MultiPoint',
  3: 'LineString', // Polyline
  4: 'Polygon',
  9: 'MultiPoint', // Multipatch (treat as multipoint for now)
};

/**
 * Parse GDB_ITEMS rows into TableInfo objects
 */
export function parseGdbItems(rows: GdbItemRow[]): TableInfo[] {
  const tables: TableInfo[] = [];

  for (const row of rows) {
    // Only process feature classes and tables
    const isFeatureClass = row.Type.toUpperCase() === ITEM_TYPE_UUIDS.FEATURE_CLASS;
    const isTable = row.Type.toUpperCase() === ITEM_TYPE_UUIDS.TABLE;

    if (!isFeatureClass && !isTable) continue;

    // Parse physical name to get schema and table
    const [schema, tableName] = parsePhysicalName(row.PhysicalName);

    const tableInfo: TableInfo = {
      name: tableName, // Use parsed table name, not full path
      physicalName: row.PhysicalName,
      schema,
      isFeatureClass,
      geometryType: isFeatureClass ? GEOMETRY_TYPE_MAP[row.DatasetSubtype1 ?? 0] : undefined,
      shapeFieldName: row.DatasetInfo1,
    };

    tables.push(tableInfo);
  }

  return tables;
}

/**
 * Parse the XML Definition column for field definitions
 */
export function parseDefinitionXml(xml: string): {
  fields: FieldDefinition[];
  spatialReference?: SpatialReference;
  geometryType?: GeometryType;
} {
  const fields: FieldDefinition[] = [];
  let spatialReference: SpatialReference | undefined;
  let geometryType: GeometryType | undefined;

  // Parse geometry type from ShapeType element
  const shapeTypeMatch = xml.match(/<ShapeType>([^<]+)<\/ShapeType>/i);
  if (shapeTypeMatch) {
    geometryType = mapEsriShapeType(shapeTypeMatch[1]!);
  }

  // Try GPFieldInfoEx format first (newer geodatabases)
  const gpFieldMatches = xml.matchAll(/<GPFieldInfoEx[^>]*>([\s\S]*?)<\/GPFieldInfoEx>/gi);
  for (const match of gpFieldMatches) {
    const fieldXml = match[1]!;

    const name = extractXmlValue(fieldXml, 'Name');
    const type = extractXmlValue(fieldXml, 'FieldType');
    const alias = extractXmlValue(fieldXml, 'AliasName');
    const isNullable = extractXmlValue(fieldXml, 'IsNullable')?.toLowerCase() === 'true';

    if (name && type) {
      fields.push({
        name,
        type: mapEsriFieldType(type),
        typeName: type,
        alias: alias || name,
        nullable: isNullable,
      });
    }
  }

  // Fallback to Field format if no GPFieldInfoEx found
  if (fields.length === 0) {
    const fieldMatches = xml.matchAll(/<Field[^>]*>([\s\S]*?)<\/Field>/gi);
    for (const match of fieldMatches) {
      const fieldXml = match[1]!;

      const name = extractXmlValue(fieldXml, 'Name');
      const type = extractXmlValue(fieldXml, 'Type') || extractXmlValue(fieldXml, 'FieldType');
      const alias = extractXmlValue(fieldXml, 'AliasName');
      const length = parseInt(extractXmlValue(fieldXml, 'Length') || '0', 10);
      const precision = parseInt(extractXmlValue(fieldXml, 'Precision') || '0', 10);
      const scale = parseInt(extractXmlValue(fieldXml, 'Scale') || '0', 10);
      const isNullable = extractXmlValue(fieldXml, 'IsNullable')?.toLowerCase() === 'true';

      if (name && type) {
        fields.push({
          name,
          type: mapEsriFieldType(type),
          typeName: type,
          alias: alias || name,
          nullable: isNullable,
          length: length > 0 ? length : undefined,
          precision: precision > 0 ? precision : undefined,
          scale: scale > 0 ? scale : undefined,
        });
      }
    }
  }

  // Parse spatial reference
  const srMatch = xml.match(/<SpatialReference[^>]*>([\s\S]*?)<\/SpatialReference>/i);
  if (srMatch) {
    const srXml = srMatch[1]!;
    spatialReference = {
      wkid: parseInt(extractXmlValue(srXml, 'WKID') || '0', 10) || undefined,
      wkt: extractXmlValue(srXml, 'WKT'),
      xOrigin: parseFloat(extractXmlValue(srXml, 'XOrigin') || '0'),
      yOrigin: parseFloat(extractXmlValue(srXml, 'YOrigin') || '0'),
      xyScale: parseFloat(extractXmlValue(srXml, 'XYScale') || '0'),
      xyTolerance: parseFloat(extractXmlValue(srXml, 'XYTolerance') || '0'),
    };
  }

  return { fields, spatialReference, geometryType };
}

/** Map ESRI shape type string to GeometryType */
function mapEsriShapeType(esriType: string): GeometryType | undefined {
  const typeMap: Record<string, GeometryType> = {
    esriGeometryPoint: 'Point',
    esriGeometryMultipoint: 'MultiPoint',
    esriGeometryPolyline: 'LineString',
    esriGeometryPolygon: 'Polygon',
  };
  return typeMap[esriType];
}

/** Extract a value from XML */
function extractXmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match ? match[1] : undefined;
}

/** Parse physical name like "database.schema.table" */
function parsePhysicalName(physicalName: string): [string, string] {
  const parts = physicalName.split('.');
  if (parts.length >= 2) {
    return [parts[parts.length - 2]!, parts[parts.length - 1]!];
  }
  return ['dbo', physicalName];
}

/** Map ESRI field type string to FieldType enum value */
function mapEsriFieldType(esriType: string): FieldType {
  const typeMap: Record<string, FieldType> = {
    esriFieldTypeSmallInteger: 0, // SMALLINTEGER
    esriFieldTypeInteger: 1, // INTEGER
    esriFieldTypeSingle: 2, // FLOAT
    esriFieldTypeDouble: 3, // DOUBLE
    esriFieldTypeString: 4, // STRING
    esriFieldTypeDate: 5, // DATE
    esriFieldTypeOID: 6, // OID
    esriFieldTypeGeometry: 7, // GEOMETRY
    esriFieldTypeBlob: 8, // BLOB
    esriFieldTypeRaster: 9, // RASTER
    esriFieldTypeGUID: 10, // GUID
    esriFieldTypeGlobalID: 11, // GLOBALID
    esriFieldTypeXML: 12, // XML
  };
  return (typeMap[esriType] ?? 4) as FieldType; // Default to STRING
}
