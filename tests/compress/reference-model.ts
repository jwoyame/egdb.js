/**
 * A pure in-memory reference model of an ArcSDE traditional-versioning fabric,
 * plus an "obviously correct by inspection" reference implementation of compress.
 *
 * This is the ORACLE for the compress test suite. It contains no SQL. Every
 * database-backed compress test asserts that the real implementation's post-state
 * matches `compressRef(model)` up to a state-id renaming.
 *
 * Truth is defined by the parent_state_id walk (never the closure). The closure
 * (`lineages`) is modelled separately and is deliberately allowed to diverge, so
 * that scenarios can inject UNDER / OVER divergence exactly as the live fabric has.
 *
 * See openparcels/handoff/COMPRESS_HARDENING_PLAN.md §6 Layer 1.
 */

export type StateId = number;
export type Oid = number;

export interface StateRow {
  stateId: StateId;
  parentStateId: StateId; // 0 == base
  lineageName: number;    // allocated from the same id space as state ids
}

/** One versioned table's delta tables + base, keyed the way SDE keys them. */
export interface TableModel {
  /** base rows: OBJECTID -> column values (state 0 snapshot) */
  base: Map<Oid, Record<string, unknown>>;
  /** adds: `${oid}:${state}` -> column values */
  adds: Map<string, { oid: Oid; state: StateId; values: Record<string, unknown> }>;
  /** deletes: list of markers. state is SDE_STATE_ID; deletedAt is DELETED_AT. */
  dels: Array<{ oid: Oid; state: StateId; deletedAt: StateId }>;
}

const akey = (oid: Oid, state: StateId) => `${oid}:${state}`;

export class Fabric {
  states = new Map<StateId, StateRow>();
  /** closure cache: set of `${lineageName}:${lineageId}` pairs. May diverge. */
  lineages = new Set<string>();
  /** version name -> tip state id */
  versions = new Map<string, StateId>();
  /** locked state ids (active EditSessions) */
  locks = new Set<StateId>();
  tables = new Map<string, TableModel>();

  constructor() {
    // Base state always exists.
    this.states.set(0, { stateId: 0, parentStateId: 0, lineageName: 0 });
    this.lineages.add('0:0');
  }

  table(name: string): TableModel {
    let t = this.tables.get(name);
    if (!t) { t = { base: new Map(), adds: new Map(), dels: [] }; this.tables.set(name, t); }
    return t;
  }

  // --- structural truth (parent walk) ---------------------------------------

  /** Ancestors of `state` INCLUDING itself, EXCLUDING base 0, via parent_state_id. */
  ancestors(state: StateId): StateId[] {
    const out: StateId[] = [];
    let s = state;
    const seen = new Set<StateId>();
    while (s !== 0) {
      if (seen.has(s)) throw new Error(`cycle in parent_state_id at ${s}`);
      seen.add(s);
      out.push(s);
      const row = this.states.get(s);
      if (!row) break; // dangling parent
      s = row.parentStateId;
    }
    return out;
  }

  /** Set of every state reachable (as an ancestor) from any version tip. */
  reachableFromAnyTip(): Set<StateId> {
    const r = new Set<StateId>();
    for (const tip of this.versions.values()) for (const a of this.ancestors(tip)) r.add(a);
    return r;
  }

  /** Lowest common ancestor of all version tips (0 if they only share base). */
  lcaOfAllTips(): StateId {
    const tips = [...this.versions.values()];
    if (tips.length === 0) return 0;
    // intersection of ancestor-sets (including the tip), then the max (deepest).
    let inter = new Set<StateId>([0, ...this.ancestors(tips[0]!)]);
    for (const t of tips.slice(1)) {
      const a = new Set<StateId>([0, ...this.ancestors(t)]);
      inter = new Set([...inter].filter(x => a.has(x)));
    }
    return Math.max(0, ...inter);
  }

  // --- read semantics (what a "visible" row is) -----------------------------

