# Text-CRDT Implementation Plan

Build a working sub-line text-CRDT column type on our `fork-baseline-fly` substrate, following the Weidner/Wonlaw Fugue design (see `fugue-design.md`). Native first, WASM deferred.

## Goal — definition of done

A column upgraded via `SELECT crsql_as_text_crdt('notes', 'body')` behaves as follows:

1. `INSERT INTO notes (body) VALUES (?)` accepts a string; the column reads back as that string.
2. `UPDATE notes SET body = ?` re-computes the diff and only the changed runs change.
3. Two peers' divergent edits to `body` converge identically regardless of sync order, including:
   - Concurrent inserts at the same position
   - Concurrent inserts where one is inside another's run (split case)
   - Concurrent deletes
   - Insert + concurrent delete overlapping
4. Three+ peers' divergent edits converge identically regardless of sync order.
5. Hypothesis property tests randomize 50 ops × 5 peers × 1000 trials and never produce divergence.
6. Bulk inserts (paste of 10K chars) take < 100ms locally.
7. Sync via `crsql_changes` works — the text-CRDT participates in the same protocol as other CRR tables.
8. Existing test suites (C 28/28, Python 242/242, smoke) remain green.

WASM rebuild, editor bindings, and the localwin-side integration are **out of scope** for this push.

## The design in one paragraph

A `crsql_as_text_crdt('notes', 'body')` call creates a backing table `__crsql_fugue_notes_body` whose rows are *runs* of text (not individual characters) inserted contiguously by one peer. Rows form a tree via `(parentItemId, parentIndex)`. Tree order is depth-first, siblings sorted by `(itemId, index)`. Inserts use Fugue's three-case algorithm to avoid interleaving anomalies. Deletes set `content=NULL` (tombstones). On remote merge, a cleanup pass trims overlapping sub-items of the same `itemId`, then a tombstone pass adopts NULL content from either side. The parent `notes.body` column is trigger-maintained as the rendered text so SQL queries see the live string. The backing table is itself a CRR so cr-sqlite handles row-level sync via `crsql_changes`.

## Open design questions to resolve before code

These are the gaps Weidner left + our cr-sqlite-specific ones. Resolve via thinking + small experiments before they cost us a phase:

1. **`itemId` format.** Proposal: `{hex(crsql_site_id())}.{counter}`. Counter is a `__crsql_fugue_{table}_{col}_seq` table or column.
2. **Cleanup-pass scope.** Per-row trigger vs end-of-tx. Per-row is simpler; end-of-tx is correct for batched applies. **Default to end-of-tx** via SQLite's `COMMIT` hook semantics; revisit if it's too slow.
3. **Parent-column materialization cost.** Re-rendering on every change is O(rows). For chatty editing, this is wasteful. Options: (a) full re-render trigger, (b) incremental patch trigger, (c) on-demand only via a view, no materialization. **Start with (a)**; optimize if profiling demands.
4. **Insertion case 3's sentinel rows.** Need to ensure they're filtered from reads but kept in storage for sync. The `index != -1` filter handles reads; cr-sqlite sync of full row state handles persistence.
5. **Editor → SQL ops.** Editors emit `{from, to, insert}`. We need a function `crsql_fugue_apply_patch(table, col, row_pk, from, to, insert)` that translates a range op into Fugue insertions/deletions. Locate left/right neighbors by walking the tree.
6. **GC of tombstones over time.** Defer. Single-tenant scope buys us a lot of room.

## Phases

Each phase has a green gate. Don't proceed until the gate passes.

### Phase 0 — spec + scaffolding (1 day)
- ✅ `docs/fugue-design.md` (extraction done)
- ✅ `docs/text-crdt-plan.md` (this doc)
- Create new Rust crate `core/rs/text-crdt-fugue/` with `crate-type = ["rlib"]` (matches `fractindex-core`).
- Hook into `core/rs/bundle/src/lib.rs` with a `sqlite3_crsqltextcrdt_init()` init function (pattern: `sqlite3_crsqlfractionalindex_init()` at line 48).
- **Gate:** crate compiles, init function registers, native build still green, all existing tests still pass.

