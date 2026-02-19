/**
 * Test script for validating egdb.js connection to Putnam County Enterprise GDB
 *
 * Usage:
 *   1. Start port forward: ./fetch port-forward putnam-pc-01 -L 11433:pa-parcels.cxqeca30oa7n.us-east-1.rds.amazonaws.com:1433
 *   2. Run: npx ts-node scripts/test-connection.ts
 */

import { EnterpriseGeodatabase } from '../src/index.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: ${name} environment variable is required`);
    process.exit(1);
  }
  return value;
}

async function main() {
  // All connection params required via env vars - no fallbacks
  const host = requireEnv('EGDB_HOST');
  const port = parseInt(requireEnv('EGDB_PORT'), 10);
  const database = requireEnv('EGDB_DATABASE');
  const user = requireEnv('EGDB_USER');
  const password = requireEnv('EGDB_PASSWORD');

  console.log(`Connecting to ${host}:${port}/${database} as ${user}...\n`);

  const egdb = await EnterpriseGeodatabase.connect({
    driver: 'sqlserver',
    server: host,
    port,
    database,
    user,
    password,
    options: {
      encrypt: false,
      trustServerCertificate: true,
    },
  });

  console.log(`✓ Connected! Geodatabase version: ${egdb.version}\n`);

  // List tables
  console.log('Tables and Feature Classes:');
  console.log('─'.repeat(60));

  const tables = await egdb.listTables();
  for (const table of tables) {
    const type = table.isFeatureClass ? '[FC]' : '[T] ';
    const geom = table.geometryType ? ` (${table.geometryType})` : '';
    console.log(`  ${type} ${table.name}${geom}`);
  }

  console.log(`\nTotal: ${tables.length} tables/feature classes\n`);

  // Open a feature class and read some features
  const parcelTable = tables.find((t) => t.name.toLowerCase().includes('parcelfabric_parcels'));
  if (parcelTable) {
    console.log(`\nOpening ${parcelTable.name}...`);
    const table = await egdb.openTable(parcelTable.name);

    console.log(`  Feature count: ${table.metadata.featureCount}`);
    console.log(`  Geometry type: ${table.metadata.geometryType}`);
    console.log(`  Shape field: ${table.metadata.shapeFieldName}`);
    console.log(`  Fields: ${table.metadata.fields.length}`);

    console.log('\n  First 3 features:');
    let count = 0;
    for await (const feature of table.stream()) {
      const hasGeom = feature.geometry ? `✓ ${feature.geometry.type}` : '✗ null';
      console.log(`    [${feature.id}] geometry: ${hasGeom}`);
      if (feature.geometry) {
        const coords = JSON.stringify(feature.geometry.coordinates).slice(0, 80);
        console.log(`      coords: ${coords}...`);
      }
      count++;
      if (count >= 3) break;
    }
  } else {
    console.log('\nNo parcel table found to test streaming.');
  }

  await egdb.close();
  console.log('\n✓ Connection closed');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
