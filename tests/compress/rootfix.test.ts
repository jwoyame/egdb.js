/**
 * DB-backed tests for the root fix (compress judges ancestry by the
 * parent_state_id walk, not the SDE_state_lineages closure): C1 (graduation
 * ignores a manufactured OVER closure entry), C5 (lock expansion walks the tree
 * up AND down), and N5 (state 0 is never a collapse target).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { computeGraduablePrefix, graduateTable, collapseLineages, readLockedBranches } from '../../src/reconcile/compress-impl';
import { Fabric } from './reference-model';
import { connectScratch, resetFabric, HAVE_DB, PARCELS } from './db';
import { materialize, liveStateIds } from './fabric-builder';
import type { SqlServerConnection } from '../../src/connections/sqlserver';

const d = HAVE_DB ? describe : describe.skip;

d('compress root fix (DB-backed)', () => {
  let conn: SqlServerConnection;
  beforeAll(async () => { conn = await connectScratch('egdb_compress_rootfix'); });
  afterAll(async () => { if (conn) await conn.close(); });
  beforeEach(async () => { await resetFabric(conn); });

  const st = (f: Fabric, id: number, parent: number, lineage: number) =>
    f.states.set(id, { stateId: id, parentStateId: parent, lineageName: lineage });

  it('C1: a spurious OVER closure entry must NOT drag a non-universal state into graduation', async () => {
    // 0 <- 1 <- 2 (DEFAULT); 1 <- 3 <- 4 (v). LCA(2,4) = 1, so only state 1 is
    // graduable. State 2's edit belongs to DEFAULT only. We inject a spurious
    // closure row claiming state 2 is in v's lineage. A closure-based prefix
    // would then admit state 2 and graduate DEFAULT's private edit into the
    // shared base (visible to v — corruption). The parent-walk prefix ignores it.
    const f = new Fabric();
    st(f, 1, 0, 1);
    st(f, 2, 1, 2); // DEFAULT tip
    st(f, 3, 1, 3);
    st(f, 4, 3, 3); // v tip
    f.versions.set('DEFAULT', 2);
    f.versions.set('v', 4);
    // correct closures
    f.lineages.add('2:1'); f.lineages.add('2:2');
    f.lineages.add('3:1'); f.lineages.add('3:3'); f.lineages.add('3:4');
    // OVER poison: claim state 2 is an ancestor in v's lineage (name 3)
    f.lineages.add('3:2');
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'base' });
    t.adds.set('100:2', { oid: 100, state: 2, values: { VAL: 'default-only' } });
    await materialize(conn, f);

    const prefix = await computeGraduablePrefix(conn);
    expect(prefix.has(2)).toBe(false);   // state 2 is NOT a common ancestor
    expect([...prefix].sort()).toEqual([1]);
    await graduateTable(conn, PARCELS, prefix);

    const base = await conn.query<{ VAL: string | null }>(`SELECT VAL FROM dbo.base18 WHERE OBJECTID=100;`);
    expect(base[0]!.VAL).toBe('base'); // DEFAULT's private edit never reached base
  });

  it('C5: readLockedBranches expands a lock to ancestors (up) and descendants (down) via the parent walk', async () => {
    // 0 <- 1 <- 2 <- 3 <- 4 ; lock state 2. Protected = {2} ∪ ancestors{1} ∪ descendants{3,4}.
    const f = new Fabric();
    st(f, 1, 0, 1); st(f, 2, 1, 1); st(f, 3, 2, 1); st(f, 4, 3, 1);
    f.versions.set('v', 4);
    f.locks.add(2);
    await materialize(conn, f);

    const locked = await readLockedBranches(conn);
    expect([...locked].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('C5: a locked middle state and its branch survive collapse', async () => {
    // 0 <- 1 <- 2 <- 3 (v). Lock 2. Collapse must not touch the locked branch.
    const f = new Fabric();
    st(f, 1, 0, 1); st(f, 2, 1, 1); st(f, 3, 2, 1);
    f.versions.set('v', 3);
    f.locks.add(2);
    await materialize(conn, f);

    await collapseLineages(conn, [PARCELS]);
    const live = await liveStateIds(conn);
    expect(live.has(2)).toBe(true);
  });

  it('N5: state 0 is never a collapse parent (its single child stays put)', async () => {
    // 0 <- 5 (unreferenced, non-tip) <- 6 (leaf). 5 is 0's only child. Collapsing
    // 5 into 0 would push 5's edits into base unconditionally. Must not happen.
    const f = new Fabric();
    st(f, 1, 0, 1); f.versions.set('v', 1); // a real version so 0 has 2 children (1 and 5)
    st(f, 5, 0, 5); st(f, 6, 5, 5);
    f.table('parcels').adds.set('100:5', { oid: 100, state: 5, values: { VAL: 'orphan' } });
    await materialize(conn, f);

    await collapseLineages(conn, [PARCELS]);
    // 5 might collapse 6 into itself (5 is a non-tip, non-zero single-child parent
    // of 6) — that's fine — but 5 must never collapse INTO state 0.
    const base = await conn.query(`SELECT VAL FROM dbo.base18 WHERE OBJECTID=100;`);
    expect(base.length).toBe(0); // orphan edit never reached base via a collapse-into-0
  });
});
