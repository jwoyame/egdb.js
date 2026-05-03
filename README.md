# egdb.js

Enterprise Geodatabase library for Node.js - Read and write ArcGIS Enterprise Geodatabases (SQL Server, PostgreSQL).

## Features

- **Read/Write Support**: Full CRUD operations on geodatabase tables
- **Versioned Editing**: Create, edit, reconcile, and post versions
- **Streaming**: Memory-efficient streaming of large datasets
- **Spatial Queries**: Intersects, contains, within, distance-based queries
- **Transaction Support**: Atomic operations with rollback capability
- **Field-Level Conflict Detection**: Auto-merge non-conflicting changes
- **Undo/Redo**: Track and reverse edit operations
- **Compression**: Remove redundant A/D table entries

## Installation

```bash
yarn add @etchgis/egdb.js
# or
npm install @etchgis/egdb.js
```

## Quick Start

```typescript
import { EnterpriseGeodatabase, EditSession } from '@etchgis/egdb.js';

// Connect
const egdb = await EnterpriseGeodatabase.connect({
  driver: 'sqlserver',
  server: 'localhost',
  port: 1433,
  database: 'my_geodatabase',
  user: 'sde',
  password: 'password'
});

// List tables
const tables = await egdb.listTables();

// Stream features
const parcels = await egdb.openTable('Parcels');
for await (const feature of parcels.stream()) {
  console.log(feature.id, feature.attributes);
}

await egdb.close();
```

## API Reference

### Reading Data

```typescript
// Open a table
const table = await egdb.openTable('Parcels');

// Stream all features
for await (const feature of table.stream()) {
  console.log(feature);
}

// Stream with options
for await (const feature of table.stream({
  where: 'STATUS = 1',
  limit: 100
})) {
  console.log(feature);
}

// Read from a specific version
for await (const feature of table.stream({
  version: 'editor.my_version'
})) {
  console.log(feature);
}
```

### Spatial Queries

```typescript
// Find features intersecting a geometry
for await (const feature of table.stream({
  geometry: {
    type: 'Polygon',
    coordinates: [[[-80, 25], [-80, 26], [-79, 26], [-79, 25], [-80, 25]]],
    srid: 4326
  },
  spatialRelationship: 'intersects'
})) {
  console.log(feature);
}

// Find features within distance
for await (const feature of table.stream({
  geometry: { type: 'Point', coordinates: [-80.5, 25.5], srid: 4326 },
  spatialRelationship: 'intersects',
  distance: 1000 // meters
})) {
  console.log(feature);
}
```

### Writing Data (Non-Versioned)

```typescript
// Insert
const newId = await table.insert({
  attributes: { Name: 'New Parcel', Status: 'Active' },
  geometry: { type: 'Point', coordinates: [400000, 1900000], srid: 2236 }
});

// Update
await table.update(newId, { Status: 'Inactive' });

// Delete
await table.delete(newId);
```

### Versioned Editing

```typescript
// Create a version
const version = await egdb.createVersion('my_edits', {
  parent: 'sde.DEFAULT',
  access: EnterpriseGeodatabase.VersionAccess.PRIVATE
});

// Start an edit session
const session = await EditSession.start(egdb, 'myuser.my_edits');

// Make edits
const id = await session.insert('Parcels', {
  attributes: { Name: 'New Parcel' }
});

await session.update('Parcels', id, { Status: 'Active' });

// Undo/Redo
await session.undo();
await session.redo();

// Save changes
await session.save();
await session.close();
```

### Reconcile and Post

```typescript
// Reconcile with parent (detect only)
const result = await egdb.reconcileVersion('myuser.my_edits', {
  detectOnly: true
});

if (result.hasConflicts) {
  console.log(`${result.conflictCount} conflicts found`);
  for (const c of result.conflicts) {
    console.log(`  ${c.table} OID ${c.objectId}: ${c.childChangeType} vs ${c.parentChangeType}`);
  }
}

// Full reconcile with auto-merge
const result = await egdb.reconcileVersion('myuser.my_edits', {
  autoMerge: true,
  conflictResolution: 'favor_edit' // or 'favor_target'
});

// Custom conflict resolution
const result = await egdb.reconcileVersion('myuser.my_edits', {
  resolveConflict: async (conflict) => {
    if (conflict.autoMergeable) {
      return 'merge';
    }
    // Custom logic here
    return 'favor_edit';
  }
});

// Post to parent
await egdb.postVersion('myuser.my_edits');

// Optionally delete after posting
await egdb.postVersion('myuser.my_edits', {
  deleteVersionAfterPost: true
});
```

### Transaction Support

```typescript
// Simple transaction
await egdb.transaction(async () => {
  const table = await egdb.openTable('Parcels');
  await table.insert({ attributes: { Name: 'Parcel 1' } });
  await table.insert({ attributes: { Name: 'Parcel 2' } });
  // Auto-commits on success, rolls back on error
});

// Edit transaction (versioned)
await egdb.editTransaction('sde.DEFAULT', async (session) => {
  await session.insert('Parcels', { attributes: { Name: 'New' } });
  // Auto-saves and closes session
});
```

### Version Management

```typescript
// List versions
const versions = await egdb.listVersions();

// Create version
const version = await egdb.createVersion('my_version', {
  parent: 'sde.DEFAULT',
  access: EnterpriseGeodatabase.VersionAccess.PUBLIC,
  description: 'My editing version'
});

// Delete version
await egdb.deleteVersion('myuser.my_version');

// Compress version
const result = await egdb.compressVersion('myuser.my_version');
console.log(`Removed ${result.addsRemoved} adds, ${result.deletesRemoved} deletes`);
```

## Type Definitions

```typescript
interface Feature {
  id: number;
  attributes: Record<string, unknown>;
  geometry?: Geometry;
}

interface Geometry {
  type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
  coordinates: unknown;
  srid?: number;
}

interface ReconcileResult {
  hasConflicts: boolean;
  conflictCount: number;
  conflicts: DetailedConflict[];
  applied: boolean;
  parentChangesApplied: number;
  mergedCount: number;
}

interface DetailedConflict {
  table: string;
  objectId: number;
  childChangeType: 'insert' | 'update' | 'delete';
  parentChangeType: 'insert' | 'update' | 'delete';
  fieldConflicts: FieldConflict[];
  autoMergeable: boolean;
  suggestedMerge?: Record<string, unknown>;
}
```

## Interoperability with gdb.js

Both egdb.js and gdb.js implement shared interfaces for transparent access to different geodatabase types:

```typescript
import type { IGeodatabase, ITable } from '@etchgis/gdb.js';

async function processGeodatabase(gdb: IGeodatabase) {
  const tables = await gdb.listTables();
  for (const info of tables) {
    const table: ITable = await gdb.openTable(info.name);
    for await (const feature of table.stream()) {
      // Works with both file and enterprise geodatabases
      console.log(feature);
    }
  }
}
```

## Supported Databases

- **SQL Server** (mssql driver)
- **PostgreSQL** (pg driver) with PostGIS
