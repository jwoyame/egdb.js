# rebaseVersion test harness — design (rev 2)

## Why this exists

`rebaseVersion` has been "validated" twice and was wrong both times.

- **Round 1** shipped to a live fabric and leaked an unposted version's edit state
  into DEFAULT's lineage closure, exposing un-reviewed parcels to the publish ETL.
- **Round 2** fixed that, passed a training run against a real compress-orphan on
  every check written, and was *still* wrong: seeding only the new state into the
  closure makes `isReconciled` fail, so **post refuses outright**, and it empties
  compress's graduable prefix database-wide.

Both rounds checked **the shape of what the operation produced** and never
checked **whether the version still worked afterwards**. `post` and `compress`
were never run.

Rev 1 of this plan repeated the mistake in a subtler form: its central invariant
was **relative** ("content identical before and after"), which is blind to any
defect that faithfully preserves an already-wrong state, and which a *correct*
fix would violate. This revision replaces it with an **absolute oracle**.

The harness's job is to **falsify** `rebaseVersion`. A scenario that cannot fail
does not earn its place.

## Part 0 — the oracle (the thing rev 1 got wrong)

### Fixture ledger — captured, not declared

**Capture rule (load-bearing).** After each fixture save, and **before any
reconcile**, read the raw `a<regid>` / `D<regid>` rows written at the fixture's
own edit states, straight from the delta tables. That physical capture *is* the
ledger:

```
{ table, objectId, op, atState, row: <full row>, by: 'editor'|'parent',
  expectedInVersion, expectedInDefaultAfterPost, undecidable?: <reason> }
```

Two reasons this must be a physical capture rather than declared API intent:

- **It stays non-circular.** Plain SQL over delta tables, never
  `selectChangedObjectIds` / `getAllChanges`. An implementer reaching for those
  would reintroduce exactly the circularity rev 2 exists to kill.
- **It catches implicit rows.** A fabric op (split, merge, reshape) writes Lines,
  Points and relationship rows the editor never named. Declared intent would push
  those into bucket (ii) below, where the invariant would wrongly demand they
  equal the parent's tip — they are editor work.

Rows that appear in the child's states *later* are residue by construction.

**Undecidable rows.** Some expectations cannot be fixed at build time:
conflicts (S12 — the expectation is on the *operation*, not the rows); S7×S3
composed (editor restores a prior value *and* the parent has since changed that
OID — correct behaviour is genuinely ambiguous); OBJECTID reuse post-compress
(S23 — depends on graduation order). Mark these `undecidable: <reason>` and
assert against an **enumerated admissible set** (which may include "refused").
Fail loudly if the DUT lands outside it. **Never skip** — silently skipping the
hard rows is how round 2 went green.

### The two-part content invariant (replaces rev 1's keystone)

Rev 1 asserted "resolved content identical before and after". That is wrong: for
an OID whose child row was pure reconcile residue and whose parent has since
advanced, a **correct** rebase re-resolves it to DEFAULT's newer row — content
legitimately changes. Rev 1 would have failed the fix and passed the bug.

Correct form, after a rebase of version V onto parent P:

- **(i) Editor-touched OIDs** — defined as **every row physically written into
  the fixture's own edit states** (the capture above), not declared intent:
  resolved content in V is identical before and after, and equals
  `expectedInVersion`.
- **(ii) Every other OID**: resolved content in V equals **P's tip resolution**.

Part (ii) is what catches D, and it also catches a **ninth defect not on the A–H
list**: `selectChangedObjectIds` compares only against the parent's **A-row tip**
and never consults the parent's D-table, so an OID the parent *deleted* after the
branch point, for which the child carries residue, compares "changed", is
replayed, and is **resurrected in V**. Track it as **defect I**, not as an S3
duplicate.

Plus a **refusal contract**: if V has unresolved conflicts (an OID edited by both
the editor and the parent since the common ancestor), `rebaseVersion` must refuse
or report them, not silently pick a winner. S12 asserts against that contract.

### Baseline pass — required before any structural assertion

