/**
 * Grown-topology operation generator for the property-based compress sweep
 * (COMPRESS_HARDENING_PLAN.md §6 Layer 2 + §6.3 "Grown" mode).
 *
 * A random op-log is applied to a reference-model `Fabric` ONLY. The same model
 * then (a) seeds the synthetic DB via `materialize` and (b) is compressed by the
 * obviously-correct `compressRef`, so the DB compress and the oracle can be
 * compared. The point of *generating* topologies rather than hand-enumerating a
 * dozen is that every compress defect is topology-dependent — a random state
 * tree exercises prune/collapse/graduate shapes nobody thought to write down.
 *
 * Fidelity that matters: `newEdit` reimplements Esri `SDE_state_new_edit`'s
 * lineage allocation — reuse the parent's `lineage_name` when the parent is
 * childless (a linear run), else allocate a fresh name and copy the parent's
 * closure. `lineage_name` is exactly the variable C3/N6/N7 turn on, so a grown
 * tree keeps `states_cuk(parent_state_id, lineage_name)` satisfiable by
 * construction and the closure clean (divergence is a separate, injected story).
 *
 * Deliberately NOT generated here: state locks (their prune/collapse protection
 * is exercised by the dedicated rootfix C5 scenarios, where oracle and impl lock
 * semantics are asserted directly) and trim-post base-shadow markers (C0, covered
 * by graduate-collapse.test.ts). Keeping those out of the sweep avoids asserting
 * the oracle against itself on the two areas the named scenarios already pin down.
 */
import { Fabric, type StateId, type Oid } from './reference-model';

/** Deterministic PRNG so a failing seed reproduces + shrinks exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Op =
  | { kind: 'createVersion'; from: string; name: string }
  | { kind: 'edit'; version: string; op: 'add' | 'update' | 'delete'; oid: Oid }
  | { kind: 'abandon'; version: string }
  | { kind: 'mergeToDefault'; version: string; discard: boolean };

const TABLE = 'parcels';

/**
 * A grower that owns id allocation and mirrors SDE_state_new_edit onto a Fabric.
 * Every mutation goes through here so the op-log is the single source of truth.
 */
export class Grower {
  nextState = 1;
  nextLineage = 1;
  nextOid = 100;
  readonly log: Op[] = [];

  constructor(public f: Fabric) {}

  private childCount(parent: StateId): number {
    let n = 0;
    for (const s of this.f.states.values()) if (s.stateId !== 0 && s.parentStateId === parent) n++;
    return n;
  }

  /** Faithful SDE_state_new_edit: allocate a child of `parent`, maintain closure. */
  private newEdit(parent: StateId): StateId {
    const child = this.nextState++;
    const parentRow = this.f.states.get(parent)!;
    let lineageName: number;
    // Parent 0 (the base) occupies (parent=0, lineage_name=0) itself, so a child
    // can never reuse lineage_name 0 — it would collide with state 0 on
    // states_cuk. Every edit state off the base gets a fresh lineage_name.
    if (parent !== 0 && this.childCount(parent) === 0) {
      // Linear run: child shares the parent's lineage_name; extend the closure.
      lineageName = parentRow.lineageName;
      this.f.lineages.add(`${lineageName}:${child}`);
    } else {
      // Branch: fresh lineage_name; copy the parent's closure under it, then self.
      lineageName = this.nextLineage++;
      for (const key of [...this.f.lineages]) {
        const [ln, lid] = key.split(':');
        if (Number(ln) === parentRow.lineageName) this.f.lineages.add(`${lineageName}:${lid}`);
      }
      this.f.lineages.add(`${lineageName}:${child}`);
    }
    this.f.states.set(child, { stateId: child, parentStateId: parent, lineageName });
    return child;
  }

  /** DEFAULT starts at a first real edit state so graduation has somewhere to go. */
  seedDefault(): void {
    const s = this.newEdit(0);
    this.f.versions.set('DEFAULT', s);
  }

  createVersion(from: string, name: string): void {
    const tip = this.f.versions.get(from);
    if (tip == null || this.f.versions.has(name)) return;
    this.f.versions.set(name, tip); // new version shares the parent's tip state
    this.log.push({ kind: 'createVersion', from, name });
  }

