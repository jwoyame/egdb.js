# `rebaseVersion` — usage & safety guide

Audience: developers and future Claude sessions working on egdb.js / OpenParcels.
Read this **before** calling `EnterpriseGeodatabase.rebaseVersion`.

> **Status (2026-07-27): NOT production-ready — gated behind `{ unsafeExperimental: true }`.**
> Correctness is complete and harness-pinned; the full chain is validated on the
> training fabric; it has **not** been wired to a route or run on live. See
> "Current status" below before doing anything with it.

---

## 1. What it does and when to use it

A **rebase** takes a version that is "stuck" — its diff against DEFAULT is enormous
or it can't post/load — and re-bases the editor's *own* work onto DEFAULT's current
tip, discarding accumulated reconcile residue. The result is a version that carries
exactly the editor's edits, sitting directly on current DEFAULT, ready to post.

Use it for:
- **Compress-orphans**: a version un-reconciled across a compress, re-rooted to
  `parent_state_id = 0`, whose only shared ancestor with DEFAULT is base 0.
- **Heavily-reconciled versions**: thousands of parent rows copied in, so Review
  crawls and Post times out even though the editor changed a handful of features.

It is **not** a substitute for normal reconcile/post. A healthy version should go
through the standard reconcile → post path (and its conflict UI).

How it works: find the common ancestor with the parent; branch a fresh state off
the parent's *current* tip; replay only the rows that differ from the ancestor
(three-way, delete-aware); move the version's pointer onto the new state; seed the
new lineage's closure = base + parent's parent-walk ancestry + new state.

---

## 2. Current status — what's done, what's not

**Done & harness-pinned** (`tests/rebase/`, 18 DB-backed tests + 197 unit):
correctness defects A–H (closure seeding, three-way compare, conflict detection,
delete-aware resolution, parent lock, native delete markers) and all "lesser"
issues (in-SQL state walks, `CHUNK=1000`, `wasInTx`, idempotent no-op, open-session
guard). Each substantial fix was independently vetted. See
`docs/REBASE_TEST_HARNESS.md` and the method's own doc-comment.

**Validated on the TRAINING fabric** (`parcel_fabric_test`): full read-only dry-run
across all versions; a real **rebase → post** on a clean version (Tracey, 47 edits
across 4 tables) — proving post succeeds with no prior reconcile; and A7 — a
rebased version passes the compress closure-safety gate.

**Still open before ungating:**
- A prune/compress pass with a rebased version present is *proven to be gated
  correctly* but the prune itself hasn't completed on real data (blocked by the
  training fabric's leaked-lock cadence — a compress-side operational issue).
- No `favor_target` conflict resolution yet (see §5).
- Never wired to a route; never run on live.

---

## 3. How to run it safely

1. **Dry-run first, always.** `rebaseVersion(name, { dryRun: true })` is read-only.
   It returns `{ replayed, droppedRedundant, conflicts, ... }`. Inspect it:
   - `conflicts` non-empty → **do not** auto-rebase (see §5).
   - `droppedRedundant` large + `replayed` small is normal for a reconciled version
     (residue dropped). `droppedRedundant` large on a version *nobody reconciled* is
     a red flag — investigate before writing.
2. **On the training fabric, verify the SDE proc rebind is clean first.** A rebase
   is **proc-driven** (`createChildState` → `SDE_state_new_edit`), which is exactly
   the 3-part-baked-ref bleed path: if `parcel_fabric_test` procs still 3-part-ref
   the live DB, a rebase **writes to PROD**. Check `sys.sql_modules` for
   `parcel_fabric.sde.` / `parcel_fabric.pa.` refs = 0 before any write. Direct-SQL
   reads/deletes are always prod-safe; proc-driven edits are the risk path.
3. **Then** `rebaseVersion(name, { unsafeExperimental: true })`. It refuses without
   that flag.
4. It is **reversible before post**: it only moves the version's pointer, so repoint
   the version's `state_id` back (via `updateVersionState`) to undo — until a
   compress reclaims the old state. Post is not as easily reversed (it advances
   DEFAULT); undo a post by repointing DEFAULT back to its pre-post tip (its parent).

