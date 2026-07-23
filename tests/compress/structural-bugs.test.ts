/**
 * DB-backed reproductions of the closure-INDEPENDENT structural compress bugs,
 * against the synthetic SQL Server schema. These are expected to FAIL against
 * today's code (red) and pass once the fixes land (green).
 *
 * Gated on EGDB_COMPRESS_DB (docker/sqlserver up). Run:
 *   EGDB_COMPRESS_DB=1 npx vitest run tests/compress/structural-bugs.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { collapseLineages, pruneStates } from '../../src/reconcile/compress-impl';
import { Fabric } from './reference-model';
import { connectScratch, resetFabric, HAVE_DB, PARCELS } from './db';
import { materialize, liveStateIds, danglingParents } from './fabric-builder';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;
if (!HAVE_DB) console.warn('[compress] EGDB_COMPRESS_DB unset — skipping DB-backed structural tests');

d('compress structural bugs (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => { conn = await connectScratch('egdb_compress_struct'); });
  afterAll(async () => { if (conn) await conn.close(); });
  beforeEach(async () => { await resetFabric(conn); });

  // helper: build state row into a fabric
  function st(f: Fabric, id: number, parent: number, lineage: number) {
    f.states.set(id, { stateId: id, parentStateId: parent, lineageName: lineage });
    f.lineages.add(`${lineage}:${id}`);
  }

  it('C2: collapse must NOT collapse a child into a state that is a version tip', async () => {
    // 0 <- 1 (version "v" sits here) <- 2 (v's only child, non-tip).
    // Buggy collapse pairs (parent=1, child=2) — it only checks the CHILD is a
    // non-tip — and deletes 2, moving its edits onto v's state. Correct behaviour:
    // leave 2 alone because its parent (1) is a version tip.
    const f = new Fabric();
    st(f, 1, 0, 1);
    st(f, 2, 1, 1);
    f.versions.set('v', 1);
    f.table('parcels').adds.set('100:2', { oid: 100, state: 2, values: { VAL: 'edit-at-2' } });
    await materialize(conn, f);

    await collapseLineages(conn, [PARCELS]);

    const live = await liveStateIds(conn);
    expect(live.has(2)).toBe(true); // state 2 must survive — its parent is a tip
  });

  it('C4/N4: prune must not orphan a child (orphan branch point)', async () => {
    // 0 <- 1 (version "v").  Orphan subtree:  5 <- 6 <- {7, 8}.
    // findPruneCandidates snapshots candidates ONCE: 5 (one child), 7, 8 (leaves).
    // 6 has TWO children so it is NOT a candidate. Pruning 5 (its child 6 kept)
    // leaves 6 with parent_state_id = 5, now deleted → 6 dangles. Correct behaviour
    // (leaves-only + iterate, or refuse a state with a surviving child) leaves no
    // dangling pointer.
    const f = new Fabric();
    st(f, 1, 0, 1);
    f.versions.set('v', 1);
    st(f, 5, 0, 5);
    st(f, 6, 5, 5);
    st(f, 7, 6, 7);
    st(f, 8, 6, 8);
    await materialize(conn, f);

    await pruneStates(conn, [PARCELS]);

    const dangling = await danglingParents(conn);
    const live = await liveStateIds(conn);
    expect(dangling).toEqual([]); // no orphaned child left behind
    expect(live.has(0)).toBe(true); // base state intact
  });
});