A6, A7 and A15 are absolute claims about fabric structure, and a restored real
fabric carries **pre-existing dirt**: closure rows referencing pruned states,
already-graduable base rows that will legitimately graduate on the first
compress. Asserting absolutes against that produces reds the DUT did not cause —
and the first such red gets the assertion muted. That is precisely how both prior
rounds ended.

So, before scenarios run:

1. Restore BASE → run `compress()` → record the legitimate
   (disappeared / changed / appeared) base delta and `prefix_before`.
2. Restore BASE again → run the scenario.

**Every structural assertion is `scenario delta − baseline delta`.** Absolutes
are only used where the baseline is provably empty.

## Preconditions

### Provisioning guards (mechanical, re-run after every restore)

Refuse to start unless all hold:

- `DB_NAME()` in an explicit allowlist and **not** `parcel_fabric`.
- Server is not the production RDS host; ideally no network route to it.
- `sys.servers` has **no linked servers** — that is the actual mechanism by which
  training writes once reached production.
- **3-part-name scan**: `OBJECT_DEFINITION` of every `sde` proc, *view and
  function* contains no database literal other than `DB_NAME()`. Mechanical, not
  eyeballed, and re-run after each restore.
- Sentinel table `harness_target_marker` exists **and its provisioning UUID
  matches the runner's** (a copied sentinel must not authorise).
- The BASE snapshot exists (otherwise scenarios silently share state).
- No non-harness sessions connected.
- `HARNESS_I_UNDERSTAND_THIS_IS_DESTRUCTIVE=1`.

No `--force`.

### Geometry storage — decides whether the design is valid at all

Query `sde.SDE_layers` for the storage type. If the fabric is **SDEBINARY**
rather than **SQLGEOMETRY**, geometry does not live in the A-table: a
geometry-only edit would compare **equal** under `selectChangedObjectIds` and be
dropped, and `copyTipRows` would copy an incomplete row. This single query
determines whether the whole comparison approach holds. Record it in the report,
and include a **geometry-only-edit scenario** to prove it empirically.

### Host

An **amd64 VM with SQL Server Developer edition**, not Docker on Apple Silicon
(emulated x86 makes compress and the scale scenario painful). RDS is out: Web
edition supports neither database snapshots nor single-user mode.

Restoring a real Putnam backup additionally needs: `ALTER USER sde WITH LOGIN =
sde` (orphaned user after restore), db ownership / `EXECUTE AS` for the SDE
procs, and source engine version ≤ target. **No ArcGIS keycode is required** —
egdb speaks plain SQL and `_evw` is T-SQL — worth stating so nobody blocks on it.
Spatial indexes restore fine; stale stats are a perf matter only.

### Snapshot mechanics

SDE's state lives in in-database user tables (`SDE_states`,
`SDE_state_lineages`, `SDE_versions`, `SDE_object_ids`, `SDE_state_locks`,
`SDE_process_information`), so a database snapshot reverts all of it. But:

- Restore requires no other connections → `ALTER DATABASE … SET SINGLE_USER WITH
  ROLLBACK IMMEDIATE`, restore, `MULTI_USER`; drain the mssql pool first.
- **Construct a fresh `EnterpriseGeodatabase` per scenario.** Session context
  from `sde.set_current_version`, cached connection ids, and the column caches in
  `set-copy.ts` must not survive a restore.
- Only one snapshot may exist to restore from.

### Test seam (required, built in step 1)

`rebaseVersion` needs `__testHooks { afterPlan, beforeMarkers, beforeCommit }`
(or a plan/apply split). Without a deterministic interleave, the concurrency
scenarios are wall-clock races — flaky in both directions, and muted within a
month. This is a prerequisite, not a nice-to-have.

## Scenario catalogue

