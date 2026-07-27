# SDE Compress — Technical Specification for Traditional Versioning

**Status:** Reverse-engineered specification distilled from Esri primary documentation and empirically validated against Putnam County's `parcel_fabric_test` (SDE 10.5.1, SQL Server, 245k parcels). Intended for an engineer implementing Compress from scratch in a third-party library (egdb.js).
**Scope:** Traditional versioning only. Branch versioning and non-versioned geodatabases are out of scope (Compress does not apply to them).
**Backends:** SQL Server and PostgreSQL (Enterprise geodatabase).
**Last review:** 2026-06-14.
**Validation note:** the EMPIRICAL findings from the Putnam validation run revise three documented claims that were originally INFERRED:
  - the "self-row invariant" in `SDE_state_lineages` is NOT a real SDE invariant (only egdb.js writes self-rows when creating new states via `createChildState`; 161 of 163 surviving Putnam states had no self-row). The downstream effect is that any closure query must explicitly UNION each tip into its own closure;
  - `SDE_state_lineages.lineage_name` is NOT a state_id. It is a separate tree-grouping identifier stored in `SDE_states.lineage_name`. Multiple version tips can share a `lineage_name` (Putnam: states 24814, 25008, 25066 all have `lineage_name = 24542`);
  - within a single `lineage_name`, `state_id` IS lineage order from root to tip (the well-known global-monotonicity caveat only applies ACROSS different `lineage_name` trees). The existing `find-ancestor.ts` and `getVersionStateLineage` queries exploit this with `lineage_id <= state_id` filters.

Throughout this document:
- **DOCUMENTED** = directly stated in an Esri primary source (cited inline).
- **INFERRED** = consistent with primary sources and the on-disk schema, but not explicitly stated.
- **UNKNOWN / AMBIGUOUS** = the public docs do not say, and we should not paper over it.

---

## 1. Scope and Applicability

