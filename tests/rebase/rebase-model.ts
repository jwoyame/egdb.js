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
 * DEFECT D fixture. A compress-orphan carrying STALE RECONCILE RESIDUE, mixed
 * with genuine editor work, so a correct rebase must tell them apart:
 *
 *   base (common ancestor, state 0):  OID 1='base1'  OID 5='A'  OID 7='G'
 *   DEFAULT (0<-10<-11):              OID 1->'default-new' (11), OID 5: 'A'->'B' (10) ->'C' (11)
 *   Version V (0<-5):                 OID 5='B' (residue), OID 7='alex7' (edit), OID 100='alex' (insert)
 *
 * Three-way against the ancestor (base):
 *   - OID 1: editor untouched, DEFAULT changed -> after rebase = 'default-new'.
 *   - OID 5: child 'B' != anc 'A', parent 'C' != anc 'A', child != parent -> CONFLICT.
 *            (Tip-only comparison would REPLAY 'B' and revert DEFAULT's 'C' on post.)
 *   - OID 7: child 'alex7' != anc 'G', parent == anc (untouched) -> editor change, KEEP.
 *   - OID 100: insert, absent at anc -> KEEP.
 */
export function buildResidueConflict(): RebaseFixture {
  const f = new Fabric();
  const t = f.table('parcels');
  t.base.set(1, { VAL: 'base1' });
  t.base.set(5, { VAL: 'A' });
  t.base.set(7, { VAL: 'G' });

  // DEFAULT: 0 <- 10 <- 11
  f.states.set(10, { stateId: 10, parentStateId: 0, lineageName: 10 });
  f.states.set(11, { stateId: 11, parentStateId: 10, lineageName: 10 });
  f.lineages.add('10:0'); f.lineages.add('10:10'); f.lineages.add('10:11');
  f.versions.set('DEFAULT', 11);
  t.adds.set('5:10', { oid: 5, state: 10, values: { VAL: 'B' } });   // OID5 A->B
  t.adds.set('5:11', { oid: 5, state: 11, values: { VAL: 'C' } });   // OID5 B->C (tip)
  t.adds.set('1:11', { oid: 1, state: 11, values: { VAL: 'default-new' } });

  // Orphan version V: 0 <- 5, holding residue + genuine work.
  f.states.set(5, { stateId: 5, parentStateId: 0, lineageName: 5 });
  f.lineages.add('5:0'); f.lineages.add('5:5');
  f.versions.set('V', 5);
  t.adds.set('5:5', { oid: 5, state: 5, values: { VAL: 'B' } });      // residue (was DEFAULT's 'B')
  t.adds.set('7:5', { oid: 7, state: 5, values: { VAL: 'alex7' } });  // genuine edit
  t.adds.set('100:5', { oid: 100, state: 5, values: { VAL: 'alex' } }); // genuine insert

  return { f, version: 'test.V', parent: 'test.DEFAULT', editorOids: [5, 7, 100] };
}

/**
 * DEFECT E fixture (editor deletes). A compress-orphan whose editor both CREATED-
 * THEN-DELETED a feature and DELETED a reconcile-copied one, mixed with a genuine
 * insert. A correct rebase must neither resurrect nor lose either delete.
 *
 *   base (ancestor):     OID 1='base1'  OID 300='X'
 *   DEFAULT (0<-10<-11): OID 1 -> 'default-new'; 300 untouched
 *   Version V (0<-5<-6):
 *     state 5: insert 100='alex', insert 200='new200', residue 300='X'
 *     state 6: delete 200 (after its own add), delete 300 (after the reconcile copy)
 *
 * Correct rebase:
 *   - OID 200: created then deleted -> absent both sides -> DROP (no resurrect).
 *   - OID 300: child absent, parent present -> emit a DELETE marker (no vanish).
 *   - OID 100: genuine insert -> REPLAY. OID 1: editor-untouched -> DEFAULT's tip.
 */
export function buildEditorDeletes(): RebaseFixture {
  const f = new Fabric();
  const t = f.table('parcels');
  t.base.set(1, { VAL: 'base1' });
  t.base.set(300, { VAL: 'X' });

  // DEFAULT: 0 <- 10 <- 11
  f.states.set(10, { stateId: 10, parentStateId: 0, lineageName: 10 });
  f.states.set(11, { stateId: 11, parentStateId: 10, lineageName: 10 });
  f.lineages.add('10:0'); f.lineages.add('10:10'); f.lineages.add('10:11');
  f.versions.set('DEFAULT', 11);
  t.adds.set('1:11', { oid: 1, state: 11, values: { VAL: 'default-new' } });

  // Orphan V: 0 <- 5 <- 6
  f.states.set(5, { stateId: 5, parentStateId: 0, lineageName: 5 });
  f.states.set(6, { stateId: 6, parentStateId: 5, lineageName: 5 });
  f.lineages.add('5:0'); f.lineages.add('5:5'); f.lineages.add('5:6');
  f.versions.set('V', 6);
  t.adds.set('100:5', { oid: 100, state: 5, values: { VAL: 'alex' } });
  t.adds.set('200:5', { oid: 200, state: 5, values: { VAL: 'new200' } });
  t.adds.set('300:5', { oid: 300, state: 5, values: { VAL: 'X' } }); // reconcile residue
  // delete-after-add (SDE_STATE_ID 6 > add state 5, DELETED_AT 6 in the lineage):
  t.dels.push({ oid: 200, state: 6, deletedAt: 6 });
  t.dels.push({ oid: 300, state: 6, deletedAt: 6 });

  return { f, version: 'test.V', parent: 'test.DEFAULT', editorOids: [100, 200, 300] };
}

/**
 * DEFECT E / vet-#4 fixture (delete/update conflict). DEFAULT deleted a feature the
 * editor edited -- neither side can silently win.
 *
 *   base (ancestor):     OID 400='Y'
 *   DEFAULT (0<-10<-11): DELETE 400 (base row, DELETED_AT in a DEFAULT state)
 *   Version V (0<-5):    edit 400 -> 'alex400'
 *
 * child present ('alex400'), ancestor present ('Y'), parent ABSENT (deleted) ->
 * child != anc, parent != anc, child != parent -> CONFLICT. favour-edit replays
 * the editor's value (resurrecting 400 in the version, its owner's choice).
 */
export function buildParentDeleteConflict(): RebaseFixture {
  const f = new Fabric();
  const t = f.table('parcels');
  t.base.set(400, { VAL: 'Y' });

  // DEFAULT: 0 <- 10 <- 11, deletes base OID 400 at state 11.
  f.states.set(10, { stateId: 10, parentStateId: 0, lineageName: 10 });
  f.states.set(11, { stateId: 11, parentStateId: 10, lineageName: 10 });
  f.lineages.add('10:0'); f.lineages.add('10:10'); f.lineages.add('10:11');
  f.versions.set('DEFAULT', 11);
  t.dels.push({ oid: 400, state: 0, deletedAt: 11 }); // base delete: DELETED_AT in DEFAULT

  // Orphan V: 0 <- 5, edits OID 400.
  f.states.set(5, { stateId: 5, parentStateId: 0, lineageName: 5 });
  f.lineages.add('5:0'); f.lineages.add('5:5');
  f.versions.set('V', 5);
  t.adds.set('400:5', { oid: 400, state: 5, values: { VAL: 'alex400' } });

  return { f, version: 'test.V', parent: 'test.DEFAULT', editorOids: [400] };
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