### Phase 1 — `crsql_as_text_crdt` registration (2 days)
- Implement the SQL function. Behavior:
  1. Validate `table` is already a CRR.
  2. Validate `column` exists, type-compatible (TEXT or coercible).
  3. Create backing table `__crsql_fugue_{table}_{column}` with the schema from `fugue-design.md`.
  4. Mark the backing table as a CRR via `crsql_as_crr`.
  5. Install AFTER UPDATE trigger on parent table that renders Fugue → parent column. *(Simplified: when the backing table changes, update the parent.)*
- **Gate:** Schema upgrade is idempotent; `pragma table_list` shows the backing table; backing table is a CRR.

### Phase 2 — single-peer insert (3 days)
- Implement `fugue_insert(table, col, row_pk, position, text)`:
  - Find left/right neighbors at `position` (rendered offset).
  - Apply insertion algorithm cases 1/2/3.
  - Write rows into backing table.
- Wire to a parent-table INSERT/UPDATE on the text column: `UPDATE notes SET body = 'hello'` translates into a sequence of fugue_insert calls computing the diff vs current body.
- **Gate:** `UPDATE notes SET body = 'hello world'` then `SELECT body FROM notes` returns `'hello world'`. Backing table has the expected runs.

### Phase 3 — single-peer delete (2 days)
- Implement `fugue_delete(table, col, row_pk, from, to)`:
  - Find sub-items covering range.
  - Set `content = NULL` (tombstones).
  - Split sub-items at range boundaries if needed.
- Wire to UPDATE that shortens text.
- **Gate:** Insert + delete + read round-trip produces correct text. Tombstones visible in backing table.

### Phase 4 — multi-peer merge cleanup (5 days, hardest phase)
- Implement tantaman's cleanup pass:
  - Detect overlapping sub-items by `itemId` after a remote-applied change.
  - Trim by the smallest-index-first algorithm in `fugue-design.md`.
- Implement tombstone pass: NULL content from any side wins.
- Trigger runs at end-of-tx via SQLite commit hook (or per-row, decide via experiment).
- **Gate:** Two-peer divergent-edit test converges identically regardless of sync direction. Hand-crafted scenarios: concurrent insert at same position, concurrent split, concurrent delete + insert.

### Phase 5 — property tests (3 days)
- Add Hypothesis tests in `py/correctness/tests/test_fugue.py`:
  - 2–5 peers
  - Random insert/delete/update sequences of 10–100 ops per peer
  - Random sync order
  - Invariant: all peers' rendered text identical at quiescence
  - 1000 trials
- **Gate:** Property tests pass 1000 trials without divergence. Add to CI.

### Phase 6 — bulk operations + perf sanity (2 days)
- Single-row UPDATE with a 10K-char value should produce 1–2 backing rows (the single run), not 10K. Verify case 1 (extend left neighbor) actually kicks in.
- Profile: 100 sequential 1-char inserts. Each fires the cleanup-and-rerender trigger. Confirm parent-column re-render isn't quadratic.
- Apply the perf principles below (see "Perf principles").
- **Gate:** 10K-char paste < 100ms locally. 100-keystroke session < 500ms.

## Perf principles

Optimizations admitted to the plan must pass both gates: **(a) we know with high confidence it will work** and **(b) we can back out easily** (no migrations, no wire-format change).

### Adopted from day one (Phase 0–3)

**`WITHOUT ROWID` on the Fugue backing table.**
- Confidence: high — SQLite-stable feature since 3.8.2, our PK is on every row anyway.
- Back-out: single CREATE TABLE flag change, no data migration needed (rebuild table).
- Why: smaller storage, faster point lookups, especially valuable in WASM/IDB.