- Compress applies **only to traditional (state-based) versioning**. It is explicitly **not applicable** to non-versioned enterprise geodatabases and **not applicable** to branch versioning. [DOCUMENTED — pro.arcgis.com Compress GP tool reference, https://pro.arcgis.com/en/pro-app/latest/tool-reference/data-management/compress.htm]
- The tool's stated purpose: "Compresses an enterprise geodatabase by removing states not referenced by a version and redundant rows." [DOCUMENTED — same source]
- Higher-level effect: "removes edits not referenced by a version and compresses edits common to all versions back to the business table, which increases the performance of the geodatabase." [DOCUMENTED — https://pro.arcgis.com/en/pro-app/latest/help/data/geodatabases/overview/recommended-version-administration-workflow.htm]

---

## 2. Inputs and Pre-conditions

### 2.1 Who can run it

- **Only the geodatabase administrator** (the `sde` user on SQL Server / PostgreSQL where the geodatabase is sde-schema, or `dbo` where the geodatabase is dbo-schema) may execute Compress. [DOCUMENTED — Compress GP tool reference]
- The Pro GP tool's only input is a **database connection file** authenticated as that administrator. [DOCUMENTED — same source]
- Implementation note for egdb.js: the connection must be made as the geodatabase administrator. Reject with a clear error if the connecting principal is not the geodatabase admin (we can verify by querying `sde.SDE_table_registry`'s owner of `SDE_versions`, or by checking `current_user`/`SYSTEM_USER` against the geodatabase admin recorded in `sde.SDE_server_config` / by attempting a metadata operation that the admin alone can perform).

### 2.2 What concurrent activity is allowed

- Concurrent **reads are permitted** during compress. Since ArcGIS 9.x, compress no longer takes a database-wide exclusive lock. [DOCUMENTED — ArcSDE 10.0 SDK, https://help.arcgis.com/en/geodatabase/10.0/sdk/arcsde/concepts/versioning/basicprinciples/compression.htm]
- **Active editors block compression of their branch.** "If any user is editing a version, the branch for that state is locked and will not take part in the compression." [DOCUMENTED — https://desktop.arcgis.com/en/arcmap/latest/manage-data/geodatabases/the-compress-operation-and-geodatabases.htm] The mechanism is the row(s) the editor holds in `sde.SDE_state_locks` for their version's state lineage; compress treats those branches as off-limits but proceeds on the rest of the tree. [INFERRED from the documented behaviour + the role of `SDE_state_locks`]
- For a **full** (maximally effective) compress, Esri's recommendation is: all child versions reconciled and posted to DEFAULT, child versions deleted, and no users connected. [DOCUMENTED — https://desktop.arcgis.com/en/arcmap/10.3/manage-data/gdbs-in-sql-server/geodatabase-compress-operation.htm]
- Reconcile+post is **strongly recommended but not strictly required**. Compress will run without it; it will simply do less work (it cannot graduate rows still referenced by an unposted child version). [DOCUMENTED — same source plus Pro recommended-version-administration-workflow]

### 2.3 Pre-flight checks egdb.js should perform

- [INFERRED, defensive] Verify connection identity is geodatabase admin.
- [INFERRED, defensive] Query `sde.SDE_state_locks` and warn the caller which versions are currently locked (those branches will be skipped).
- [INFERRED, defensive] Verify no other compress is in flight. There is no documented mutex, but two concurrent compresses are a recipe for state-tree corruption. Use an advisory lock (PostgreSQL `pg_advisory_lock`, SQL Server `sp_getapplock`) keyed on the geodatabase name.

---

## 3. The Three Phases of Compress

Esri's primary docs document Compress as a **three-step** operation (some doc pages summarise it as two; the three-step version is the canonical one):

1. **Phase 1 — Prune unreferenced states.** "Compression deletes all states that do not participate within a version's lineage. Deleting a state deletes all the rows from the delta tables that are associated with that state." [DOCUMENTED — https://desktop.arcgis.com/en/arcmap/10.3/manage-data/gdbs-in-sql-server/geodatabase-compress-operation.htm and https://resources.arcgis.com/en/help/main/10.2/002m/002m00000051000000.htm]
2. **Phase 2 — Collapse candidate lineages.** "The next step the compress operation performs is to collapse any candidate lineage of states into one state. A candidate lineage is a collection of states that can be compressed into one state without affecting the logical representation for any table in a given version." [DOCUMENTED — same sources]
3. **Phase 3 — Graduate delta rows to base.** "The final step, when applicable, is to move rows from the delta tables into the base (or business) tables." [DOCUMENTED — same sources]

Cross-reference summary statements that compress into two operations are simplifications of these three steps:
- "removes unreferenced states and their associated delta table rows ... moves entries in the delta tables common to all versions into the base tables" [DOCUMENTED — https://desktop.arcgis.com/en/arcmap/latest/manage-data/geodatabases/the-compress-operation-and-geodatabases.htm]
- "removes the states that are no longer referenced by a version and can move rows in the delta tables to the business table" [DOCUMENTED — https://desktop.arcgis.com/en/arcmap/10.3/manage-data/gdbs-in-sql-server/geodatabase-compress-operation.htm]

### 3.1 Phase 1 — State-tree pruning

**Rule (DOCUMENTED, ArcSDE 10.0 SDK, compression.htm):**

> Compression simplifies the state tree by removing each state that is **not referenced by a version** and **is not the parent of multiple child states**. All states that are referenced by a version will remain following the compress operation.

This is the precise predicate. Restated for implementation (note: "not referenced by a version" means **not in any surviving version's lineage closure**, not merely "not a version tip"):

```
DELETE state S IFF
  S.state_id NOT IN (SELECT state_id FROM SDE_versions)   -- not a version tip
  AND
  S.state_id NOT IN (                                     -- not an ancestor of any surviving version
    -- IMPORTANT: lineage_name is a TREE identifier from SDE_states, NOT a state_id.
    -- Look up each tip T's lineage_name via SDE_states, then take closure rows
    -- under that lineage_name with lineage_id <= T.state_id (within a lineage_name,
    -- state_id IS lineage order from root to tip).
    SELECT sl.lineage_id
    FROM SDE_versions v
    JOIN SDE_states s ON s.state_id = v.state_id
    JOIN SDE_state_lineages sl ON sl.lineage_name = s.lineage_name AND sl.lineage_id <= v.state_id
    WHERE v.state_id IS NOT NULL
  )
  AND
  (count of S's direct children in SDE_states) <= 1       -- not a branch point
  AND
  S is not currently locked in SDE_state_locks            -- not in an active edit branch
  AND
  S has no descendant in SDE_states that is locked        -- not in any locked sub-branch
```

**Self-row "invariant" — DISPROVEN by empirical testing.** A prior version of this spec claimed `SDE_state_lineages` contains a self-row `(lineage_id = S.state_id, lineage_name = S.state_id)` for every state S. **This is false in real SDE databases.** Putnam parcel_fabric_test (SDE 10.5.1) had 161 of 163 surviving states with no self-row. The pattern is only written by egdb.js's `createChildState` for new sessions; ArcGIS-authored states do NOT have it. Implementations must NOT rely on self-rows. Instead, every closure query must explicitly UNION each tip into its own effective closure (see Section 3.3 and the corrected query in Section 4). The diagnostic function `countMissingSelfRows()` is provided in egdb.js for telemetry only — it is not a fatal precondition.

The **lineage-closure clause is what makes Phase 1 safe across reconciled-but-not-posted versions.** After a child version V reconciles with DEFAULT, V's new tip's lineage closure includes DEFAULT's ancestors. A previously-DEFAULT-tip state P may no longer be in `SDE_versions.state_id` (because DEFAULT moved on), but P may still be in V's lineage closure. Pruning P without checking the closure breaks V's view of the data. See Section 9's "Reconciled but not posted" row for a worked example.

Notes:
- A state with exactly one child is collapsible into that child (its "lineage" can shorten); a state with two-or-more children is a branch-point and must survive because removing it would force the children to share a parent that may no longer reflect their true ancestry. [INFERRED from the rule, consistent with the docs]
- **The state referenced by `sde.DEFAULT` is preserved** because it is a version tip and the documented rule keeps version tips. `state_id = 0` is **not** structurally special: after a full compress, DEFAULT's tip is "a low value" (Esri's wording) which **may or may not be 0** — on a freshly compressed database it is common for state 0 to itself have been pruned and DEFAULT's tip to be a different small `state_id`. **Implementers must not hardcode `state_id != 0` as a "preserve this" guard**, because doing so leaks rows once compress has reset DEFAULT to a non-zero state. The correct guard is "state is referenced (directly or as an ancestor) by some row in `SDE_versions`".
- When a state is deleted, all `a<N>` and `D<N>` rows where `SDE_STATE_ID = S.state_id` are deleted too. [DOCUMENTED — same source]
- Corresponding rows in `SDE_state_lineages` for `lineage_id = S.state_id` (and any row pointing to S as an ancestor of a now-removed state) must also be deleted. [INFERRED — the docs do not state this explicitly but it is required for tree consistency.]

### 3.2 Phase 2 — Candidate-lineage collapse

A **candidate lineage** is a chain of states that can be merged into a single state without changing what any version sees. Concretely, a parent state P and child state C can merge (**C is the removed state, P survives**) when:

- C is not referenced by any version (i.e., no `SDE_versions.state_id = C.state_id`).
- C is the unique child of P along this chain (or, equivalently, C is a non-branch-point intermediate state).
- Merging C into P does not lose information any surviving version needs.

**Collapse direction (IMPORTANT):** Phase 2 collapses **child into parent** — the parent state P survives, the child C is removed, and any delta rows recorded at C are rebased onto P. This direction is required for the post-compress promise that DEFAULT's `state_id` "returns to a low value" (Sections 8, 13) to hold: collapsing in the other direction would push surviving `state_id`s upward and DEFAULT's tip would remain at the high allocation-counter value it had before compress. A version tip C (i.e., C is referenced by `SDE_versions`) is by definition not collapsible in this direction — the predicate excludes it. [INFERRED — Esri docs do not state collapse direction explicitly; this direction is required to reconcile the Section 8 / 13 "low value" verification heuristic with the candidate-lineage rule.]

When C and P are merged, C's delta rows are conceptually rebased onto P, and **redundant** rows are eliminated. The ArcSDE 10.0 SDK states it directly: "Many of these rows are subsequently superseded by more recent changes to the data, and they are no longer required to represent the current state of a version. Compressing a versioned database also eliminates these redundant rows from the delta tables." [DOCUMENTED]

**Operational definition of "redundant":** within a single lineage chain, if multiple `a<N>` rows exist for the same OBJECTID at different state_ids, only the latest one within that lineage is needed; earlier ones (which were inserts or earlier-update pre-images) can be eliminated once no surviving version references them. [INFERRED, consistent with documented "supersession" language.]

**Implementation sketch:**
1. Walk `SDE_states` building parent→child adjacency.
2. Find linear runs `P → C` where C is not a version tip, C is the only child of P along this chain, and C has at most one child of its own (so the chain is collapsible).
3. **Dedupe per OBJECTID BEFORE rewriting** (see 3.4 / 4.4): identify the survivor per OID using pre-rewrite lineage position — the row whose `SDE_STATE_ID` is **closest to the version tip** (equivalently: smallest hop count from the tip when walking `parent_state_id` toward root; equivalently: the A-row reached FIRST when traversing from the tip) wins. Delete the loser row (the one farther from the tip / closer to root) from `a<N>` / `D<N>`. (If both rows have the same position in the lineage, that is an invalid state-tree; raise.)
4. For each registered table N, rewrite the surviving `a<N>` and `D<N>` rows whose `SDE_STATE_ID = C.state_id` to `SDE_STATE_ID = P.state_id`. **D-rows have two independent state references — `SDE_STATE_ID` (the deleting state) and `DELETED_AT` (the pre-image's state) — that must be rewritten independently.** A D-row's `SDE_STATE_ID` may be `C` while its `DELETED_AT` references a different state `X` that is also being collapsed in a separate (P', C') iteration, or vice versa. Run two separate UPDATEs in the same per-table per-collapse transaction:<br>`UPDATE D<N> SET SDE_STATE_ID = P WHERE SDE_STATE_ID = C;`<br>`UPDATE D<N> SET DELETED_AT  = P WHERE DELETED_AT  = C;`<br>Each collapse only touches its own (P, C) pair; the cumulative effect across all collapses migrates every reference into its correct survivor. Treat a D-row + A-row at the same effective state as the "update" representation that must be preserved together.
5. In the **same per-collapse transaction**: prune `SDE_state_lineages` entries for C, delete state row C from `SDE_states`, AND (atomically with the delete) update any `SDE_versions` row whose `state_id = C` to point at P. This per-collapse atomicity is mandatory: if `SDE_states` and `SDE_versions` have any FK relationship between them, a deferred metadata pass would briefly leave `SDE_versions.state_id` referencing a deleted `SDE_states.state_id`. The step-2 predicate ("C is not a version tip") makes the SDE_versions rewrite a no-op in the steady state, but the rewrite MUST be in the same transaction to cover the race where a version was created concurrently with compress and now points at C.
6. Repeat until no further collapse is possible.

**Tip-pointer finalisation:** there is no separate finalisation pass. `SDE_versions.state_id` is kept consistent throughout Phase 2 by step 5's atomic per-collapse rewrite. The post-compress "DEFAULT tip returns to a low value" promise (Sections 8, 13) is satisfied because the surviving state in a fully-collapsed leaf chain is the **root** of the chain (the surviving ancestor closest to the original root), and every collapse along the chain atomically rewrites `SDE_versions.state_id` for DEFAULT to the new survivor.

### 3.3 Phase 3 — Graduate delta rows to base

**Documented predicate** (verbatim across multiple Esri pages, paraphrased in the docs as "rows common to all versions"):

> Moves all rows that are common to all versions into the base tables. [DOCUMENTED — ArcSDE 10.0 SDK compression.htm]
> Moves entries in the delta tables common to all versions into the base tables, reducing the amount of data the database needs to search through for each version query. [DOCUMENTED — https://desktop.arcgis.com/en/arcmap/latest/manage-data/geodatabases/the-compress-operation-and-geodatabases.htm]

"Common to all versions" is **a simplification**. The operational predicate, after Phases 1 and 2, is:

> A delta row at `SDE_STATE_ID = S` graduates iff **every** version tip's effective lineage closure contains S.

**Effective closure (EMPIRICAL — verified against Putnam parcel_fabric_test):**

For a version tip with `state_id = T`:
- Look up `T.lineage_name` from `SDE_states`. **`lineage_name` is a tree-grouping identifier, NOT a state_id**, and multiple tips may share the same `lineage_name`.
- The closure is `{S : ∃ row in SDE_state_lineages with lineage_name = T.lineage_name AND lineage_id = S AND S <= T.state_id}` UNION `{T}` itself.
- Within a single `lineage_name`, `state_id` IS lineage order from root to tip; the `lineage_id <= T.state_id` filter is the standard way to bound the closure (see `find-ancestor.ts:73 getStatesInRange` and `enterprise-geodatabase.ts:445 getVersionStateLineage`).
- The explicit UNION of `T` itself is mandatory because ArcGIS-authored states do NOT have self-rows in `SDE_state_lineages` (see "Self-row 'invariant' — DISPROVEN" above).

Concrete SQL (SQL Server dialect):
```sql
-- Graduable prefix = intersection of all version tips' effective closures.
SELECT state_id FROM (
  SELECT s.state_id AS tip, sl.lineage_id AS state_id
  FROM SDE_versions v
  JOIN SDE_states s ON s.state_id = v.state_id
  JOIN SDE_state_lineages sl ON sl.lineage_name = s.lineage_name AND sl.lineage_id <= v.state_id
  WHERE v.state_id IS NOT NULL
  UNION
  SELECT state_id AS tip, state_id FROM SDE_versions WHERE state_id IS NOT NULL
) closures
GROUP BY state_id
HAVING COUNT(DISTINCT tip) = (SELECT COUNT(DISTINCT state_id) FROM SDE_versions WHERE state_id IS NOT NULL)
```

The graduable prefix is a downward-closed subset of the state tree (every ancestor of a graduable state is also graduable). When only `sde.DEFAULT` exists and no editors are active, the graduable prefix is everything reachable in DEFAULT's lineage. When N child versions remain, the prefix shrinks to the common ancestor set of all N+1 tips — typically only state 0 if the child versions are old / never reconciled, as seen in Putnam.

#### 3.3.1 Operational implication (READ BEFORE SCHEDULING COMPRESS)

In production with N active editors holding unposted child versions, the graduable prefix is the common ancestor set of all (N+1) versions, including DEFAULT. Even **one** unposted child reduces Phase 3 graduation to approximately zero rows after that common ancestor.

**Worked example (Putnam-scale):** 6 active editors each hold an unposted child version. The intersection of the 7 closures (DEFAULT + six children) is just their common ancestor — typically the state at the last full compress. Phase 3 therefore graduates zero rows from any state created after that common ancestor. A weekly compress run with even one unposted editor produces essentially zero Phase 3 work; Phase 1/2 still do useful state-tree pruning, but the delta tables do not shrink meaningfully.

**Recommended Putnam posture:** before each weekly compress, fully reconcile, post, and delete all child versions (or coordinate disconnection so editors save+post first). Otherwise the operator should expect "delta tables didn't shrink" as the normal outcome and not interpret it as compress failure. See also Section 14.

**Graduation algorithm (per registered table N):**

For each OBJECTID OID present in `a<N>.OBJECTID` or `D<N>.SDE_DELETES_ROW_ID` for a graduable state:
1. Find the **latest** A-row for OID within the graduable prefix — the A-row whose `SDE_STATE_ID` is **closest to the chosen version tip in the lineage walk** (equivalently: smallest hop count from the tip when walking `parent_state_id` toward root; equivalently: the A-row whose `SDE_STATE_ID` is reached FIRST when traversing from the tip), not numerically largest (see Sections 3.4 and 4.4). Call it `A_final`.
2. Determine whether OID has a graduable D-row, i.e., a row in `D<N>` with `SDE_DELETES_ROW_ID = OID` whose `SDE_STATE_ID` and `DELETED_AT` are both in the graduable prefix and whose `SDE_STATE_ID` is **closer to the tip** (smaller hop count from the tip) than `A_final.SDE_STATE_ID`. Call it `D_final` if present.
3. Cases:
   - **Final event is INSERT/UPDATE** (`A_final` newest, no superseding `D_final`): UPSERT `A_final` into base table (`UPDATE` if OID already exists in base; `INSERT` otherwise). Delete all A-rows for OID at any state in the graduable prefix; delete all D-rows whose `SDE_DELETES_ROW_ID = OID` at any state in the graduable prefix.
   - **Final event is DELETE** (`D_final` newest): If OID exists in base, `DELETE FROM base WHERE OBJECTID = OID`. Delete all A-rows and D-rows (joined by `SDE_DELETES_ROW_ID`) for OID in the graduable prefix.
   - **OID inserted and then deleted entirely within the graduable prefix (phantom)**: iff `A_final` exists in graduable prefix, `D_final` exists in graduable prefix with `D_final.SDE_STATE_ID` closer to the tip than `A_final.SDE_STATE_ID`, AND `SELECT 1 FROM base WHERE OBJECTID = OID` returns no row. Delete the A and D rows; do not touch base. **If base DOES contain OID** (possible if `i<N>` was manually adjusted or restored, causing OID reuse), treat this as a delete-graduation: `DELETE FROM base WHERE OBJECTID = OID`, remove both delta rows, and log a structured warning that OID reuse may have occurred. [INFERRED]
4. Special case: for each OID present in `D<N>` (joined as `SDE_DELETES_ROW_ID`) but **not** in `a<N>` for the graduable prefix (i.e., graduable delete of a row that was already in base), only graduate if both `SDE_STATE_ID` and `DELETED_AT` are in the graduable prefix; then `DELETE FROM base WHERE OBJECTID = D<N>.SDE_DELETES_ROW_ID` and remove the D-row.
5. **Co-located D+A tie-breaker (required because post.ts collapses both rows to the parent state):** if both an A-row and a D-row exist for the same OID at the **same** `SDE_STATE_ID` within the graduable prefix, treat the pair as an **UPDATE** (D = pre-image, A = post-image) and graduate as **UPSERT-A** — write `A_final` into base, do NOT DELETE from base, and remove both delta rows. This rule supersedes the hop-count comparison in step 2 for the co-located case: when `D.SDE_STATE_ID == A.SDE_STATE_ID` the hop counts are equal and the tip-distance test cannot order them. A standalone D-row at state S with no co-located A-row for the same OID is a pure DELETE (step 3 case "Final event is DELETE"). A standalone A-row at state S with no co-located D-row for the same OID is a pure INSERT/UPSERT (step 3 case "Final event is INSERT/UPDATE"). **Pro-authored caveat:** ArcGIS Pro may write D-rows whose `DELETED_AT` legitimately points at an earlier A-row's state without a co-located A-row at the D-row's `SDE_STATE_ID`; in mixed-writer environments, when a D-row's `DELETED_AT` is in the graduable prefix and is strictly closer to the tip than every A-row for the same OID, treat as DELETE per step 3 case "Final event is DELETE". Log a structured warning if a D-row is encountered with `DELETED_AT != SDE_STATE_ID` AND `DELETED_AT` is outside the graduable prefix, because that configuration is ambiguous under this library's semantics (see 3.3.0).
6. **Pruned-`DELETED_AT` case:** if `DELETED_AT` references a state that no longer exists in `SDE_states` (i.e., the pre-image's state was already graduated to base by a prior compress run), treat the D-row as graduable provided its `SDE_STATE_ID` is in the graduable prefix. The deletion supersedes a row already in base; apply `DELETE FROM base WHERE OBJECTID = SDE_DELETES_ROW_ID` and remove the D-row. [INFERRED — required for correctness across successive compress runs; see also 3.3.0.]

**"Which A-row wins for an OID with multiple A-rows" — DOCUMENTED implicitly via the supersession language, INFERRED for the exact mechanism:**

> Within a state lineage, the winning A-row is the one whose `SDE_STATE_ID` is **closest to the version tip** along the lineage walk (i.e., the FIRST state encountered when traversing `parent_state_id` from the tip toward root, equivalently: the smallest hop count from the tip in `SDE_state_lineages`). This is **not** the same as "largest `state_id`": because `state_id` is allocation order and not lineage order, a sibling-branch A-row may have a numerically larger `state_id` but belong to a state the version does not see. ArcSDE resolves this at read time using `SDE_state_lineages` and the per-version lineage ranking. Compress applies the same predicate. [INFERRED — Esri docs describe versioned-view queries as filtering by lineage; egdb.js itself implements this for `_evw` reads.] See Section 3.4 and 4.4.
>
> **Worked numerical example.** Linear lineage from root to tip: `root=10 -> 25 -> 40 -> 55 -> 70=tip`. Three A-rows exist for OID 42, at `SDE_STATE_ID = 25`, `SDE_STATE_ID = 40`, and `SDE_STATE_ID = 55`. Hop counts from tip 70: state 55 is 1 hop, state 40 is 2 hops, state 25 is 3 hops. The winner is the A-row at **`SDE_STATE_ID = 55`** (smallest hop count from tip, closest to tip). The losers are at 40 and 25 (farther from tip, closer to root). The losers' values are stale; if you wrote any of them to base during Phase 3 graduation you would silently overwrite the editor's most recent vertex edits with older ones.

### 3.3.0 D-table schema (required vocabulary)

Phase 3's delete-graduation logic depends on naming D-table columns precisely. The D-table for a registered table N has at least:

- `SDE_DELETES_ROW_ID` — the OBJECTID of the row that was deleted (the join key back to base / A-table OBJECTID). **There is no OBJECTID column in D-tables; an implementer who joins on `OBJECTID` will get a SQL error.**
- `SDE_STATE_ID` — the state in which the delete record was **created** (the state that performed the delete).
- `DELETED_AT` — intended (per the system-tables reference) as the state in which the row was **visible as a pre-image** before being deleted (the supersession pointer back to the prior A-row's state). **However, the semantics of `DELETED_AT` as written by this library DIFFER from the description above:** `src/edit-session.ts` (lines 603, 755, 1130, 1151) and `src/reconcile/apply-changes.ts` (line 107) set `DELETED_AT := SDE_STATE_ID` on every D-insert, and `src/reconcile/post.ts` (line 90) sets both to the parent state on posted deletes. The library's D-rows therefore have `DELETED_AT == SDE_STATE_ID` (self-authored) or `DELETED_AT == parent_state` (posted), not "the prior A-row's state." The Esri-intended semantics are not verified against an ArcGIS-Pro-authored D-table.

**Operational consequence and pragmatic stance.** Until the Esri-authored writer's pattern is verified end-to-end against an ArcGIS Pro-edited D-table, compress treats `DELETED_AT` as **informational only** for D-rows written by this library: a D-row is graduable when its `SDE_STATE_ID` is in the graduable prefix; `DELETED_AT` is checked for prefix-membership as a secondary guard but **its absence from the prefix does not, by itself, block graduation** when it equals `SDE_STATE_ID` (self-authored case). Implementers MUST log a structured warning when a D-row's `DELETED_AT` references a state outside the graduable prefix AND differs from `SDE_STATE_ID`, because this is the only configuration where the spec's "pre-image visibility" semantics matter and the library may not have produced it. In mixed-writer environments (Pro and egdb.js writing to the same fabric), this approximation may incorrectly delete from base; document this caveat in `CompressResult` and in the operator-facing release notes. See 3.3 step 5 ("Pruned-`DELETED_AT` case") for the related pruned-state handling.

**Schema source:** D-table column names are DOCUMENTED in the Esri system-tables reference for SQL Server (https://desktop.arcgis.com/en/arcmap/10.3/manage-data/gdbs-in-sql-server/system-tables-sqlserver.htm). egdb.js's `src/reconcile/compress.ts` exercises `SDE_DELETES_ROW_ID` and `SDE_STATE_ID` but does NOT currently reference `DELETED_AT`; do not treat compress.ts alone as authoritative for the column vocabulary. **Until Esri's intended `DELETED_AT` semantics are verified against a Pro-authored D-table, the spec acknowledges that this library's `DELETED_AT` writes diverge from the documented intent.**

**Precondition check (required):** at compress start, query `information_schema.columns` (PostgreSQL) or `sys.columns` (SQL Server) for at least one D-table to verify the three expected columns (`SDE_DELETES_ROW_ID`, `SDE_STATE_ID`, `DELETED_AT`) exist. If `DELETED_AT` is missing on a particular schema variant, abort with an `InsufficientSchema` error rather than building D-row graduation logic that would hit a runtime SQL error.

### 3.4 State ordering pitfalls (read this before writing any SQL)

`state_id` in `SDE_states` is a **globally monotonic allocation counter** stamped at save time. It is **not** lineage order **across different lineage_names**. Within a single `lineage_name`, `state_id` IS lineage order from root to tip — that's why existing egdb.js code (`find-ancestor.ts`, `getVersionStateLineage`) uses `lineage_id <= state_id` as the closure bound. The two common ways implementers go wrong:

1. **Using `MIN(state_id)` / `MAX(state_id)` to approximate ancestry.** Wrong. After a reconcile/post, a version's new tip can have a `state_id` larger than DEFAULT's tip even though the new tip is not in DEFAULT's lineage, and vice versa. Always resolve ancestry through `SDE_state_lineages` (the closure table) or by walking `SDE_states.parent_state_id`.
2. **Using "largest `state_id`" as the supersession tie-breaker.** Wrong for the same reason: an A-row at a numerically larger `state_id` may belong to a sibling branch that the version cannot see. The correct rule is **closest to the version tip in the lineage walk** — equivalently, the A-row whose `SDE_STATE_ID` has the **minimum hop count from the tip** (reached FIRST when traversing `parent_state_id` from tip toward root). The word "deepest" is intentionally avoided here because it is ambiguous (deepest from root and deepest from tip are inverses). "Closest to tip" is the only correct framing.

Cross-references: Sections 3.2 step 3, 3.3 graduation algorithm, 4.2, 4.3, 4.4.

---

## 4. State Ordering and Lineage

### 4.1 SDE_state_lineages structure (DOCUMENTED — desktop.arcgis.com SQL Server system tables; EMPIRICAL verification, Putnam parcel_fabric_test)

- `SDE_states` records each state with `state_id`, `parent_state_id`, owner, creation time, and a `lineage_name` (a tree-grouping integer, NOT the same as `state_id`).
- `SDE_state_lineages` is a **partitioned closure-like table**: rows are `(lineage_name, lineage_id)` pairs meaning "state `lineage_id` is in the lineage tree identified by `lineage_name`." Multiple states (and multiple version tips) can share a `lineage_name` — Putnam observed states 24814, 25008, 25066 all using `lineage_name = 24542`. ArcGIS does NOT write self-rows: for a state S with `lineage_name = L`, the row `(L, S.state_id)` may or may not exist (rare). Closure queries must explicitly UNION the tip into its own closure.
- The closure of a state S is `{lineage_id : SDE_state_lineages row exists with lineage_name = S.lineage_name AND lineage_id <= S.state_id}` UNION `{S.state_id}`. Within a single `lineage_name`, `state_id` is monotonic from root to tip — this is what makes `lineage_id <= S.state_id` a correct closure bound. The "state_id is globally non-monotonic" caveat in Section 3.4 applies ACROSS different `lineage_name` trees, not within a single one.
- `SDE_versions` records each version with a pointer to its **tip** `state_id`. Two versions can point at the same tip (Putnam: DEFAULT and APRIL.atom_0329cloud both at 25066).
- `SDE_mvtables_modified` records which versioned tables were modified in which state — used to skip Phase 2/3 work for tables that weren't touched. [DOCUMENTED — same source]

**WARNING — state_id ordering pitfall (read before implementing any phase):** `state_id` is allocated as a globally monotonic counter at save time. It is **allocation order, not topological / lineage order**. After an editor reconciles, the editor's new state can have a `state_id` higher than DEFAULT's tip while sharing none of DEFAULT's recent branch. **NEVER use `<`, `<=`, `MIN`, or `MAX` over `state_id` to infer ancestry or "latest along a lineage."** Ancestry must always be derived from `SDE_state_lineages` (closure table) or from walking `SDE_states.parent_state_id`. "Latest along a lineage" means **closest to the version tip in the lineage walk** (smallest hop count from the tip), not numerically largest. See Section 3.4.

### 4.2 Traversal choice for compress

- For **pruning** (Phase 1), the natural traversal is `SDE_states.parent_state_id` because it tells you the tree shape (who is a branch point).
- For the **graduation predicate** (Phase 3), use `SDE_state_lineages` via the JOIN-with-`SDE_states.lineage_name` pattern (NOT `lineage_name = v.state_id` — that was an earlier mis-statement; `lineage_name` is the tree identifier from `SDE_states.lineage_name`, not the tip's `state_id`). A state S is graduable iff S appears in every surviving version's effective closure as defined in Section 3.3. [EMPIRICAL]

### 4.3 Edge: "states below MIN(state_id) of all version pointers" — DO NOT USE

A tempting shortcut is "everything with `state_id <= MIN(SDE_versions.state_id)` is graduable." **This is wrong in any non-linear state tree and must not be used as a pre-filter.** Because `state_id` is allocation order and not lineage order, a state with a small `state_id` may belong to a sibling branch that no surviving version sees, and a state with a large `state_id` may be a common ancestor of every version (e.g., after a post moves DEFAULT's tip forward). Always use the closure-table check from 4.2. The closure-table check is the only source of truth. [INFERRED]

### 4.4 "Latest A-row" along a lineage

When Phase 2 or Phase 3 picks the "latest" A-row for an OID along a version's lineage, **latest means closest to the version tip in the lineage walk via `parent_state_id`** (smallest hop count from the tip; reached FIRST when traversing from tip toward root), not numerically largest `state_id`. Concretely: rank the states in the version's lineage by their hop count from the tip, then pick the A-row whose `SDE_STATE_ID` has the minimum hop count. The word "deepest" is avoided because it can mean either "deepest from root" (oldest) or "deepest from tip" (newest); "closest to tip" / "minimum hop count from tip" is unambiguous. [INFERRED]

**Worked numerical example.** Linear lineage `root=10 -> 25 -> 40 -> 55 -> 70=tip`. Three A-rows for OID 42 at `SDE_STATE_ID in {25, 40, 55}`. Winner: `SDE_STATE_ID = 55` (1 hop from tip). Losers: 40 (2 hops) and 25 (3 hops). Writing 25's or 40's values to base would silently destroy the editor's later edits at 55.

---

## 5. Geometry Handling

**UNKNOWN / AMBIGUOUS in public docs.** Esri does not publish whether Compress re-encodes the `SHAPE` column when graduating from `a<N>` to base. The behaviour required by correctness:

- The geometry blob in `a<N>.SHAPE` (whether ST_Geometry on PostgreSQL, MS Geometry/Geography on SQL Server, or SDE binary on legacy schemas) and the geometry column in the base table use the **same storage format**, since both are governed by the same `SDE_geometry_columns` / `SDE_layers` registration. Therefore a column-to-column copy is byte-equivalent. [INFERRED]
- For SDE binary storage (curves, M/Z), the bytes are preserved as-is; arcs/circular strings/elliptic arcs survive Compress. There is no reason for ArcGIS to re-encode, and corruption of curves through Compress is not a documented bug. [INFERRED]
- For ST_Geometry (PostgreSQL) and SQL Server `geometry`/`geography`, the column type is identical between base and adds; binary copy preserves all semantics. [INFERRED]

**Implementation guidance for egdb.js:** when graduating an A-row, copy `SHAPE` as an opaque blob. Do not call any conversion. Same for all other columns: rely on `INSERT ... SELECT` / `UPDATE ... FROM` so the database engine performs no implicit conversion.

**IMPLEMENTATION REQUIREMENT:** Phase 3 MUST use `INSERT ... SELECT` or `UPDATE ... FROM ... SET col = src.col` referencing the `SHAPE` column directly as an opaque column at the SQL layer. egdb.js MUST NOT route the SHAPE bytes through `GeometryParser` / `GeometryWriter` (or any other JS-side encoder) during compress. The geometry parser is independently maintained and any encoding change would silently corrupt curved geometries through a compress cycle. **Required regression test:** for a feature with a circular-arc/curved geometry, the raw `SHAPE` bytes read from `a<N>` before compress must be byte-equal to the bytes read from the base table after compress.

---

## 6. Concurrency and Locking

### 6.1 What Compress takes

- **No database-wide exclusive lock.** Since ArcSDE 9.x: "compress operation no longer requires an exclusive lock to prevent inconsistent reads on the database." [DOCUMENTED — ArcSDE 10.0 SDK compression.htm]
- **Per-table transactions**: "For each step of the operation, database transactions are started and stopped for each table being compressed." [DOCUMENTED — desktop.arcgis.com latest and resources.arcgis.com 10.2 compress page] This means each table is its own atomic unit; partial progress across tables is the documented model.
- **Active editor branches are skipped.** The lock that protects an active edit branch is the editor's row in `SDE_state_locks`; compress observes it and excludes that branch from Phases 1/2. [DOCUMENTED for the behaviour; INFERRED for the precise mechanism via `SDE_state_locks`.]
- **"Branch" means the locked state PLUS all of its ancestors PLUS all of its descendants.** `SDE_state_locks` records only the specific state the editor is holding, not their sub-tree or their ancestry. An editor holding state L may have child states L', L'' containing in-flight A/D rows; pruning those descendants would destroy the editor's unsaved work. The editor's view also resolves THROUGH L's ancestors (versioned-view reads use the closure of L); pruning an ancestor A of L that is not in any surviving SDE_versions tip's closure would silently corrupt the editor's reads through L. The exclusion set must therefore be computed as:

  ```
  excluded =
      -- The locks themselves
      (SELECT state_id FROM SDE_state_locks)
      UNION
      -- Ancestors: for each lock L, walk L's lineage_name's closure rows
      -- where lineage_id <= L. SDE_state_lineages.lineage_name is a TREE
      -- identifier from SDE_states.lineage_name, NOT a state_id.
      (SELECT sl.lineage_id
       FROM SDE_state_locks lk
       JOIN SDE_states sLock ON sLock.state_id = lk.state_id
       JOIN SDE_state_lineages sl ON sl.lineage_name = sLock.lineage_name AND sl.lineage_id <= lk.state_id)
      UNION
      -- Descendants: SDE_states rows whose lineage_name has L as a closure
      -- member AND state_id >= L.state_id.
      (SELECT sDesc.state_id
       FROM SDE_state_locks lk
       JOIN SDE_state_lineages sl ON sl.lineage_id = lk.state_id
       JOIN SDE_states sDesc ON sDesc.lineage_name = sl.lineage_name AND sDesc.state_id >= lk.state_id)
  ```

  This matches `compress-phases.ts:readLockedBranches`. Earlier versions of this spec used a `lineage_name IN locked_states` pattern that treated `lineage_name` as a `state_id`; that produced empty result sets on real SDE databases because `lineage_name` is a separate tree identifier. [EMPIRICAL — verified against Putnam parcel_fabric_test, state 25066 has lineage_name 24542.]

  **Concurrency scenario this guards against.** Editor opens an `EditSession` against `sde.DEFAULT`; `save()` has not yet run, so `SDE_versions.DEFAULT.state_id` still points at the OLD parent state P. The editor's in-flight child state I is a child of P. `SDE_state_locks` holds a row for I (or for P — egdb.js's lock contract is in `src/edit-session.ts`; either way, both must be expanded). Between editor `save()` and editor `close()`, DEFAULT moves to a new tip T via another posted version. T's closure may not include P (if T branched off some earlier ancestor). P is now not a version tip, not in any version's closure, and not a descendant of any locked state — but it IS an ancestor of locked state I. Without the ancestor-expansion clause above, Phase 1 prunes P and the editor's in-flight branch loses its ancestry; subsequent reads through I return incorrect base data.

  **Note on `SDE_state_locks` semantics.** Whether `SDE_state_locks` records the editor's PARENT state at session start or the most recent CHILD state should be confirmed against `src/edit-session.ts`. If PARENT-only, the descendant expansion is essential; if CHILD-only, the ancestor expansion is essential. Doing both is always safe and is the prescribed behaviour above.

### 6.2 What Compress should NOT do (implementation guidance)

- Do not take SCH-M (schema modification) on base tables. The base table schema is unchanged.
- Do not block new read-only queries — leave row-level locking to the database engine.
- Do not block new edit sessions outright — but **new edit sessions starting against a branch that Compress is currently rewriting will see lock contention** on `SDE_state_locks` / on the A/D tables. egdb.js's `EditSession.start` should expect and retry on transient lock waits.

### 6.3 What ArcGIS Pro's UI does when editors are connected

- The official guidance is to ask all users to disconnect before a "full" compress. Pro's GP tool itself does not forcibly disconnect editors; it runs the operation and silently skips locked branches. [DOCUMENTED — desktop.arcgis.com 10.3 geodatabase-compress-operation.htm]
- No documented "kick editors out" behaviour. Administrators must coordinate disconnection out-of-band.

### 6.5 Concurrency with reconcile/post during compress

The advisory lock in 2.3 protects against concurrent **compresses**, not against concurrent posts. A POST landing between Phase 3's per-table iterations will mutate `sde.DEFAULT`'s `state_id` and append rows to `SDE_state_lineages`, so the graduable set computed at the start of compress (Section 16 step 2) may be stale by the time later tables run their Phase 3. This produces per-table-inconsistent compress output: some tables graduate against the old DEFAULT tip, others against the new tip.

Mitigation options, in order of preference:

1. **No-edit maintenance window (recommended).** Schedule compress during a window when no editor sessions and no reconcile/post operations are running. This is Putnam's recommended posture (6 editors normally; coordinate disconnection out-of-band before compress).
2. **Snapshot-and-revalidate INSIDE the transactional fence.** Snapshot `SDE_versions.state_id` and the relevant `SDE_state_lineages` rows at the start of compress. For each per-table Phase 3 transaction: BEGIN the transaction at `SERIALIZABLE` (PostgreSQL) or `REPEATABLE READ` plus `SELECT ... WITH (HOLDLOCK, ROWLOCK) FROM SDE_versions` (SQL Server) so that the per-table transaction holds locks that block concurrent posts. INSIDE the transaction, re-read `SDE_versions` tips; if they differ from the snapshot, ABORT that table's transaction and record a `partial-skip` entry in `CompressResult`. The compress continues for unaffected tables; the operator re-runs to pick up the rest. **Revalidating BEFORE the transaction begins is a race: a post can land between the revalidation read and the transaction begin under default `READ COMMITTED` isolation.** The revalidation MUST be the first read inside the transaction.
3. **Shared lock on `SDE_versions`.** Hold a shared lock for the duration of compress that blocks post (which takes an exclusive lock on `SDE_versions` to update tip pointers). This serialises but does not deadlock.
4. **SERIALIZABLE isolation** for the metadata reads (`SDE_versions`, `SDE_state_lineages`). Cheapest to implement; works if the DB's serializable implementation aborts conflicting posts cleanly.

`egdb.js`'s `editTransaction` can itself call `postVersion`, so the advisory lock alone is **not** sufficient on a system where editors run via the same library; one of the above must be added.

### 6.4 USE_EXCLUSIVE_LOCKING DBTUNE option

There is a DBTUNE keyword `USE_EXCLUSIVE_LOCKING` that can re-enable older exclusive-locking behaviour. This is **legacy / opt-in** and not the default. Mention is in older Esri docs but the parameter has not been promoted in modern Pro docs. egdb.js should not depend on it. [DOCUMENTED in legacy docs; we deliberately do not assert it modifies modern compress behaviour as the verifier vote was split.]

---

## 7. Atomicity and Crash Recovery

- **Per-table atomicity is the documented unit.** "For each step of the operation, database transactions are started and stopped for each table being compressed." [DOCUMENTED]
- **Safe to retry / re-run.** "If the operation encounters an error, fails, or abruptly stops, the versioned tables being compressed are still logically correct with respect to any version's representation." Esri explicitly invites re-running: "you might want to stop the operation and run it again when fewer or no users are connected." [DOCUMENTED — desktop.arcgis.com latest and resources.arcgis.com 10.2]
- **"Logically correct" does not mean "made progress."** It means no version reads a torn state. A partial compress is still a valid state of the database.
- **Idempotent on retry** in the sense that re-running converges (running compress on an already-compressed db does additional work only if new state-tree activity occurred).

**Implementation guidance:**
1. Wrap each table's Phase-3 work in a single transaction; commit before moving to the next table.
2. Phase 1 and Phase 2 each fan out across **every registered table** before touching `SDE_states` / `SDE_state_lineages`: for each state being pruned or collapsed, run a per-table transaction that processes `a<N>` and `D<N>` (delete or rewrite `SDE_STATE_ID`/`DELETED_AT`) for that state; only after every table is committed may the state's `SDE_state_lineages` rows and the `SDE_states` row itself be deleted, in a final metadata transaction. This preserves per-table atomicity (Section 7) while ensuring no `a<N>`/`D<N>` row is ever left pointing at a deleted `SDE_states.state_id`. **Invariant (mandatory):** no delta row at state S may be deleted before re-confirming, INSIDE the same per-table transaction and under locking on `SDE_state_locks` and `SDE_versions`, that S is not in any current lock's expanded closure AND not in any surviving version's lineage closure. A concurrent `EditSession.start` between the start-of-compress snapshot and the per-table DELETE would otherwise lose A/D rows at S irrevocably — the final metadata transaction's recheck can stop the `SDE_states` delete but cannot un-delete delta rows. See Section 16 step 4.
3. Do not attempt a single huge transaction across all tables — it will not match documented behaviour, will hold locks too long, and risks transaction-log explosion on SQL Server.

---

## 8. System-Table Updates

After a successful compress run, the following system-table changes are expected. Many of these are **INFERRED** from the documented effect because Esri does not publish the on-disk row-by-row sequence.

| Table | Update |
|---|---|
| `sde.SDE_states` | Rows for pruned states are deleted. After a "full" compress with only `sde.DEFAULT` present and no editors, only the state referenced by DEFAULT remains; this is a small `state_id` but not guaranteed to be 0. |
| `sde.SDE_state_lineages` | Closure-table rows for deleted states are removed. Surviving states have their lineages re-derived (in practice, by deleting rows whose `lineage_id` or `lineage_name` references a removed state). |
| `sde.SDE_versions` | DEFAULT's `state_id` is updated to point at the surviving tip (after a full compress, this returns to 0 / a new low value). Other versions' `state_id` is updated to point at the collapsed-lineage tip. |
| `sde.SDE_table_registry` | Untouched. Registration IDs do not change. |
| `sde.SDE_mvtables_modified` | Entries for pruned states are removed. |
| `sde.a<N>` / `sde.D<N>` | Rows whose state_id was pruned are deleted. Rows whose state_id is in the graduable prefix are moved into the base table (or simply deleted if "phantom") and removed from the delta. |
| Base/business table for N | UPSERTs/DELETEs from Phase 3. |
| `sde.SDE_compress_log` | **Possibly written to** — the docs reference a compress log conceptually, but the schema is not publicly documented and the table may not exist on every release. egdb.js can ignore this and rely on its own logger. |

**Verification heuristic (DOCUMENTED via Esri community / Pro recommended workflow):** after a full compress, `sde.SDE_versions` for DEFAULT should have `state_id` set to a **low value** (Esri's docs do not promise 0). If it remains high, the compress did not fully complete (typically because an editor branch was active or a child version was unposted). **Do not check `state_id = 0` literally** — that test fails on databases where state 0 has itself been pruned in a prior compress.

---

## 9. Edge Cases (detailed)

| Case | Behaviour |
|---|---|
| **Vertex edit (update)** | `EditSession` writes a D-row (pre-image) + A-row (post-image) at the same `SDE_STATE_ID`. Compress treats the pair as one "update" event. Graduation: UPSERT A-row's values into base; delete both delta rows. [INFERRED from versioned-edit model.] |
| **Split (one feature → two)** | D(parent) + A(child1) + A(child2) — possibly with different OIDs for the children. No "split lineage" metadata table exists in the SDE schema. Compress sees them as one delete and two inserts and treats them independently. Relationship class linkage (if any) is in the relationship table, not in compress's scope. [INFERRED] |
| **Merge (two features → one)** | D(parent1) + D(parent2) + A(child). Same story — compress treats them as two deletes and one insert. [INFERRED] |
| **Phantom (inserted then deleted in DEFAULT before compress)** | A-row and D-row both exist in graduable prefix for the same OID. Compress recognises the net effect is "no row," removes both delta rows, does not touch base. [INFERRED] |
| **OID added in version V, posted to DEFAULT, then modified in version W** | After post, the A-row from V is rebased to DEFAULT's lineage. W's modification is an A-row in W's lineage that points at the same OID. Compress can graduate the DEFAULT-lineage A-row only when W also has the OID's pre-image visible, i.e., usually not until W is reconciled+posted. Until then, the A-row remains. [INFERRED] |
| **Reconciled but not posted** | Reconcile updates V's state to a new child whose lineage now includes DEFAULT's tip's ancestors. `SDE_state_lineages` gains rows reflecting V's new state's ancestors. Until V is posted, V still references states that Compress cannot graduate, so the changes stay in delta tables. **Worked example:** say DEFAULT's tip was state 50, V's tip was state 12. V reconciles with DEFAULT; V's tip becomes a new state 73 whose lineage closure is `{0, 5, 12, 30, 50, 73}` (the union of V's old lineage and DEFAULT's). DEFAULT subsequently posts something else and moves to tip 80, whose closure is `{0, 5, 30, 50, 80}`. State 50 is no longer in `SDE_versions.state_id` (DEFAULT's tip moved), but 50 IS still in BOTH V's (`{...,50,73}`) and DEFAULT's (`{...,50,80}`) lineage closures. Pruning state 50 via Phase 1's tip-only predicate would break V's read of any A-row at state 50. The closure clause in Section 3.1's predicate prevents this. [INFERRED, consistent with Esri's reconcile/post documentation] |
| **Multiple A-rows for one OID across successive saves** | Each save writes a new A-row at a new state_id. After Phase 2 collapse, redundant A-rows are eliminated; the latest one wins on graduation. [DOCUMENTED — supersession language in ArcSDE 10.0 SDK compression.htm] |
| **Non-spatial versioned tables** | Same delta-table mechanism, just without a SHAPE column. Compress handles them identically. [INFERRED — the delta-table mechanism is geometry-agnostic.] |
| **Versioned tables with GlobalID** | GlobalID is a regular column in the schema; copy-by-value during graduation. Compress does not regenerate GlobalIDs. [INFERRED] |
| **State 0 (root)** | **Not structurally special.** The state preserved by compress is whatever `state_id` is referenced by `sde.SDE_versions WHERE name = 'DEFAULT'`. After a full compress that state is "a low value" (Esri's wording) but may not be 0; on freshly-compressed databases state 0 itself may have been pruned. Do not hardcode `state_id = 0` as the preserved root. [INFERRED, consistent with the rule "states referenced by a version remain."] |

### 9.1 Parcel fabric and related multi-table edits

The parcel fabric uses cross-table referential integrity (e.g. `ParcelFabric_Parcels.RECORD_GUID` -> `ParcelFabric_Records.GLOBALID`; `ParcelFabric_Lines.PARCEL_GUID` -> `Parcels.GLOBALID`; Points similarly). A single fabric operation (split, merge, record creation) writes D+A rows across multiple tables: a parcel split writes D+A to Parcels AND adds Lines AND may write to Records.

Compress's per-table-atomicity model (Section 7) commits each table independently. **Compress preserves per-table consistency but does NOT preserve cross-table consistency between Parcels / Lines / Connections / Points / Records during the Phase 3 window.** Between Parcels' Phase 3 commit and Lines' Phase 3 commit, the Parcels base table may already have a new split parcel while the corresponding Lines base rows are still in the Lines A-table (or vice versa). A reader querying base tables directly during this window can see cross-table referential violations.

**Mitigation:**
- Readers (including cache warmers, tile builders, external integrations) MUST use versioned views (`*_evw`) for the duration of compress. Versioned views resolve through A/D atomically and present a consistent snapshot regardless of compress in flight.
- Base-table-only readers are the corruption path. If a reader cannot use versioned views, schedule it outside the compress window.
- Compress does not have ParcelFabric-specific logic; `ParcelFabric_Records` is graduated as any other versioned table. There is no fabric-aware cross-table coordination during compress.

---

## 10. What Pro's Compress GP Tool Does

The publicly documented step list from the Pro tool reference and the ArcMap compress operation pages is identical to the three phases above. The tool:

1. Validates the connection is the geodatabase administrator. Errors otherwise.
2. Logs the start of the compress.
3. Executes Phase 1, Phase 2, Phase 3 across all registered versioned tables.
4. Reports success or partial completion.

**Recompress thresholds / automatic compress:** None documented for traditional versioning in Pro. There is no automatic compress; the admin must run it on a schedule. (Branch versioning, which we are not implementing, has different concepts.)

**Post-compress validation:** The documented heuristic is to query `sde.SDE_versions` for DEFAULT's `state_id` and confirm it returned to a low value, and to inspect delta tables for residual rows.

---

## 11. ArcGIS Server vs Pro GP Tool

- Conceptually the **same operation** — both ultimately call into the same SDE codepath.
- Server administration historically exposed `sdeversion -o compress`; Pro exposes the Compress GP tool and the Python `arcpy.management.Compress`.
- No documented behavioural difference for traditional versioning.

### 11.1 Dialect specifics for egdb.js

| Concern | SQL Server | PostgreSQL |
|---|---|---|
| Advisory lock (Section 2.3) | `sp_getapplock` — **must be explicitly session-scoped and Exclusive**. Default `@LockOwner = 'Transaction'` releases on the next COMMIT/ROLLBACK, which is wrong for compress's per-table-transaction model — the lock would drop between the first and second table. Default `@LockMode = 'Shared'` does NOT block another compress. Call:<br>`EXEC sp_getapplock @Resource = N'egdb.js.compress.<dbName>', @LockMode = N'Exclusive', @LockOwner = N'Session', @LockTimeout = <ms>`<br>Acquire OUTSIDE any transaction so the Session-scoped lock survives per-table transaction boundaries. Release with `EXEC sp_releaseapplock @Resource = N'egdb.js.compress.<dbName>', @LockOwner = N'Session'` in `finally`. **Warning:** a connection-pool reset (driver-level `RESET CONNECTION`) will release `sp_getapplock` unexpectedly; pin the connection out of the pool for the duration. | `pg_advisory_lock(hashtext('egdb.js.compress.' || current_database()))` — session-scoped by default. Recommended over `pg_advisory_xact_lock` because compress spans multiple per-table transactions. Release with the matching `pg_advisory_unlock` in `finally`. |
| Phase 3 UPSERT | **Prefer UPDATE-then-INSERT-where-not-exists** in a single transaction with `WITH (UPDLOCK, HOLDLOCK)` on the base PK row. Pattern: `BEGIN TRAN; UPDATE base WITH (UPDLOCK, HOLDLOCK) SET ... WHERE OBJECTID = @oid; IF @@ROWCOUNT = 0 INSERT INTO base (...) VALUES (...); COMMIT;`. This is race-free under SERIALIZABLE and does not rely on `MERGE`. Microsoft's current guidance explicitly cautions against `MERGE` for new code (https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql) due to long-standing concurrent-write defects (KB 3066097 and related). Use `MERGE` only as a fallback; if you do, you MUST set `WITH (HOLDLOCK)` on the target — and accept that the race surface is wider than the UPDATE-then-INSERT pattern. | `INSERT ... ON CONFLICT (<pk>) DO UPDATE`. No equivalent race because of the PK serialisation guarantee. **Hazard:** PostgreSQL Esri base table casing varies by registration era — tables registered through older ArcGIS Pro versions may preserve uppercase identifiers (e.g., `OBJECTID`), while newer registrations lowercase them. Do NOT assume either casing. **Detect column casing at compress start by querying `information_schema.columns` for the base table's PK column; build the `ON CONFLICT` target name to match the actual catalog casing (quoted as-is). Cache per-table.** Phase 3 MUST fail with a clear `InsufficientSchema` error at the precondition check, before any graduation work, if the base table's PK column cannot be located. The same case-sensitivity hazard applies to geometry-column type lookups. |
| Phase 3 DELETE FROM A-table | `DELETE a1 FROM ${aTable} a1 WHERE ...` (aliased) is SQL Server syntax. | `DELETE FROM ${aTable} a1 USING ... WHERE ...` is PostgreSQL syntax. The two are not interchangeable; implementation must branch on dialect. |
| SHAPE column type | `geometry` / `geography` native types or SDE binary `varbinary(max)`. | ST_Geometry (custom registered type) or PostGIS `geometry`. For ST_Geometry, base and `a<N>` share the same registered type, so column-to-column copy needs no cast. |

### 11.2 Visibility during graduation

Each per-OID graduation in Phase 3 must be a **single transaction with row locks on the base PK** so that concurrent versioned-view readers never see the row in both `base` and `a<N>` simultaneously:

- **SQL Server:** wrap the UPSERT and the subsequent `DELETE FROM a<N>` in one transaction. Use `WITH (HOLDLOCK, UPDLOCK)` on the base PK row during UPSERT to block versioned-view selects.
- **PostgreSQL:** `REPEATABLE READ` or `SERIALIZABLE` isolation, plus `SELECT ... FOR UPDATE` on the base PK row, ensures the transition window is invisible.

**Verification probe (recommended):** at idle, the set of OIDs present simultaneously in `base.OBJECTID` and `a<N>.OBJECTID` for graduable states must be empty between transactions. Add this to `CompressResult` diagnostics.

---

## 12. Performance Characteristics

- **Phase 1 cost** scales with the number of states being pruned, which scales with the number of save operations made since the last compress. Each pruned state requires a small number of system-table DELETEs and (potentially) DELETEs of its delta rows.
- **Phase 2 cost** scales with the number of "candidate lineage" runs to collapse.
- **Phase 3 cost** scales with the number of graduable delta rows × the number of registered tables. Each graduable A-row produces at most one UPSERT on base; each graduable D-row produces at most one DELETE on base.
- **Indexes Compress relies on:**
  - Primary key / unique index on `SDE_states (state_id)` and a non-clustered index on `parent_state_id` (the latter for Phase 1's branch-point check).
  - Index on `SDE_state_lineages (lineage_id, lineage_name)` and the reverse, to answer "is S an ancestor of every version tip?" efficiently.
  - Indexes on `a<N> (SDE_STATE_ID)`, `a<N> (OBJECTID)`, `D<N> (SDE_STATE_ID)`, `D<N> (DELETED_AT)`. These are created by ArcSDE at versioning registration.
  - PK on base table's OBJECTID — needed for UPSERT in Phase 3.

A compress on a quiescent geodatabase with no editors is generally O(|delta rows| + |states|) in DB work.

---

## 13. Diagnostics

- **Output:** Pro's GP tool emits a success or failure message and a brief summary in the Messages pane. There is no row-level audit.
- **Verification queries** (DOCUMENTED via recommended-version-administration-workflow + Esri community):
  - `SELECT state_id FROM sde.SDE_versions WHERE name = 'DEFAULT'` — should be a **low value** after full compress (not necessarily 0; do not hardcode `= 0` as a check).
  - `SELECT COUNT(*) FROM sde.SDE_states` — should be near 1 after full compress with no editors.
  - `SELECT COUNT(*) FROM sde.a<N>` and `SELECT COUNT(*) FROM sde.D<N>` for each registered N — should be empty (or only contain rows still referenced by a live version) after full compress.
- **SDE_compress_log:** referenced in some legacy docs. egdb.js should not depend on it.
- **Implementation guidance:** egdb.js should produce its own structured log of what was pruned/collapsed/graduated, with per-table counters, and return it as a `CompressResult`.

---

## 14. Known Quirks and Gotchas

- **"Compress doesn't reduce delta tables"** — almost always caused by (a) unposted child versions, (b) active editor sessions, or (c) orphaned states from crashed sessions (rows in `SDE_state_locks` still present, blocking branch pruning). Esri's recommended remediation is reconcile+post+delete-versions, then disconnect everyone, then re-run compress.
- **Crashed editor sessions leave `SDE_state_locks` rows behind.** Compress will not prune the branches those locks reference. egdb.js's `cleanupStaleLocks()` is the right pattern; run it before compress.
- **"Partial compress" is expected behaviour, not a bug.** Compress is by design transactionally per-table; if some branches are locked or some tables fail, the operation stops cleanly mid-way. Re-run.
- **`sdegdbrepair` / "Repair Version Tables"** is the documented tool for genuine delta-table inconsistencies — out of scope for compress itself but worth mentioning to operators.
- **Lock-file / `.sde` connection corruption** can cause compress to refuse to run; not algorithmic, but worth handling at the connection layer.

---

## 15. Refuted / Weak Claims (transparency)

During verification the following plausible statements were **not** supported by the primary docs:

- "Administrators must reconcile and post before compress." — Rejected. Reconcile+post is recommended for effective compress, not required for compress to run.
- "Tables are locked in exclusive mode during compress by default, relaxable via USE_EXCLUSIVE_LOCKING." — Rejected as overstated. Modern compress does not take database-wide exclusive locks; USE_EXCLUSIVE_LOCKING is a legacy DBTUNE knob whose modern semantics are unclear in current Pro docs.

---

## 16. Recommended egdb.js Implementation Outline

**Cross-table coupling (READ THIS FIRST).** Each phase's state-tree edits affect **every** registered table's delta tables. Phase 1 cannot delete an `SDE_states` row until that state's `a<N>` and `D<N>` rows have been processed (deleted or graduated) **for every registered table N**. Phase 2 cannot delete a removed child state C until C's `SDE_STATE_ID` has been rewritten to the parent's `state_id` in every `a<N>` and `D<N>`. Phase 3 must run for graduable states **before** any prune step that would destroy graduable A-rows. Treat Phase 1/2/3 as a single coordinated pipeline keyed on `(state, table)` pairs, not as three independent loops.

**Phase ordering — divergence from Esri's primary docs (justification).** Section 3 of this spec lists the canonical Esri ordering as Phase 1 -> Phase 2 -> Phase 3 (verbatim from the ArcSDE 10.0 SDK and the Pro/ArcMap pages). The Section 16 outline below executes Phase 3 first, then Phase 1, then Phase 2. The safety argument: Phase 1's prune predicate (Section 3.1) explicitly excludes any state in any surviving version's lineage closure, and the graduable prefix (Section 3.3) is by definition a subset of every version's closure, so Phase 1 cannot prune a graduable state regardless of order. Both orderings are therefore correctness-equivalent. egdb.js runs Phase 3 first to make the cross-table coupling above easier to reason about in code (graduate-then-prune is monotonic: nothing graduated can be lost to a later prune). Implementers comparing against Esri's documented step order should treat this as an intentional, justified divergence; both orderings produce identical end state on a quiescent database.

```ts
async function compress(egdb: EnterpriseGeodatabase, opts?: CompressOptions): Promise<CompressResult> {
  // 0. Pre-flight
  await assertGeodatabaseAdmin(egdb);
  await acquireAdvisoryLock(egdb, 'egdb.compress');

  try {
    const tables = await listVersionedTables(egdb);

    // 1. Identify active editor branches (rows in SDE_state_locks) AND their descendants AND their ancestors.
    //    SDE_state_locks records ONLY the specific state the editor holds; the exclusion set must
    //    expand both downward (descendants — protect unsaved A/D rows) and upward (ancestors —
    //    preserve the lineage the editor's reads resolve through):
    //
    //    -- The locks themselves
    //    SELECT state_id FROM SDE_state_locks
    //    UNION
    //    -- Ancestors of each lock L: JOIN SDE_states to look up L's lineage_name,
    //    -- then take closure rows under that lineage_name with lineage_id <= L.state_id.
    //    -- (Within a lineage_name, state_id IS lineage order from root to tip.)
    //    SELECT sl.lineage_id
    //    FROM SDE_state_locks lk
    //    JOIN SDE_states sLock ON sLock.state_id = lk.state_id
    //    JOIN SDE_state_lineages sl ON sl.lineage_name = sLock.lineage_name AND sl.lineage_id <= lk.state_id
    //    UNION
    //    -- Descendants of each lock L: any SDE_states row S whose lineage_name has
    //    -- L as a closure member AND S.state_id >= L.state_id.
    //    SELECT sDesc.state_id
    //    FROM SDE_state_locks lk
    //    JOIN SDE_state_lineages sl ON sl.lineage_id = lk.state_id
    //    JOIN SDE_states sDesc ON sDesc.lineage_name = sl.lineage_name AND sDesc.state_id >= lk.state_id
    //
    //    The naive `lineage_name IN (state_id list)` pattern in earlier versions
    //    of this spec was wrong: lineage_name is a TREE identifier (per
    //    SDE_states.lineage_name), NOT a state_id. Joining via SDE_states
    //    looks up the correct tree per lock.
    //
    //    An implementer who reads "SELECT state_id FROM SDE_state_locks" literally would prune
    //    in-flight child states (destroying unsaved A/D rows) or ancestor states (corrupting
    //    versioned-view reads through the locked state when DEFAULT has moved). See Section 6.1.
    const lockedBranches = await readLockedBranches(egdb); // includes ALL descendants AND ancestors of each locked state

    // 2. Compute the graduable prefix FIRST, before any destructive work.
    //    (lineage-closure intersection across all SDE_versions tips; see 3.3, 4.2)
    const graduableStates = await computeGraduablePrefix(egdb);

    // 3. Phase 3 — graduate delta rows to base, per registered table, in its own transaction.
    //    Per-table revalidation (Section 6.5 option 2) MUST happen INSIDE the transactional
    //    fence: begin the transaction at SERIALIZABLE (PG) or REPEATABLE READ + WITH (HOLDLOCK,
    //    ROWLOCK) on SDE_versions (SQL Server); inside the transaction recompute the graduable
    //    prefix from current SDE_versions/SDE_state_lineages and compare it to the snapshot.
    //    The correct test is a SUBSET check, not "any tip moved":
    //      - If the recomputed prefix is a SUPERSET of the snapshot prefix
    //        (snapshot ⊆ recomputed), the snapshot remains safe — proceed with the snapshot.
    //        This is the common path: a post that extends DEFAULT's tip downstream adds states
    //        to DEFAULT's closure, never removes ancestors from any other version's closure.
    //      - If at least one state in the snapshot prefix is NOT in the recomputed prefix
    //        (snapshot ⊄ recomputed), some new version was created during compress whose
    //        closure excludes states we considered graduable — ABORT this table.
    //    Aborting on every tip move would skip most tables on a busy Putnam-scale system where
    //    posts can happen during a long compress; the subset check tolerates the normal case
    //    while correctly rejecting the genuine invalidation (concurrent new-version creation).
    const perTable = [];
    for (const t of tables) {
      perTable.push(await egdb.transaction(async () => {
        // First read inside the transaction: recompute under the fence, compare as subset.
        const recomputed = await computeGraduablePrefix(egdb);
        if (!isSubsetOf(graduableStates, recomputed)) {
          return { table: t.name, status: 'skipped-version-set-changed' };
        }
        return graduateTable(egdb, t, graduableStates);
      }, { isolation: 'serializable', lockSdeVersions: true }));
    }

    // 4. Phase 1 — prune unreferenced, non-branch-point, unlocked states.
    //    INVARIANT: no delta row at state S may be deleted before re-confirming, under
    //    appropriate locking, that S is not in any current lock's expanded closure AND not
    //    in any surviving version's lineage closure. A concurrent EditSession that calls
    //    acquireStateLock() and creates a child state C of S between the start-of-compress
    //    snapshot and a per-table DELETE would otherwise lose its A/D rows at S irrevocably —
    //    the metadata transaction's recheck (b)-(d) only stops the SDE_states delete; it
    //    cannot un-delete delta rows. The recheck must therefore run inside EACH per-table
    //    delta-row-deletion transaction, BEFORE the DELETE.
    //
    //    For each prune-candidate state S, in its own transaction PER TABLE:
    //      BEGIN TRANSACTION (SERIALIZABLE on PG; REPEATABLE READ + WITH (HOLDLOCK, ROWLOCK)
    //      on SDE_state_locks AND SDE_versions on SQL Server).
    //      a0. Re-evaluate the prune predicate from current SDE_state_locks + SDE_versions:
    //          S must still be (i) not in any version closure, (ii) not in any locked branch's
    //          expanded closure (locks ∪ descendants ∪ ancestors per step 1). If the recheck
    //          fails, ROLLBACK and skip this (state, table) pair.
    //      a1. DELETE FROM a<N> / D<N> WHERE SDE_STATE_ID = S OR DELETED_AT = S.
    //      COMMIT.
    //    Then in a separate metadata transaction (after EVERY table has committed for S):
    //      b. Re-evaluate the prune predicate one final time under the same locking; if it
    //         now fails, abort the metadata phase for S and record a partial-skip (note: the
    //         delta rows are already gone — this can only happen if a new lock arrived for an
    //         ancestor between the last per-table commit and this metadata transaction; the
    //         delta-row loss is conservative but the prune is aborted to preserve the state's
    //         identity in SDE_states for the newly-locked branch's reads).
    //      c. DELETE FROM SDE_state_lineages WHERE lineage_id = S OR lineage_name = S.
    //      d. DELETE FROM SDE_states WHERE state_id = S.
    //      e. DELETE FROM SDE_mvtables_modified WHERE state_id = S. (See Section 8.)
    //    Order is mandatory: delta-table rows for S must be gone in every table before (c)-(e).
    const prunedStates = await pruneStateTree(egdb, tables, lockedBranches);

    // 5. Phase 2 — collapse candidate lineages (child C collapses into parent P; P survives).
    //    Dedupe BEFORE rewrite (lineage position information is destroyed by the rewrite).
    //    For each collapsible (P, C), in its own transaction PER TABLE:
    //      a. Dedupe per OBJECTID using PRE-rewrite lineage position: winner = row at state
    //         closest to the version tip (smallest hop count from tip; for a P->C chain that
    //         means C, the child, wins over P). Delete the loser row from a<N>/D<N>.
    //         (See 3.2 step 3 / 3.4 / 4.4.)
    //      b. UPDATE the surviving a<N>/D<N> rows: SET SDE_STATE_ID = P WHERE SDE_STATE_ID = C
    //         (and rewrite DELETED_AT = C -> P for D-rows).
    //    Then in a SINGLE metadata transaction PER COLLAPSE (atomic with the SDE_states delete):
    //      c. Rewrite SDE_state_lineages entries referencing C -> P.
    //      d. UPDATE SDE_mvtables_modified SET state_id = P WHERE state_id = C. (See Section 8.)
    //      e. UPDATE SDE_versions SET state_id = P WHERE state_id = C.  (No-op in steady state;
    //         covers the race where a version was created concurrently with compress and points
    //         at C. Doing this in the same transaction as the DELETE avoids any window in which
    //         SDE_versions.state_id references a deleted SDE_states.state_id.)
    //      f. DELETE FROM SDE_states WHERE state_id = C.
    //    There is no separate "update version tip pointers" pass; step e maintains consistency
    //    throughout. After a full compress with only DEFAULT and no editors, DEFAULT.state_id is
    //    the root of the fully-collapsed chain (a low value; see Sections 8 and 13).
    const collapsed = await collapseCandidateLineages(egdb, tables, lockedBranches);

    return { prunedStates, collapsed, perTable };
  } finally {
    await releaseAdvisoryLock(egdb, 'egdb.compress');
  }
}
```

**Critical safety rails:**
1. Never delete a state row without first deleting its `SDE_state_lineages` rows and its delta-table rows.
2. Never start Phase 3 for a table without verifying the table's base PK exists and is queryable.
3. Always commit per-table; never one giant transaction.
4. Always observe `SDE_state_locks` — never compress a branch held by a live session. "Branch" means the locked state **and all of its descendants**, not just the single locked row.
5. Surface a structured `CompressResult` so callers can detect partial completion.
6. **Never delete a row from `SDE_states` until every registered table has had its delta rows (`a<N>`, `D<N>`) for that `SDE_STATE_ID` (and `DELETED_AT`) processed.** Equivalently: Phase 1's state-row delete is the last step in a fan-out across all tables; if any table's transaction fails, the state row must not be deleted.

---

## Appendix A — Primary Source Index

- Compress GP tool reference (Pro): https://pro.arcgis.com/en/pro-app/latest/tool-reference/data-management/compress.htm
- Recommended version administration workflow (Pro): https://pro.arcgis.com/en/pro-app/latest/help/data/geodatabases/overview/recommended-version-administration-workflow.htm
- The compress operation and geodatabases (ArcMap latest): https://desktop.arcgis.com/en/arcmap/latest/manage-data/geodatabases/the-compress-operation-and-geodatabases.htm
- Geodatabase compress operation (ArcMap 10.3 SQL Server): https://desktop.arcgis.com/en/arcmap/10.3/manage-data/gdbs-in-sql-server/geodatabase-compress-operation.htm
- Geodatabase compress operation (ArcMap latest SQL Server): https://desktop.arcgis.com/en/arcmap/latest/manage-data/gdbs-in-sql-server/geodatabase-compress-operation.htm
- ArcSDE 10.0 SDK compression internals: https://help.arcgis.com/en/geodatabase/10.0/sdk/arcsde/concepts/versioning/basicprinciples/compression.htm
- Compress operation (resources.arcgis.com 10.2): https://resources.arcgis.com/en/help/main/10.2/002m/002m00000051000000.htm
- SQL Server system tables (ArcMap 10.3): https://desktop.arcgis.com/en/arcmap/10.3/manage-data/gdbs-in-sql-server/system-tables-sqlserver.htm

---

## Appendix B — Glossary

- **A-table / adds table (`a<N>`)** — Inserts and update post-images for registered table N.
- **D-table / deletes table (`D<N>`)** — Deletes and update pre-images for registered table N.
- **Base / business table** — The user-visible table that holds the "committed" rows.
- **Candidate lineage** — A chain of states that can be merged without changing what any version sees.
- **Graduable prefix** — The set of states that are ancestors of every version tip; their delta rows can move to base.
- **Registration ID** — The integer in `SDE_table_registry.registration_id` used to name `a<N>` and `D<N>`.
- **State** — A node in `SDE_states`. Each edit save creates a new state child of the previous.
- **State lineage** — The chain of ancestors of a state. Materialised as a closure table in `SDE_state_lineages`.
- **Version tip** — The `state_id` recorded in `SDE_versions` for a given version.