| # | Scenario | Targets |
|---|---|---|
| S1 | Clean version, parent unchanged | Baseline; A/B in the inherited-lineage branch |
| S2 | Version with reconcile residue | Primary case |
| S3 | Residue, **then parent re-edits the same OIDs** | **D** — via invariant (ii) + ledger-based A5 |
| S4a | Create+delete **in the same child state** | **E** — invisible to egdb's reader; needs `_evw` |
| S4b | Create+delete **in different child states** | **E** — visible to egdb's reader |
| S5 | Delete, then reconcile copies parent's row back | **E** — deletion lost |
| S7 | Edit that restores a previous value | Whole-history false-drop; three-way correctness |
| S8 | Concurrent **post into DEFAULT** (via seam) | **F** — surfaces at post, needs A5 |
| S9 | Concurrent **child save** (via seam) | Optimistic repoint guard |
| S10 | Open `EditSession` on the version | Must refuse |
| S11 | One OID edited across several child states | Tip selection + **cardinality** |
| S12 | Child and parent both edit one OID | **Conflict contract** |
| S14 | DEFAULT tip **with** and **without** an existing child | **C** — run as a variant across S1/S2 |
| S15 | Compress-orphan (shares only base) | base-0 ancestor path |
| S16 | Rebase twice | Idempotency — folded into A10 |
| **S17** | Pure delete whose parent row is an **uncompressed A-row** (and a variant with both a base row and a newer parent A-row) | **G** — the only shape that exposes it |
| **S18** | **Rebase → compress with NO post**, closure fix simulated | **H** — see below |
| **S19** | Unposted **update** of a base-resident feature → compress | **New defect** (below) |
| **S20** | Parent ≠ DEFAULT (nested version) | `getStatesInRange(parent,0)` walks a grandparent chain — untested |
| **S21** | Version already at parent tip / zero changes | Today still allocates a state and truncates the closure, turning a postable version unpostable. Cheap, likely red |
| **S22** | States shared with a sibling version | "old states become unreferenced" is false here |
| **S23** | OID with a D-row and **no A-row anywhere** | Writes a state-0 marker for a nonexistent OBJECTID; OBJECTID reuse then hides a future insert |
| **S24** | Base-shadow markers from prior posts present | Real live shape (the retrofit) |
| **S25** | Geometry-only edit | Validates the storage-type precondition empirically |
| **S26** | Cross-table referential: parcel kept, its lines/points in other tables/states | Partial replay |
| **S27** | **Rebasing a version that itself HAS a child version** | Repointing V leaves V's child descending from V's *old* state: the child's resolution silently diverges from its parent, and `deleteVersion`/compress reference-counting still sees the old states as referenced. Real corruption path, uncovered by S20 (which is the inverse) |
| **S28** | Parent **deleted** an OID after the branch point; child carries residue for it | **Defect I** — `selectChangedObjectIds` never consults the parent's D-table, so the row is replayed and resurrected |

Demoted to unit tests (no fabric needed): **S13** scale → prove the 1000-row
`VALUES` limit and `CHUNK=2000` against the SQL builders, plus one 2,001-OID
integration run. **S6** collation → unit-test `comparableExpr` against the
fabric's actual collation.

### The new defect S19 targets

`insertSupersedeMarkers` also emits markers for **updates** (`supersedes`), at
`SDE_STATE_ID = 0` when the superseded row is base-resident. If `0` falls in the
graduable prefix, `graduateTable` will `DELETE FROM <base>` for an **unposted
update** whose A-row lives at a non-graduable state — the feature disappears from
DEFAULT entirely. That is worse than H and is not in the current defect list.

### Why S18 needs a simulated fix

H is **not demonstrable on today's code**: defect A empties the graduable prefix,
so nothing graduates and the assertion passes for the wrong reason. S18 must seed
the closure the way the intended fix will, then compress. Otherwise A and H get
fixed together with no evidence that either worked.

## Assertion catalogue

