/**
 * Self-tests for the reference model (the compress oracle). Everything here is
 * hand-verifiable — if these are right, the oracle can be trusted to judge the
 * real implementation. Pure TypeScript, no database.
 */
import { describe, it, expect } from 'vitest';
import { Fabric, compressRef, type StateId } from './reference-model';

/** Small helper: build a state as a child of `parent`, reusing/allocating a lineage. */
function addState(f: Fabric, id: StateId, parent: StateId, lineage: number) {
  f.states.set(id, { stateId: id, parentStateId: parent, lineageName: lineage });
  // maintain a correct closure by default (tests inject divergence explicitly)
  const parentClosure = [...f.lineages].filter(k => k.startsWith(`${f.states.get(parent)!.lineageName}:`))
    .map(k => Number(k.split(':')[1]));
  for (const lid of parentClosure) f.lineages.add(`${lineage}:${lid}`);
  f.lineages.add(`${lineage}:${id}`);
}

describe('reference model: read semantics', () => {
  it('base row is visible when nothing shadows it', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1);
    f.versions.set('DEFAULT', 1);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'base' });
    expect(f.resolveEgdb(t, 'DEFAULT', 100)).toEqual({ VAL: 'base' });
  });

  it('an add in lineage supersedes the base row; MAX state wins', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1); addState(f, 2, 1, 1);
    f.versions.set('DEFAULT', 2);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'base' });
    t.adds.set('100:1', { oid: 100, state: 1, values: { VAL: 'v1' } });
    t.adds.set('100:2', { oid: 100, state: 2, values: { VAL: 'v2_tip' } });
    expect(f.resolveEgdb(t, 'DEFAULT', 100)).toEqual({ VAL: 'v2_tip' });
  });

  it('a delete marker in lineage hides the base row', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1);
    f.versions.set('DEFAULT', 1);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'base' });
    t.dels.push({ oid: 100, state: 0, deletedAt: 1 }); // base-shadow marker
    expect(f.resolveEgdb(t, 'DEFAULT', 100)).toBeNull();
  });

  it('a delete AFTER an add suppresses the add (pure delete of an added row)', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1); addState(f, 2, 1, 1);
    f.versions.set('DEFAULT', 2);
    const t = f.table('parcels');
    t.adds.set('100:1', { oid: 100, state: 1, values: { VAL: 'v1' } });
    t.dels.push({ oid: 100, state: 2, deletedAt: 2 });
    expect(f.resolveEgdb(t, 'DEFAULT', 100)).toBeNull();
  });

  it('LCA of tips is the deepest common ancestor', () => {
    const f = new Fabric();
    // 1 -> 2 -> {3 (DEFAULT), 4 (v)}
    addState(f, 1, 0, 1); addState(f, 2, 1, 1); addState(f, 3, 2, 1); addState(f, 4, 2, 2);
    f.versions.set('DEFAULT', 3); f.versions.set('v', 4);
    expect(f.lcaOfAllTips()).toBe(2);
  });
});

describe('reference model: compressRef', () => {
  it('graduates a state common to every version into base', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1); addState(f, 2, 1, 1);
    f.versions.set('DEFAULT', 2); f.versions.set('v', 2);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'base' });
    t.adds.set('100:1', { oid: 100, state: 1, values: { VAL: 'graduated' } });
    compressRef(f);
    expect(t.base.get(100)).toEqual({ VAL: 'graduated' }); // moved to base
    expect([...t.adds.values()].some(a => a.oid === 100)).toBe(false); // delta removed
  });

  it('C0: graduating a posted UPDATE removes the base-shadow marker and keeps the row visible', () => {
    // The exact live bug: an update writes a new A-row at state S plus an Esri
    // base-shadow marker (oid, state=0, deletedAt=S). Both S and DEFAULT share
    // the graduable prefix. A correct compress must land the new value in base
    // AND drop the shadow marker, so the parcel stays visible. The BUGGY impl
    // keeps the marker and the parcel vanishes — this test pins the correct oracle.
    const f = new Fabric();
    addState(f, 1, 0, 1);
    f.versions.set('DEFAULT', 1);
    const t = f.table('parcels');
    t.base.set(100, { VAL: 'old' });
    t.adds.set('100:1', { oid: 100, state: 1, values: { VAL: 'new' } });
    t.dels.push({ oid: 100, state: 0, deletedAt: 1 }); // base-shadow marker
    compressRef(f);
    // base updated to the new value, shadow marker gone, parcel still visible.
    expect(t.base.get(100)).toEqual({ VAL: 'new' });
    expect(t.dels.length).toBe(0);
    expect(f.resolveEgdb(t, 'DEFAULT', 100)).toEqual({ VAL: 'new' });
  });

  it('prunes an unreachable orphan leaf but keeps reachable states', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1); addState(f, 2, 1, 1); addState(f, 9, 1, 3); // 9 is an orphan leaf
    f.versions.set('DEFAULT', 2);
    const t = f.table('parcels');
    t.adds.set('50:9', { oid: 50, state: 9, values: { VAL: 'orphaned' } });
    const r = compressRef(f);
    expect(f.states.has(9)).toBe(false);
    expect(f.states.has(2)).toBe(true);
    expect(r.pruned).toBe(1);
  });

  it('never prunes state 0 or a version tip', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1);
    f.versions.set('DEFAULT', 1);
    compressRef(f);
    expect(f.states.has(0)).toBe(true);
    expect(f.states.has(1)).toBe(true);
  });

  it('collapses a linear run but not into a version tip and not into state 0', () => {
    const f = new Fabric();
    // 0 <- 1(DEFAULT) <- 2 <- 3(v). 2 is a collapsible middle; 1 is a tip so 2
    // must NOT collapse into 1; 3 is a tip so it stays.
    addState(f, 1, 0, 1); addState(f, 2, 1, 1); addState(f, 3, 2, 1);
    f.versions.set('DEFAULT', 1); f.versions.set('v', 3);
    const t = f.table('parcels');
    t.adds.set('100:2', { oid: 100, state: 2, values: { VAL: 'mid' } });
    compressRef(f);
    // 2 cannot collapse (its parent 1 is a tip); nothing collapses here.
    expect(f.states.has(2)).toBe(true);
    // v still resolves the edit made at 2.
    expect(f.resolveEgdb(t, 'v', 100)).toEqual({ VAL: 'mid' });
  });

  it('visible data is unchanged by compress (the core property) on a simple fabric', () => {
    const f = new Fabric();
    addState(f, 1, 0, 1); addState(f, 2, 1, 1);
    f.versions.set('DEFAULT', 2); f.versions.set('v', 2);
    const t = f.table('parcels');
    t.base.set(1, { VAL: 'a' });
    t.base.set(2, { VAL: 'b' });
    t.adds.set('1:1', { oid: 1, state: 1, values: { VAL: 'a2' } });
    const before = f.snapshotVisible();
    compressRef(f);
    const after = f.snapshotVisible();
    expect(after).toEqual(before);
  });
});