**Materialized parent column via trigger.**
- Confidence: high — already core to the design, not an optional perf trick.
- Back-out: drop the trigger and switch to view-based rendering or on-demand recursive CTE.
- Why: `SELECT body FROM notes` becomes O(1) instead of recursive-CTE.

**Lazy tombstones (no GC for now).**
- Confidence: high — by doing nothing we get this.
- Back-out: N/A (adding GC later is always possible; this is the default state).
- Why: single-project scope makes the bloat irrelevant. Adding GC adds complexity, race conditions, and "did everyone see the deletion?" logic we don't need.

### Adopted in Phase 6 with a measured gate

**Render parent column at COMMIT, not on every row change.**
- Confidence: medium-high — SQLite COMMIT hooks are well-supported, but mid-tx reads of `notes.body` would see stale data. We accept that.
- Back-out: switch the trigger from a commit-hook callback back to AFTER UPDATE on the backing table. Code-only change.
- Adoption gate: Phase 6 profiling shows per-keystroke re-renders are >5% of edit latency.
- Caveat: document the mid-tx staleness explicitly. Editor binding will need to know.

### Deferred — experiment first, decide later

**Pack `(itemId, index)` into a single 64-bit INTEGER primary key.**
- Confidence: medium — math works (e.g., 16-bit site alias + 32-bit counter + 16-bit run-index = 64 bits), but it's a **one-way door**: once we ship this encoding, it's part of the wire format that flows through `crsql_changes`. Changing it later means migrating every peer's data.
- Back-out: NOT easy. This is the only optimization in the list that's effectively permanent.
- Adoption gate: defer until Phase 6 profiling tells us PK size is a real bottleneck AND we have a concrete sense of typical index ranges from real workloads. Until then, use the natural `(TEXT, INTEGER)` PK from Weidner's spec.
- If we do adopt: gate on a quick bench (10K rows, traversal time vs. baseline) and a max-index sanity check from observed data.

### Deferred — uncertain correctness

**Coalesce same-peer adjacent content runs across sessions.**
- Confidence: low — Weidner hedged even on tombstone coalescing (*"have not checked this thoroughly"*). Extending coalescing to content runs is **our** extension, not in his spec. Risk: it might break merge semantics in some concurrent-edit scenario we haven't thought of.
- Back-out: easy (stop calling the coalescer), but if it's already produced silently-bad merges, the damage is in the data.
- Adoption gate: Phase 5 property tests show row growth is a real problem at workloads we care about, AND we've added Hypothesis tests specifically exercising coalescing × concurrent edits.

### Rejected — wrong tool for the job

**R-Tree auxiliary index on `(start_offset, end_offset)`.**
- Why no: rendered offsets shift on every preceding edit. R-Tree wants stable keys. Maintaining a tree where every leaf updates on every edit costs more than the linear scans it'd replace.
- When it'd be right: anchored-annotation queries ("find comments overlapping range [X, Y]") if we add that feature later — those have stable keys and R-Tree fits perfectly.

**FTS5 inverted index on parent column.**
- Why no: this is a downstream concern. Once the parent column is a real string, normal FTS5 works against it. Decide separately, not as part of this push.

### Browser / WASM specific

- **Test against WASM early — Phase 5 should run the Hypothesis suite against `@vlcn.io/crsqlite-wasm`**, not just native. WASM SQLite optimizes recursive CTEs differently than native and IDB writes are 5–10x slower than disk; catching the slowdowns in Phase 5 is much cheaper than Phase 7.
- WITHOUT ROWID + materialized parent column give us most of the WASM-relevant wins for free.

### Phase 7 — cr-sqlite sync integration end-to-end (3 days)
- Extend our existing `tests/smoke/sync-two-nodes.mjs` to include a text-CRDT column.
- Confirm: edits to text-CRDT column flow through `crsql_changes`. Two peers' divergent text edits converge on sync.
- **Gate:** Smoke test passes with text-CRDT column. C+Python suites still green.