| # | Assertion | Notes |
|---|---|---|
| A1 | Identity preserved | owner/name unchanged; `state_id` moved |
| A2 | **Two-part content invariant**, over **all versions** | Not just V and DEFAULT — a sibling branched from a mid-child state is exactly where "states become unreferenced" is false. Run under **both** readers: G and same-state E are invisible to one of them. Mechanics below |
| A3 | Closure correct + **branch asserted** | Own lineage; absent from parent's closure; parent ancestry seeded so `isReconciled` passes; no *other* lineage gained rows |
| A4 | **Post succeeds** | `postVersion(trimPost:true)` must not throw |
| A5 | **Post lands exactly the ledger's edits** | Materialise DEFAULT-before per table (`OID + HASHBYTES`), apply the **ledger** to get the expected set, two-way `EXCEPT` against DEFAULT-after. **The DUT's own diff must not appear in the expectation** |
| A6 | Compress prefix **grows or holds** | `prefix_before ⊆ prefix_after`. **Precondition: `prefix_before` must be non-empty and non-trivial, else the scenario reports INCONCLUSIVE, not pass** — on a fabric with sparse closures the intersection may already be empty, and B would go undetected |
| A7 | **Full compress is safe** | Classify base rows post-compress into disappeared / changed / **appeared**, **minus the baseline delta**; each residual must map to the ledger's *posted* set. "Appeared" is the dual of H/S19 and matches this repo's worst incident — keep it first-class. Restrict to graduation-relevant scenarios |
| A9 | Reader parity | egdb vs `_evw` for insert, update, delete |
| A10 | Marker hygiene | No duplicates; none whose A-row is missing; none carrying a parent-lineage state compress could graduate. (S16 folds into this) |
| A11 | Conflict contract | Refuse or report; never silently decide |
| A12 | Failure atomicity | Inject failure at **the two writing seams**; full rollback; version resolves as before |
| **A13** | No `SDE_state_locks` row for `newState` | Cheap |
| **A14** | No A/D row references a state absent from `SDE_states` | Cheap |
| **A15a** | Closure ⊆ parent-chain ancestry, **as a delta vs baseline** | Rebase must introduce no *new* violations. Absolute form false-fails: compress/prune history and the base-0-orphan recovery both leave legitimate stale rows. Apply the readers' own `lineage_id <= tip` filter |
| **A15b** | **parent-chain(parent tip) ⊆ closure(V)**, scoped to V | The *opposite* containment, and the one defect A actually violates — it is what `isReconciled` and `computeGraduablePrefix` require. A15a alone cannot see it |
| **A16** | Dry-run plan == what was written | Directly tests the mislabelled `deletes` counter |
| **A17** | Reversibility | Repoint to `fromState`; content == pre-rebase. Low signal but it is the documented rollback and nothing tests it |
| **A18** | **Base tables byte-unchanged by the rebase** | Rebase must never touch base. Row count + aggregate hash per table. Catches the worst class instantly |
| **A19** | **`parent_state_id(newState) == parent.stateId`**, re-read after the operation | Makes **F deterministically red with no seam**. The seam is still needed for S9/A12, but F must not depend on it |
| **A20** | **No other version moved** | `SDE_versions` (owner, name, state_id) for every row ≠ V unchanged. One query; catches collateral damage |

**A2 mechanics.** "Diff entirely in SQL under both readers" is not directly
implementable: egdb's resolution is a **TypeScript reader, not a SQL view**, so
there is nothing to `EXCEPT` against. Therefore:

- The seam must expose the reader's generated SQL (`buildVersionedSelect`) so
  both sides are SQL.
- `_evw` requires `sde.set_current_version` per version — session-scoped and
  serial; budget for that.
- **Routine path: one aggregate hash per (version, table).** Drop to per-OID
  `EXCEPT` only on mismatch. Diffing every row of every version under two readers
  on every scenario is not affordable as a default.
- Compare `CAST(Shape AS varbinary(max))`, text under `Latin1_General_BIN2`;
  never marshal geometry or datetimes through the driver. Rows are physical
  copies, so varbinary equality is sound and `EXCEPT`'s NULL-equality is desired.
- `EXCEPT` **deduplicates**, so keep a separate per-OID cardinality check
  (`GROUP BY OBJECTID, SDE_STATE_ID HAVING COUNT(*) > 1`) — that is S11's real
  failure mode and set-diffing hides it.

**Reporting**: do **not** skip A4–A7 when A2 fails. Those are precisely the
assertions both prior rounds skipped. Skip only if the rebase threw.

## Red-list — what must be red *today*, and under what conditions

