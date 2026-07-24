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
    // Set-based prune removes the WHOLE unreachable subtree {5,6,7,8} at once.
    for (const s of [5, 6, 7, 8]) expect(live.has(s), `state ${s} should be pruned`).toBe(false);
  });

  it('prune protects a LOCKED unreachable branch (lock ∪ ancestors ∪ descendants)', async () => {
    // 0 <- 1 (version v). Orphan chain 5 <- 6 <- 7, all unreachable from any tip.
    // A lock on state 6 expands to {5 (ancestor), 6, 7 (descendant)} — the entire
    // orphan branch — so prune must delete NONE of it despite being unreachable.
    const f = new Fabric();
    st(f, 1, 0, 1); f.versions.set('v', 1);
    st(f, 5, 0, 5); st(f, 6, 5, 5); st(f, 7, 6, 5);
    f.locks.add(6);
    await materialize(conn, f);

    await pruneStates(conn, [PARCELS]);

    const live = await liveStateIds(conn);
    for (const s of [5, 6, 7]) expect(live.has(s), `locked-branch state ${s} must survive`).toBe(true);
    expect(await danglingParents(conn)).toEqual([]);
  });

  it('prune removes an unlocked sibling of a locked branch without orphaning it', async () => {
    // 0 <- 1 (v). Orphan: 5 <- {6 (locked), 8 (unlocked leaf)}; 6 <- 7.
    // Lock on 6 protects {5,6,7} (5 is 6's ancestor). State 8 is a sibling of 6 —
    // NOT an ancestor or descendant of the lock — so it is unreachable AND
    // unlocked → pruned. Its parent 5 is locked-protected, so no dangling results.
    const f = new Fabric();
    st(f, 1, 0, 1); f.versions.set('v', 1);
    st(f, 5, 0, 5); st(f, 6, 5, 5); st(f, 7, 6, 5); st(f, 8, 5, 8);
    f.locks.add(6);
    await materialize(conn, f);

    await pruneStates(conn, [PARCELS]);

    const live = await liveStateIds(conn);
    expect(live.has(8), 'unlocked sibling 8 should be pruned').toBe(false);
    for (const s of [5, 6, 7]) expect(live.has(s), `locked-branch state ${s} must survive`).toBe(true);
    expect(await danglingParents(conn), 'no dangling after pruning the sibling').toEqual([]);
  });

  it('N6: prune must NOT delete a live branch closure row keyed by a pruned state id as lineage_name', async () => {
    // lineage_name shares the id-space with state_id, and on a DIVERGENT fabric a
    // pruned state's id can equal a lineage_name still used by a live branch.
    // 0 <- 1 (version v, lineage_name 1). Orphan leaf 9 (prunable). Inject a
    // divergent closure row (lineage_name = 9, lineage_id = 1) — as if the live
    // state 1 were catalogued under lineage 9. Deleting closure by lineage_name IN
    // {9} (the N6 bug) would wipe that row; keying on lineage_id only preserves it.
    const f = new Fabric();
    st(f, 1, 0, 1); f.versions.set('v', 1);
    st(f, 9, 0, 9); // unreachable, prunable; its id (9) doubles as a live lineage_name
    f.lineages.add('1:1');   // clean self-row for lineage 1
    f.lineages.add('9:1');   // DIVERGENT: lineage named 9 contains live state 1
    await materialize(conn, f);

    await pruneStates(conn, [PARCELS]);

    const survived = await conn.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_name = 9 AND lineage_id = 1;`);
    expect(Number(survived[0]!.n), 'live lineage_id=1 closure row must survive prune of state 9').toBe(1);
    // The genuinely dead row (lineage_id = 9) is cleaned up.
    const deadGone = await conn.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sde.SDE_state_lineages WHERE lineage_id = 9;`);
    expect(Number(deadGone[0]!.n), 'closure rows for the pruned state (lineage_id=9) removed').toBe(0);
  });
});