  /**
   * egdb's versioned read: resolve OID in `version` via the parent walk.
   * Mirrors enterprise-table.ts:502-530 — base row unless deleted-in-lineage or
   * superseded by an add; else the MAX-state add not deleted-after.
   */
  resolveEgdb(t: TableModel, version: string, oid: Oid): Record<string, unknown> | null {
    const tip = this.versions.get(version);
    if (tip == null) throw new Error(`no such version ${version}`);
    return this.resolveInLineage(t, new Set(this.ancestors(tip)), oid);
  }

  /**
   * Resolve `oid` against an explicit set of edit states (excludes base 0),
   * using egdb's read rule. Shared by `resolveEgdb` (lineage = ancestors(tip))
   * and by graduation (lineage = the graduable prefix = ancestors(LCA)).
   */
  resolveInLineage(t: TableModel, lineage: Set<StateId>, oid: Oid): Record<string, unknown> | null {
    // adds half: the MAX-state add in the lineage, not suppressed by a delete at
    // a STRICTLY greater state (a delete-after-add). A base-shadow marker
    // (state 0) never suppresses an add — it only retires the base row.
    let best: { state: StateId; values: Record<string, unknown> } | null = null;
    for (const a of t.adds.values()) {
      if (a.oid !== oid || !lineage.has(a.state)) continue;
      const suppressed = t.dels.some(d => d.oid === oid && d.state !== 0 && lineage.has(d.state) && d.state > a.state);
      if (suppressed) continue;
      if (!best || a.state > best.state) best = { state: a.state, values: a.values };
    }
    if (best) return best.values;
    // no surviving add: base row, hidden if a delete marker's DELETED_AT is in
    // the lineage, or an add exists in the lineage (superseded).
    const deletedInLineage = t.dels.some(d => d.oid === oid && lineage.has(d.deletedAt));
    const hasAddInLineage = [...t.adds.values()].some(a => a.oid === oid && lineage.has(a.state));
    if (deletedInLineage || hasAddInLineage) return null;
    const b = t.base.get(oid);
    return b ?? null;
  }

  /** Every OID visible in `version` via egdb semantics, as oid->values. */
  visibleEgdb(t: TableModel, version: string): Map<Oid, Record<string, unknown>> {
    const oids = new Set<Oid>();
    for (const oid of t.base.keys()) oids.add(oid);
    for (const a of t.adds.values()) oids.add(a.oid);
    const out = new Map<Oid, Record<string, unknown>>();
    for (const oid of oids) { const r = this.resolveEgdb(t, version, oid); if (r) out.set(oid, r); }
    return out;
  }

  /** Full structural snapshot of every version's visible data, for before/after diff. */
  snapshotVisible(): Map<string, Map<string, Map<Oid, Record<string, unknown>>>> {
    const out = new Map<string, Map<string, Map<Oid, Record<string, unknown>>>>();
    for (const v of this.versions.keys()) {
      const perTable = new Map<string, Map<Oid, Record<string, unknown>>>();
      for (const [tn, t] of this.tables) perTable.set(tn, this.visibleEgdb(t, v));
      out.set(v, perTable);
    }
    return out;
  }

  clone(): Fabric {
    const f = new Fabric();
    f.states = new Map([...this.states].map(([k, v]) => [k, { ...v }]));
    f.lineages = new Set(this.lineages);
    f.versions = new Map(this.versions);
    f.locks = new Set(this.locks);
    f.tables = new Map([...this.tables].map(([n, t]) => [n, {
      base: new Map([...t.base].map(([o, r]) => [o, { ...r }])),
      adds: new Map([...t.adds].map(([k, a]) => [k, { ...a, values: { ...a.values } }])),
      dels: t.dels.map(d => ({ ...d })),
    }]));
    return f;
  }
}

// ---------------------------------------------------------------------------
// The reference compress — obviously correct by inspection, no SQL.
// prefix = ancestors(LCA(tips)) ∪ {LCA};  prune = unreachable leaves, iterated;
// collapse = non-tip child of a single-child non-tip non-zero parent, one at a time.
// ---------------------------------------------------------------------------

export interface CompressRefResult {
  graduated: number;
  pruned: number;
  collapsed: number;
}