"It fails on today's code" is only a valid self-test when the branch, reader and
data shape are named. Rev 1's blanket version misfires for C, G and H.

| Defect | Red today? | Requires |
|---|---|---|
| A | Yes | **Inherited-lineage branch only.** On a real fabric DEFAULT's tip usually *already* has children, which takes the fresh-lineage arm where the proc copies the parent closure and A goes green. The harness must **force** the inherited arm: create a fresh DEFAULT edit state with no children, assert which arm ran, and **fail the run if the intended arm was not exercised**. S14 pairing belongs in **step 3** |
| B | **Conditionally** | Only if `prefix_before` is non-empty — see A6's precondition. Otherwise report INCONCLUSIVE |
| C | Only if **asserted** | Recording the branch is a log line, not a gate. Assert that **both S14 arms yield equivalent closures** |
| D | Only after A5 is ledger-based | Otherwise circular |
| E | Yes, both readers | With the ledger oracle S4a also goes red under egdb's reader (ledger says absent, rebase resurrects with no marker). That is not a reason to skip `_evw` |
| F | Yes, **without the seam** | A19 (re-read `parent_state_id(newState)`) makes it deterministic. Seam still needed for S9/A12 |
| G | Only with S17's uncompressed-A-row shape | A restored fabric is mostly base-resident → green for the wrong reason |
| H | **No — masked by A** | Needs S18's simulated closure fix. Re-run S18 with the simulation **removed** once the real A-fix lands, using the same helper — otherwise the simulation is just the fix written twice |
| I (new) | Expected yes | S28 + invariant (ii) |
| S19 (new) | **Only if `0 ∈ prefix`** | Measure `0 ∈ computeGraduablePrefix()` as a precondition and record it; the verdict is meaningless without it. More likely to fire than H — state 0 survives the all-tips intersection far more readily than an arbitrary parent state. (The *posted* path is safe: `isAncestorCross(newTip, 0)` is false → UPSERT-A. Only unposted is exposed) |

## Sequencing

1. Snapshot/provision/guards + **the test seam** (including exposing
   `buildVersionedSelect` for A2). Prove restore works before a single assertion.
1.5. **Baseline pass** — BASE → compress → record legitimate deltas and
   `prefix_before`. Every structural assertion is measured against this.
2. A1/A2/A3/A15a/A15b + the cheap ones (A13, A14, A18, A19, A20) and S1.
   Green S1 proves the plumbing.
3. **A4–A7 with the S14 branch pairing, inherited arm forced.** A and B must go
   red in that arm. *If they pass, the harness is wrong.*
4. **S19** (needs only rebase + compress — no post, no ledger-A5, and it is the
   most dangerous unfixed behaviour in the file), then ledger-based A5 → S3 (D),
   S28 (I), S5/S4a/S4b (E), S7.
5. S17 (G), S18 (H, simulated fix).
6. Cheap structural scenarios: S21, S20, S27, S23, S22, S24, S25, S26, S11.
7. Concurrency via the seam: S8, S9, S10, A12 (two writing seams only).
8. Scale: unit tests + the single 2,001-OID run.

## What a green run entitles

**A green harness authorises a training run — not ungating.** Both prior rounds
failed exactly by treating a passing check as permission to proceed. Ungating
additionally requires: a training run against a restored real fabric, a
successful post *and* a nightly compress observed afterwards, and an independent
review of the diff that made it green.

## Known limitations

- **PostgreSQL is not covered.** The set-copy path is unvalidated on pg
  (identifier casing, no binary collation, PostGIS `=` may be bbox equality).
  Mark it unsupported rather than assume it works.
- **A9 is approximate.** `_evw` is the same resolution ArcGIS uses, but it is not
  ArcMap. Disagreement is meaningful; agreement is strong, not absolute.
- **Fixture realism.** Synthetic fixtures cannot reproduce every oddity of a
  20-year-old fabric (empty-shape legacy lines, sparse closure rows). Where a
  scenario depends on such a shape, seed it from a restored real fabric.
- The harness proves behaviour **on the fabric it runs against**. Use a restored
  real backup as BASE, not a fabric built from scratch.