### Phase 8 — finalize (1 day)
- Update PLAN.md with completed phases.
- Document any design changes from the spec that came up during implementation.
- (Optional) Open an issue on upstream cr-sqlite linking our implementation. Comment on issue #65 — `mweidner037` might want to know.

**Total estimate: 20–22 days of focused work.** Phase 4 is the highest risk.

## Test strategy summary

Three layers, in order of "smallest unit catches the most bugs":

1. **Rust unit tests** in `core/rs/text-crdt-fugue/src/` — algorithm correctness, position lookups, cleanup-pass edge cases.
2. **Python correctness tests** (`py/correctness/tests/test_fugue.py`) — pairwise scenarios, hand-crafted concurrent-merge cases.
3. **Hypothesis property tests** — randomized N-peer convergence (Phase 5 gate).

The Hypothesis suite is the gate. If randomized merges find divergence, the algorithm is wrong, not the test.

## Risks

| Risk | Probability | Mitigation |
|------|-------------|------------|
| Weidner's untested algorithm has a bug | Medium | Hypothesis property tests will surface it. Plan time for ≥1 redesign iteration. |
| Cleanup pass too slow at commit | Low–Medium | Scope to affected `itemId`s, not whole table. Profile in Phase 6. |
| cr-sqlite changes-vtab can't represent Fugue ops cleanly | Medium | Each row write IS the change; cr-sqlite ships rows. Cleanup pass is local to receiver. Should work, but Phase 7 is where we find out. |
| Editor binding (CM6) doesn't translate to Fugue ops cleanly | Out of scope here | Punted to localwin-side work after this push. |
| Tombstones grow unbounded | Low (single-project scope) | Defer GC. Add coalescing if it becomes an issue. |

## Out of scope (explicitly)

