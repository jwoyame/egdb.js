/**
 * Rebase-specific fixtures and the two-part content oracle.
 *
 * The compress harness's `assertVisibleDataUnchanged` is the WRONG oracle for a
 * rebase: a rebase catches a version up to its parent's tip, so a non-editor OID
 * *legitimately* changes to DEFAULT's newer value. The correct statement is
 * two-part (COMPRESS_HARDENING_PLAN.md is silent on rebase; this is from the
 * rebase harness design):
 *   (i)  every OID the editor touched resolves as it did before, and
 *   (ii) every other OID resolves to the PARENT tip's value.
 * Equivalently: after == (parent tip's visible set) with the editor's edits
 * overlaid. That single expected map is what `expectedAfterRebase` builds.
 */

import { Fabric } from '../compress/reference-model';

export interface RebaseFixture {
  f: Fabric;
  /** owner.name as materialize writes it (owner defaults to 'test'). */
  version: string;
  parent: string;
  /** OIDs the editor created/edited in the version's own states. */
  editorOids: number[];
}

/**
 * A compress-orphan: DEFAULT advanced on its own branch while version V is stuck
 * on a base-rooted state that shares ONLY the base with DEFAULT — Alex's exact
 * live shape. DEFAULT edits OID 1; V inserts a new OID 100. Before a rebase V
 * cannot see DEFAULT's edit to OID 1; after a correct rebase it must.
 */
export function buildOrphan(): RebaseFixture {
  const f = new Fabric();
  const t = f.table('parcels');
  t.base.set(1, { VAL: 'base1' });

  // DEFAULT:  0 <- 10 <- 11   (edits OID 1 at state 11)
  f.states.set(10, { stateId: 10, parentStateId: 0, lineageName: 10 });
  f.states.set(11, { stateId: 11, parentStateId: 10, lineageName: 10 });
  f.lineages.add('10:0'); f.lineages.add('10:10'); f.lineages.add('10:11');
  f.versions.set('DEFAULT', 11);
  t.adds.set('1:11', { oid: 1, state: 11, values: { VAL: 'default-new' } });

  // Orphan version V:  0 <- 5   (inserts OID 100 at state 5)
  f.states.set(5, { stateId: 5, parentStateId: 0, lineageName: 5 });
  f.lineages.add('5:0'); f.lineages.add('5:5');
  f.versions.set('V', 5);
  t.adds.set('100:5', { oid: 100, state: 5, values: { VAL: 'alex' } });

  return { f, version: 'test.V', parent: 'test.DEFAULT', editorOids: [100] };
}

/**
 * The version's expected visible set after a correct rebase: the parent tip's
 * visible set, with the editor's own OIDs overlaid from the pre-rebase version
 * view (present -> kept, absent -> deleted).
 */
export function expectedAfterRebase(
  versionBefore: Map<number, string | null>,
  parentVisible: Map<number, string | null>,
  editorOids: number[],
): Map<number, string | null> {
  const expected = new Map(parentVisible);
  for (const oid of editorOids) {
    if (versionBefore.has(oid)) expected.set(oid, versionBefore.get(oid)!);
    else expected.delete(oid);
  }
  return expected;
}

export function diffMaps(
  expected: Map<number, string | null>,
  actual: Map<number, string | null>,
): string[] {
  const problems: string[] = [];
  for (const [oid, v] of expected) {
    if (!actual.has(oid)) problems.push(`OID ${oid}: expected ${JSON.stringify(v)}, missing`);
    else if (actual.get(oid) !== v) problems.push(`OID ${oid}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual.get(oid))}`);
  }
  for (const oid of actual.keys()) {
    if (!expected.has(oid)) problems.push(`OID ${oid}: unexpected ${JSON.stringify(actual.get(oid))}`);
  }
  return problems;
}