  edit(version: string, op: 'add' | 'update' | 'delete', oid: Oid): void {
    const tip = this.f.versions.get(version);
    if (tip == null) return;
    const t = this.f.table(TABLE);
    const child = this.newEdit(tip);
    this.f.versions.set(version, child);
    if (op === 'add') t.adds.set(`${oid}:${child}`, { oid, state: child, values: { VAL: `v${child}` } });
    else if (op === 'update') t.adds.set(`${oid}:${child}`, { oid, state: child, values: { VAL: `u${child}` } });
    else t.dels.push({ oid, state: child, deletedAt: child });
    this.log.push({ kind: 'edit', version, op, oid });
  }

  abandon(version: string): void {
    if (version === 'DEFAULT' || !this.f.versions.has(version)) return;
    this.f.versions.delete(version); // tip states become prune candidates
    this.log.push({ kind: 'abandon', version });
  }

  /**
   * Simplified trim-post: replay `version`'s private edits (states not shared
   * with DEFAULT) onto DEFAULT as a fresh linear run, so DEFAULT ends up with a
   * collapsible chain. Optionally discard the source version afterward.
   */
  mergeToDefault(version: string, discard: boolean): void {
    if (version === 'DEFAULT' || !this.f.versions.has(version)) return;
    const vTip = this.f.versions.get(version)!;
    const defTip = this.f.versions.get('DEFAULT')!;
    const defAnc = new Set(this.f.ancestors(defTip));
    const priv = this.f.ancestors(vTip).filter(s => !defAnc.has(s)).reverse(); // oldest first
    const t = this.f.table(TABLE);
    for (const s of priv) {
      const newDef = this.newEdit(this.f.versions.get('DEFAULT')!);
      this.f.versions.set('DEFAULT', newDef);
      for (const a of t.adds.values()) if (a.state === s) t.adds.set(`${a.oid}:${newDef}`, { oid: a.oid, state: newDef, values: { ...a.values } });
      for (const d of t.dels) if (d.state === s) t.dels.push({ oid: d.oid, state: newDef, deletedAt: newDef });
    }
    if (discard) this.f.versions.delete(version);
    this.log.push({ kind: 'mergeToDefault', version, discard });
  }
}

/** Build a fresh Fabric by running an explicit op-log (used by the shrinker). */
export function applyLog(log: Op[]): Fabric {
  const f = new Fabric();
  const g = new Grower(f);
  g.seedDefault();
  for (const op of log) {
    switch (op.kind) {
      case 'createVersion': g.createVersion(op.from, op.name); break;
      case 'edit': g.edit(op.version, op.op, op.oid); break;
      case 'abandon': g.abandon(op.version); break;
      case 'mergeToDefault': g.mergeToDefault(op.version, op.discard); break;
    }
  }
  return f;
}

/** Generate a random op-log of `len` steps from `seed`, returning model + log. */
export function generate(seed: number, len: number): { fabric: Fabric; log: Op[] } {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]): T | undefined => (xs.length ? xs[Math.floor(rnd() * xs.length)] : undefined);
  const f = new Fabric();
  const g = new Grower(f);
  g.seedDefault();
  let vc = 0;
  const liveOids = new Set<Oid>();

  for (let i = 0; i < len; i++) {
    const versions = [...f.versions.keys()];
    const nonDefault = versions.filter(v => v !== 'DEFAULT');
    const r = rnd();
    if (r < 0.25 && versions.length < 5) {
      g.createVersion(pick(versions)!, `v${vc++}`);
    } else if (r < 0.75) {
      const version = pick(versions)!;
      const opR = rnd();
      if (opR < 0.5 || liveOids.size === 0) { const oid = g.nextOid++; g.edit(version, 'add', oid); liveOids.add(oid); }
      else if (opR < 0.8) { g.edit(version, 'update', pick([...liveOids])!); }
      else { const oid = pick([...liveOids])!; g.edit(version, 'delete', oid); liveOids.delete(oid); }
    } else if (r < 0.88 && nonDefault.length) {
      g.abandon(pick(nonDefault)!);
    } else if (nonDefault.length) {
      g.mergeToDefault(pick(nonDefault)!, rnd() < 0.5);
    }
  }
  return { fabric: f, log: g.log };
}