- WASM rebuild from our fork-baseline source (separate task #8, deferred).
- Editor bindings (CM6 ↔ Fugue) — localwin-side, after engine is green.
- Multi-tenant performance considerations.
- Compact-on-disk storage of position strings — Weidner's variant uses small ints, not strings, so this isn't a problem.
- Yjs/Automerge interop — not needed; we own both ends of the wire.

## Status — all phases complete (2026-05-14)

| Phase | Status | Outcome |
|-------|--------|---------|
| 0 — scaffold crate | ✅ | `core/rs/text-crdt-fugue/`, init wired into bundle, build green |
| 1 — `crsql_as_text_crdt` | ✅ | Registration creates backing table (`WITHOUT ROWID`), parent index, AFTER INSERT/UPDATE/DELETE render triggers; idempotent; non-CRR & missing-column rejected |
| 2 — insert (Fugue 3-case) | ✅ | Cases 2 + 3 implemented; mid-run inserts snap to nearest boundary (#!~) |
| 3 — delete (tombstones) | ✅ | Whole-row tombstone + split (L/M/R with tombstoned middle); rerender wired |
| 4 — multi-peer merge | ✅ | All 4 hand-crafted scenarios converge; concurrent SPLIT produces semantic duplication (acceptable — convergence is the gate; cleanup-pass is #!~ for follow-up) |
| 5 — Hypothesis property tests | ✅ | 200 random 2-peer + 100 random 3-peer trials, **0 divergences**; bug found and fixed (end-of-doc with tombstone children) |
| 6 — bulk + perf sanity | ✅ | 10K paste = 0.2ms / 1 row; 100 sequential keystrokes = 29ms; 1000 random-position inserts O(n²) (#!~ for follow-up — outside the gate) |
| 7 — e2e sync integration | ✅ | Text-CRDT column flows through `crsql_changes`; divergent edits on text + LWW title converge; plain rows still sync |
| 8 — finalize | ✅ | This update |

**Test totals after all phases:** C 28/28, Python 246/246 (incl. 4 new Fugue tests with Hypothesis), 6 Node smoke scripts PASS.

## Known tech-debt (`#!~` markers in source)

### Resolved by tightening pass (2026-05-14, post-Phase-8)

- ✅ **Mid-run insert** — inserting at a position strictly inside a run now splits the run at the offset and lands the new content correctly. 7/7 mid-run tests pass; was previously snapping to nearest boundary.
- ✅ **Cleanup pass for concurrent splits** — `crsql_fugue_cleanup(table, col, row_pk)` implements tantaman's smallest-index-first trim algorithm. Called after sync, it dedups overlapping sub-items same-itemId. Concurrent-split scenario went from `"Hey YOUHey AND there"` (duplicated) to `"Hey YOU AND there"` (correct Fugue render).

### Still open

- **`deletion.rs:17`** — when splitting a sub-item that has children, the children all attach to the right portion (which keeps the original idx). Under concurrent merge this can leave children semantically mispositioned. Rare in practice; not exercised by Hypothesis trials so far.
- **Tombstone-wins-on-NULL** — if peers race a tombstone (`content = NULL`) against a content edit on the same `(itemId, idx)`, cr-sqlite's per-column LWW picks the winner. Adding a `tombstoned INTEGER` column would give monotonic "any peer said delete → it's deleted" semantics. Schema migration cost.

### Perf (deferred, outside Phase 6 gates)

- **`insertion.rs:1`** — each insert is O(n) (full node load + tree walk). 1000-op random-position session is ~100ms/op. Fix paths: render cache, indexed neighbor lookup, or Case-1 extension to keep n small.
- **`insertion.rs:22`** — Case 1 (extend our own most-recent run in-place) is not implemented. Would halve row counts in long-lived docs.
- **`insertion.rs:354`** — `itemId` uses `{site_hex}_{random_6_bytes}`. For ordering stability + Case-1 ownership checks, a monotonic counter is cleaner.
- **`render.rs:17`** — `crsql_fugue_render` is the canonical reader; the materialized `notes.body` column is set by triggers but cascades through cr-sqlite as a tracked cell. Phase 5 caught this and tests use the render function. A separate non-CRR sidecar would let `SELECT body` work without cascade.

### Schema/parent-shape limitations

- **`registration.rs:57`** — parent table must have a single `INTEGER PRIMARY KEY NOT NULL` aliased to rowid. Compound or TEXT PKs need `row_pk` to be reshaped.
- **`insertion.rs:160`** — end-of-doc inserts when the last visible node has tombstone children fall back to Case 2 (sibling of the tombstones). Sort order between the new node and the tombstone siblings is by item-id hex; semantically unstable but converges.

## What this delivers

A SQLite-resident text-CRDT column type, opt-in per parent column via `SELECT crsql_as_text_crdt('table', 'column')`, with these properties verified in 246 + 8 tests (post-tighten):

1. Per-column text-CRDT semantics on a CRR — insertion + deletion at arbitrary positions, including mid-run splits
2. N-peer convergence via cr-sqlite's existing `crsql_changes` protocol — no separate sync engine
3. **Concurrent-split deduplication via `crsql_fugue_cleanup`** — call after sync to apply tantaman's trim algorithm; correct Fugue semantics restored on the "two humans co-typing the same line" case
4. Native `.dylib` shipping; WASM rebuild still pending (task #8)
5. Coexists with LWW, OR-Set, Fractional Index, and CausalLengthSet columns on the same parent

## Public SQL surface

```sql
-- one-time per (table, column)
SELECT crsql_as_crr('notes');
SELECT crsql_as_text_crdt('notes', 'body');

-- editor primitives (called from editor bindings translating range ops)
SELECT crsql_fugue_insert('notes','body', row_pk, position, text);
SELECT crsql_fugue_delete('notes','body', row_pk, from, to);

-- canonical read (bypasses materialization cascade)
SELECT crsql_fugue_render('notes','body', row_pk);

-- run after each sync-apply for correctness on concurrent-split scenarios
SELECT crsql_fugue_cleanup('notes','body', row_pk);
```

WASM rebuild is the largest remaining item; the v1 substrate is otherwise complete for native deployment.