Scripts (training only): `scripts/train-rebase-dryrun.mjs`, `train-write-test.mjs`,
`train-undo-post.mjs`, `train-a7-compress.mjs`. Connect with `encrypt:false` over
the fetch tunnel. Password lives in `openparcels/RDS_ACCESS.local.md` (the
`Sketchy1` in CLAUDE.md is stale).

---

## 4. DO / DON'T

**DO**
- Dry-run and read the conflict count before every real rebase.
- Verify the rebind (§3.2) before any proc-driven write on training.
- Prefer the standard reconcile/post UI for normal versions.
- Treat a rebased version as a normal reconciled version afterward — it posts,
  and it passes the compress closure gate.

**DON'T**
- **Don't ungate it / wire it to a route** until it has run the full chain on a
  real fabric (post + compress) and the remaining items in §2 are closed.
- **Don't run it on live** yet. It has only run on training.
- **Don't `acceptConflicts` blindly** — see §5. For pure residue conflicts it
  would *revert DEFAULT's newer values*.
- **Don't `GRANT VIEW SERVER STATE TO [sde]`** to work around the compress
  leaked-lock defer. `sde` is a shared server-level login; the grant is
  instance-wide and re-enables the strict-path reaper on PROD, which is unsafe for
  OpenParcels persistent EditSessions. Clear stale locks with a DB-scoped DELETE on
  `parcel_fabric_test` instead.
- **Don't pass `options.tables`** to the compress that follows a rebase unless the
  fabric is single-table (it scopes prune/collapse and corrupts excluded tables).

---

## 5. Conflicts — the important subtlety

A conflict = an OID the editor changed **and** DEFAULT changed differently since the
common ancestor. `rebaseVersion` **refuses** by default (safe — a human resolves).

Two resolution options exist / are needed:
- `acceptConflicts: true` = **favour-edit** — replays the editor's value over
  DEFAULT's. **This is correct only for genuine editor conflicts.** On a
  heavily-reconciled version, most "conflicts" are stale reconcile **residue** that
  diverged from a moved DEFAULT — favour-edit there would **overwrite DEFAULT's
  newer values with old residue**. Do not use it to force such versions through.
- **favour-target (drop the residue, take DEFAULT) is NOT yet implemented.** Until
  it is, conflict-heavy versions (real examples on training: one with 680, one with
  46) must go through the **standard rec/post conflict UI**, which resolves per-OID.

Rule of thumb: `conflicts == 0` → safe to rebase. `conflicts > 0` → route to the
conflict UI, don't auto-resolve.

---

## 6. How it interacts with compress

- **A rebased version passes the Step-D closure-safety gate** (`assessClosureSafety`).
  The rebase forces the new state onto its **own** `lineage_name` and seeds the
  closure to exactly the parent-walk ancestry, so `OVER = 0` and there is no shared
  divergent lineage. Verified on the training fabric. (If it ever *didn't* pass, the
  compress would refuse the whole run rather than corrupt — but it must pass, or it
  blocks the nightly compress fabric-wide.)
- **Its delete markers are never graduable while unposted.** Editor deletes are
  written natively at the new state (`insertDeleteMarkers`), which is the version's
  own tip — never a common ancestor of all tips — so `computeGraduablePrefix`
  excludes it and an unposted delete can't graduate into `DELETE FROM base`.
- **Prune reclaims what a rebase/undo orphans** (e.g. an undone post's state).

---

## 7. Pointers

- Method + full defect history: `rebaseVersion` doc-comment in
  `src/enterprise-geodatabase.ts`.
- Test harness design + scenarios: `docs/REBASE_TEST_HARNESS.md`.
- Classifier internals: `classifyChildChanges` in `src/reconcile/set-copy.ts`.
- Session memory (for Claude): `project_rebase_version_status`,
  `project_rebase_training_dryrun`, `project_training_writes_leak_to_prod`.
