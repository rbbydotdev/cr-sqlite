# sqlite-crdt — plan

## Goal

A SQLite-based sync engine that runs identically in the browser (WASM) and on a server, supports collaborative editing and headless-agent handoff via the same change-log protocol, and gains a real text-CRDT column type (not LWW-over-strings).

We are not building a new database. We are taking dormant cr-sqlite, reviving it as our fork, and adding the one thing it never finished: a text/sequence CRDT.

## What we found

### cr-sqlite status

- Last meaningful commit: **2024-06-28**. Repo is not archived but is effectively dormant. Original author (Matt Wonlaw / `tantaman`) has moved on.
- The CRDT toolkit shipped today: LWW (default), Observe-Remove Sets, Fractional Index, CausalLengthSet. Counter and **rich-text/Peritext are listed in the README but were never implemented.**
- 42 branches surveyed — **none** contain text-CRDT work. No `text-*`, no `peritext`, no `fugue`, no `rga`, no `v2` branch. Issues #65, #181, #321, #323 hold all the design intent. **Zero code.**

### Open PRs worth taking

Only 3 of 7 open PRs are real code. All others (#387, #388, #389, #390) are 2.5-year-old planning docs by the original author — skip.

| PR | What it does | Why we want it |
|----|--------------|---------------|
| **#437** (tantaman) | +0/-13 fix: drop bogus `updatedTableInfosThisTx` check in commit hook | Read-only connections were missing schema updates after sibling ALTERs. Direct sync-correctness fix. |
| **#455** (ikusteu) | Automigrate path fixes (issues #451/#452) | Broken automigrate breaks cold-start sync across peers. Recent (2025-11). |
| **#445** (jeromegn) | Fast `crsql_commit_alter` for non-destructive ALTERs | Avoids rebuilding clock tables on column-add. Material perf for evolving schemas. |

All show `MERGEABLE / CLEAN` on GitHub. Only file overlap: 437/445 both touch `tableinfo.rs`. Cherry-pick order: **437 → 455 → 445**.

### The text-CRDT question

- No working prototype exists in cr-sqlite, anywhere, in any branch.
- The most valuable artifact in the whole repo is **issue #65 comment dated 2023-06-14** by `mweidner037` (Matthew Weidner, author of position-strings / Collabs): a near-implementation-ready SQL DDL + tree-order recursive query + insertion+merge algorithm for a **Fugue** sequence CRDT as a virtual table.
- If we build from scratch we build from there. Otherwise we link a slim Rust lib.

### "Is a special column designation common?"

**Yes — universally so.** Every text CRDT requires a different storage shape than `TEXT`:

| System | Declaration |
|--------|-------------|
| Yjs | `Y.Text` (not `Y.String`) — separate type |
| Automerge | `Text` type vs. `string` — separate type |
| Loro | `LoroText` container — separate type |
| ProseMirror | `Y.XmlFragment` mapped to PM doc — separate |
| cr-sqlite (proposed, #181) | `CREATE VIRTUAL TABLE foo USING CausalLengthSet(... content PERITEXT ...)` |

The reason is mechanical: a sequence CRDT stores per-character identity/position state (positions, tombstones, causal metadata), not just a resolved string. You can't squeeze that into a flat `TEXT` column without losing the merge information that makes it a CRDT. So yes — a `CREATE VIRTUAL TABLE ... USING YText` or column-modifier syntax (`content TEXT_CRDT`) is the right shape and matches every comparable system.

### Slim text-CRDT lib options

| Lib | Algorithm | C ABI | License | Verdict |
|-----|-----------|-------|---------|---------|
| **yrs/yffi** | YATA | **Yes — mature, documented `libyrs.h`** | MIT | Only realistic candidate. v0.26 shipped 2026-05-04. |
| Loro | Fugue (better intent preservation) | UniFFI only (Swift/Kotlin/Python), no real C header | MIT | Best algorithm. Would need to write our own cbindgen layer. |
| Automerge-c | RGA | Yes (CMake) | MIT | Full JSON-CRDT, overkill for text. No documented emscripten path. |
| Diamond Types | Eg-walker | None | ISC | Fastest, but no C FFI. Would need to write cbindgen. |
| Peritext / Sync9 / Fugue-from-scratch | various | n/a | n/a | Implementing #65's design is real work. Months, not weeks. |

## Architecture decision

```
┌──────────────────────────── our fork of cr-sqlite ────────────────────────────┐
│                                                                                │
│  Existing (keep):                                                              │
│    • crsql_as_crr(table)              — mark table for CRDT merge              │
│    • column merge: LWW / OR-Set / Fractional Index                             │
│    • crsql_changes vtab               — uniform change log for sync            │
│    • Rust extension code (Rust → staticlib → linked into SQLite ext)           │
│                                                                                │
│  Add:                                                                          │
│    • Virtual table type: USING YText(...)                                      │
│        - Storage: yrs Doc bytes + index rows                                   │
│        - Reads: SELECT renders current text                                    │
│        - Writes: edits applied via yrs, emit changes to crsql_changes          │
│    • Link yrs as a Rust staticlib (same pattern cr-sqlite already uses)        │
│    • Apply PRs #437, #455, #445 to the fork as initial fixes                   │
│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘

                                    │
                                    ▼

  identical loadable extension for:
    • native (.dylib / .so / .dll)    — server, electron, native node
    • WASM (emscripten)                — browser (and node-wasm if wanted)
```

**Why yrs and not Loro or homegrown Fugue:**
- yrs has the only mature, currently-shipping C header among the candidates. Everything else means writing a cbindgen layer ourselves, which contradicts "slim, thin libs."
- Linking yrs into cr-sqlite is mechanically the same pattern cr-sqlite already uses (Rust crate as staticlib, FFI into the SQLite C extension).
- Yjs binary protocol compat is a real interop benefit — any future client lib that speaks Yjs ops can talk to our column type.
- If we ever need Fugue's intent-preservation story over YATA, we can rebuild the column behind the same `USING YText` API. The user of the column doesn't care which algorithm is underneath.

**Opt-in shape (decided 2026-05-14): column-modifier on a regular CRR.**

```sql
CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT, body TEXT);
SELECT crsql_as_crr('notes');
SELECT crsql_as_text_crdt('notes', 'body');   -- body is now a sequence CRDT
```

Rationale:
- Mirrors the existing `crsql_as_crr` API — users learn one pattern.
- Keeps regular SQLite features (foreign keys, indexes, joins) intact.
- Mixed-column tables are natural: `title` stays LWW, `body` becomes text-CRDT, no virtual-table tax for the rest of the row.
- Avoids parser hacks: the column type stays `TEXT` in the schema; the magic is a separate registration call.

Rejected alternatives:
- `CREATE VIRTUAL TABLE ... USING YText` (vtable approach) — clean but couples table identity to CRDT semantics and loses FK/index ergonomics.
- Default-for-all-TEXT (magical) — most TEXT columns (titles, paths, statuses) want LWW. Opt-in keeps the cost where it belongs.

## Roadmap

### Phase 0 — establish baseline (this session — done)
1. ✅ Clone the repo to `../sqlite-crdt`
2. ✅ Pull in `callum-gander/cr-sqlite` (the Fly.io-maintained fork) as `fly` remote. Branched off `fly/main` as `fork-baseline-fly`. Why: 80 unique commits of real correctness work (UB fixes, db_version cache, ordinal-map for site IDs, DROP TABLE corruption #433, Rust/C extdata field-ordering bug). Plus 94 new Python tests reproducing upstream bugs — all pass on the substrate.
3. ✅ Cherry-pick #437 and #455 onto `fork-baseline-fly`. Skipped #445 — Fly fork already has it. #437 conflicted minimally in `core/src/crsqlite.c` (Fly removed an unused function differently — kept Fly's version).
4. ✅ Build native loadable extension. `core/dist/crsqlite.dylib`.
5. ✅ Test suite: C 28/28, Python 242/242 (incl. 94 Fly-added upstream-bug repros), smoke PASS.
6. ✅ Build / verify WASM via pre-built `@vlcn.io/crsqlite-wasm v0.16.0`. Need our own WASM rebuild (task #8) for our fixes to land in browser.

### Phase 1 — find the seam (this session)
6. Read `core/rs/fractindex-core/` end-to-end — this is the only working non-LWW precedent and the closest template for what we're adding
7. Identify the exact files where a new column-type / virtual-table registration would live
8. Document the linking pattern cr-sqlite uses for its Rust staticlibs — confirm yrs can be linked the same way

### Phase 2 — minimal text CRDT (next session)
9. Add `yrs` as a Cargo dep in a new crate `core/rs/text-crdt-yrs/`
10. Stub `USING YText` virtual table — read-only first, then writes
11. Wire writes to emit rows into `crsql_changes` (this is the hardest part — yrs ops have to be expressible as change-log entries that other peers can apply)
12. Two-node text-merge test: concurrent inserts converge, deletes converge, no Frankenwords on basic conflicts

### Phase 3 — WASM parity
13. Confirm yrs builds for `wasm32-unknown-emscripten` (or refactor the link to `wasm32-unknown-unknown` if needed)
14. End-to-end browser test: same two-node merge but with both nodes as sqlite-wasm in separate workers

## Open questions

1. **Where do the JS bindings live?** This repo has no `js/`. They're in `vlcn-io/js` (separate repo, also dormant). We may need to fork that too, or build our own thin sqlite-wasm wrapper.
2. **yrs ↔ crsql_changes mapping.** Yjs binary updates are opaque — translating them into row-shaped change-log entries is the design we have to invent. Two options: (a) store the Yjs update bytes as opaque blobs in change-log rows and let the receiver apply via yrs, (b) decompose yrs ops into RGA-style rows that participate in the existing change log. Option (a) is simpler but mixes substrates; option (b) is what mweidner037's #65 sketch does.
3. **Emscripten + Rust staticlib.** cr-sqlite's existing WASM build links its own Rust staticlib. Adding yrs is the same in principle, but yrs has never been built for `wasm32-unknown-emscripten` in production AFAICT.
4. **Schema-driven CRDT typing.** If we go column-modifier (`content TEXT_CRDT`) instead of virtual-table, we'd need parser tricks. Defer unless virtual-table proves awkward.
5. **Replace or retain `crsql_changes`?** v2 of cr-sqlite was supposed to be an event-log model. We could leapfrog v1's row-CRDT model entirely. For now: keep v1, the row model serves our needs, defer the event log.
