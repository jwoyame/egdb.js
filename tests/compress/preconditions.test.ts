/**
 * The hard-abort precondition gate (NIGHTLY_COMPRESS_ROADMAP.md Step B): compress
 * must REFUSE to run on a structurally unsound fabric rather than operate on it.
 * Each injected violation must throw CompressPreconditionError; a well-formed
 * fabric must pass.
 *
 * Gated on EGDB_COMPRESS_DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { assertCompressPreconditions, CompressPreconditionError } from '../../src/reconcile/compress-impl';
import { Fabric } from './reference-model';
import { connectScratch, resetFabric, HAVE_DB } from './db';
import { materialize } from './fabric-builder';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;

d('compress precondition gate (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => { conn = await connectScratch('egdb_compress_precond'); });
  afterAll(async () => { if (conn) await conn.close(); });
  beforeEach(async () => { await resetFabric(conn); });

  const wellFormed = () => {
    const f = new Fabric();
    f.states.set(1, { stateId: 1, parentStateId: 0, lineageName: 1 });
    f.states.set(2, { stateId: 2, parentStateId: 1, lineageName: 1 });
    f.versions.set('DEFAULT', 2);
    return f;
  };

  it('passes on a well-formed fabric', async () => {
    await materialize(conn, wellFormed());
    await expect(assertCompressPreconditions(conn)).resolves.toBeUndefined();
  });

  it('aborts on a dangling parent_state_id (C6)', async () => {
    await materialize(conn, wellFormed());
    // state 9 points at a non-existent parent 999.
    await conn.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (9, 't', 9, 999);`);
    await expect(assertCompressPreconditions(conn)).rejects.toThrow(CompressPreconditionError);
    await expect(assertCompressPreconditions(conn)).rejects.toThrow(/dangling parent_state_id/);
  });

  it('aborts when state 0 is missing', async () => {
    await materialize(conn, wellFormed());
    await conn.execute(`DELETE FROM sde.SDE_states WHERE state_id = 0;`);
    await expect(assertCompressPreconditions(conn)).rejects.toThrow(/state 0 \(base\) is missing/);
  });

  it('aborts when the (0,0) closure row is missing', async () => {
    await materialize(conn, wellFormed());
    await conn.execute(`DELETE FROM sde.SDE_state_lineages WHERE lineage_name = 0 AND lineage_id = 0;`);
    await expect(assertCompressPreconditions(conn)).rejects.toThrow(/\(0,0\) SDE_state_lineages row is missing/);
  });

  it('aborts on a states_cuk violation (duplicate parent+lineage_name)', async () => {
    await materialize(conn, wellFormed());
    // The synthetic schema enforces states_cuk, so a duplicate can only exist if
    // the constraint was dropped — which is exactly what this check guards. Drop
    // it, inject the duplicate, assert the gate catches it, then restore.
    await conn.execute(`ALTER TABLE sde.SDE_states DROP CONSTRAINT states_cuk;`);
    try {
      await conn.execute(`INSERT INTO sde.SDE_states (state_id, owner, lineage_name, parent_state_id) VALUES (7, 't', 1, 1);`); // dup of (parent 1, lineage 1) with state 2
      await expect(assertCompressPreconditions(conn)).rejects.toThrow(/states_cuk violated/);
    } finally {
      await conn.execute(`DELETE FROM sde.SDE_states WHERE state_id = 7;`);
      await conn.execute(`ALTER TABLE sde.SDE_states ADD CONSTRAINT states_cuk UNIQUE (parent_state_id, lineage_name);`);
    }
  });
});
