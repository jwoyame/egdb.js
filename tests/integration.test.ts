/**
 * Integration tests for egdb.js
 *
 * These tests require a live database connection.
 * Set environment variables before running:
 *   EGDB_HOST, EGDB_PORT, EGDB_DATABASE, EGDB_USER, EGDB_PASSWORD
 *
 * Run with: yarn test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EnterpriseGeodatabase, EnterpriseTable } from '../src/index.js';

// Skip all tests if env vars not set
const SKIP_INTEGRATION = !process.env.EGDB_HOST || !process.env.EGDB_PASSWORD;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set`);
  return value;
}

describe.skipIf(SKIP_INTEGRATION)('EnterpriseGeodatabase Integration', () => {
  let egdb: EnterpriseGeodatabase;

  beforeAll(async () => {
    egdb = await EnterpriseGeodatabase.connect({
      driver: 'sqlserver',
      server: requireEnv('EGDB_HOST'),
      port: parseInt(requireEnv('EGDB_PORT'), 10),
      database: requireEnv('EGDB_DATABASE'),
      user: requireEnv('EGDB_USER'),
      password: requireEnv('EGDB_PASSWORD'),
      options: {
        encrypt: false,
        trustServerCertificate: true,
      },
    });
  });

  afterAll(async () => {
    if (egdb) {
      await egdb.close();
    }
  });

  describe('connection', () => {
    it('should connect and detect geodatabase version', () => {
      expect(egdb.version).toBeDefined();
      expect(egdb.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should provide source string without password', () => {
      expect(egdb.source).toBeDefined();
      expect(egdb.source).not.toContain(requireEnv('EGDB_PASSWORD'));
    });
  });

  describe('listTables', () => {
    it('should list tables and feature classes', async () => {
      const tables = await egdb.listTables();

      expect(tables).toBeDefined();
      expect(Array.isArray(tables)).toBe(true);
      expect(tables.length).toBeGreaterThan(0);
    });

    it('should include table metadata', async () => {
      const tables = await egdb.listTables();
      const table = tables[0]!;

      expect(table.name).toBeDefined();
      expect(table.physicalName).toBeDefined();
      expect(table.schema).toBeDefined();
      expect(typeof table.isFeatureClass).toBe('boolean');
    });

    it('should identify feature classes with geometry type', async () => {
      const tables = await egdb.listTables();
      const featureClass = tables.find((t) => t.isFeatureClass);

      if (featureClass) {
        expect(featureClass.shapeFieldName).toBeDefined();
      }
    });
  });

  describe('openTable', () => {
    let table: EnterpriseTable;

    beforeAll(async () => {
      const tables = await egdb.listTables();
      const featureClass = tables.find((t) => t.isFeatureClass);
      if (featureClass) {
        table = await egdb.openTable(featureClass.name);
      }
    });

    it('should open a table and load metadata', () => {
      expect(table).toBeDefined();
      expect(table.name).toBeDefined();
      expect(table.metadata).toBeDefined();
    });

    it('should have feature count', () => {
      expect(table.metadata.featureCount).toBeGreaterThanOrEqual(0);
    });

    it('should have field definitions', () => {
      expect(table.metadata.fields).toBeDefined();
      expect(Array.isArray(table.metadata.fields)).toBe(true);
    });

    it('should detect geometry type from Definition XML', () => {
      if (table.metadata.isFeatureClass) {
        expect(table.metadata.geometryType).toBeDefined();
        expect(['Point', 'MultiPoint', 'LineString', 'Polygon']).toContain(
          table.metadata.geometryType
        );
      }
    });
  });

  describe('streaming features', () => {
    it('should stream features with geometry', async () => {
      const tables = await egdb.listTables();
      const featureClass = tables.find((t) => t.isFeatureClass);

      if (!featureClass) {
        return; // Skip if no feature classes
      }

      const table = await egdb.openTable(featureClass.name);
      const features = [];

      for await (const feature of table.stream()) {
        features.push(feature);
        if (features.length >= 5) break;
      }

      expect(features.length).toBeGreaterThan(0);

      const feature = features[0]!;
      expect(feature.id).toBeDefined();
      expect(typeof feature.id).toBe('number');
      expect(feature.attributes).toBeDefined();
    });

    it('should parse WKB geometry correctly', async () => {
      const tables = await egdb.listTables();
      const featureClass = tables.find((t) => t.isFeatureClass);

      if (!featureClass) return;

      const table = await egdb.openTable(featureClass.name);

      for await (const feature of table.stream()) {
        if (feature.geometry) {
          expect(feature.geometry.type).toBeDefined();
          expect(feature.geometry.coordinates).toBeDefined();
          expect(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']).toContain(
            feature.geometry.type
          );
        }
        break; // Just check first feature
      }
    });
  });

  describe('getFeature', () => {
    it('should get a single feature by ID', async () => {
      const tables = await egdb.listTables();
      const featureClass = tables.find((t) => t.isFeatureClass);

      if (!featureClass) return;

      const table = await egdb.openTable(featureClass.name);

      // Get first feature to find an ID
      let firstId: number | null = null;
      for await (const feature of table.stream()) {
        firstId = feature.id;
        break;
      }

      if (firstId) {
        const feature = await table.getFeature(firstId);
        expect(feature).toBeDefined();
        expect(feature!.id).toBe(firstId);
      }
    });

    it('should return null for non-existent ID', async () => {
      const tables = await egdb.listTables();
      const anyTable = tables[0];

      if (!anyTable) return;

      const table = await egdb.openTable(anyTable.name);
      const feature = await table.getFeature(-999999);

      expect(feature).toBeNull();
    });
  });
});