export function compressRef(f: Fabric): CompressRefResult {
  const res: CompressRefResult = { graduated: 0, pruned: 0, collapsed: 0 };

  // ---- graduate: make base = what every version resolves at the LCA --------
  // The graduable prefix is exactly ancestors(LCA(all tips)); a state's delta is
  // "common to every version" iff it is in that prefix. For each affected OID we
  // set base to what egdb resolves through the prefix (this is what makes an
  // UPDATE land its new value AND correctly drop the base-shadow marker — C0),
  // then remove every delta whose state OR whose DELETED_AT is in the prefix
  // (the latter clears SDE_STATE_ID=0 shadow markers — the C0 fix).
  const lca = f.lcaOfAllTips();
  const prefix = new Set<StateId>(lca === 0 ? [] : [...f.ancestors(lca)]); // single chain
  if (prefix.size > 0) {
    for (const t of f.tables.values()) {
      const affected = new Set<Oid>();
      for (const a of t.adds.values()) if (prefix.has(a.state)) affected.add(a.oid);
      for (const d of t.dels) if (prefix.has(d.state) || prefix.has(d.deletedAt)) affected.add(d.oid);
      for (const oid of affected) {
        const resolved = f.resolveInLineage(t, prefix, oid);
        if (resolved == null) t.base.delete(oid); else t.base.set(oid, { ...resolved });
        res.graduated++;
      }
      for (const [k, a] of [...t.adds]) if (prefix.has(a.state)) t.adds.delete(k);
      t.dels = t.dels.filter(d => !(prefix.has(d.state) || prefix.has(d.deletedAt)));
    }
  }

  // ---- prune: unreachable, non-zero, leaf states; iterate ------------------
  for (;;) {
    const reachable = f.reachableFromAnyTip();
    const children = new Map<StateId, number>();
    for (const s of f.states.values()) if (s.stateId !== 0) children.set(s.parentStateId, (children.get(s.parentStateId) ?? 0) + 1);
    const victim = [...f.states.values()].find(s =>
      s.stateId !== 0 && !reachable.has(s.stateId) && (children.get(s.stateId) ?? 0) === 0 && !f.locks.has(s.stateId));
    if (!victim) break;
    const id = victim.stateId;
    for (const t of f.tables.values()) {
      for (const [k, a] of [...t.adds]) if (a.state === id) t.adds.delete(k);
      t.dels = t.dels.filter(d => d.state !== id && d.deletedAt !== id);
    }
    // delete closure by lineage_id only (never by lineage_name — N6).
    for (const key of [...f.lineages]) if (key.endsWith(`:${id}`)) f.lineages.delete(key);
    f.states.delete(id);
    res.pruned++;
  }

  // ---- collapse: single-child, non-tip, non-zero parent; child non-tip -----
  for (;;) {
    const tips = new Set(f.versions.values());
    const childrenOf = new Map<StateId, StateId[]>();
    for (const s of f.states.values()) if (s.stateId !== 0) {
      const arr = childrenOf.get(s.parentStateId) ?? []; arr.push(s.stateId); childrenOf.set(s.parentStateId, arr);
    }
    let pair: { parent: StateId; child: StateId } | null = null;
    for (const [parent, kids] of childrenOf) {
      if (parent === 0 || tips.has(parent) || kids.length !== 1) continue;
      const child = kids[0]!;
      if (tips.has(child)) continue;
      pair = { parent, child }; break;
    }
    if (!pair) break;
    const { parent, child } = pair;
    for (const t of f.tables.values()) {
      for (const [k, a] of [...t.adds]) if (a.state === child) { t.adds.delete(k); t.adds.set(akey(a.oid, parent), { ...a, state: parent }); }
      for (const d of t.dels) { if (d.state === child) d.state = parent; if (d.deletedAt === child) d.deletedAt = parent; }
    }
    for (const s of f.states.values()) if (s.parentStateId === child) s.parentStateId = parent;
    for (const [v, tip] of f.versions) if (tip === child) f.versions.set(v, parent);
    f.states.delete(child);
    res.collapsed++;
  }

  return res;
}
