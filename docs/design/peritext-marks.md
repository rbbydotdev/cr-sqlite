# Peritext marks layer on Fugue β-flat — design

Adds rich-text formatting (bold, italic, link, color, …) on top of the
existing character CRDT in `core/rs/text-crdt-fugue/`. The algorithm is
[Litt, Lim, Kleppmann, van Hardenberg 2022 — *Peritext*](../refs/peritext-2022-litt-et-al.pdf)
§4 (Algorithm 1).

The marks layer **does not** modify the character store. Marks live in a
separate CRDT-tracked table; the parent column holds a rendered
portable-text JSON projection.

## What this layer adds

| name | purpose |
|---|---|
| `crsql_as_peritext(table, column, additive_names?)` | promote a column. Creates the marks table, render trigger, and registers the column as a Fugue text-CRDT under the hood. `additive_names` is an optional JSON array of mark names that should NOT LWW-collapse (e.g. `'["comment"]'`). Parent column holds portable-text JSON. |
| `crsql_peritext_mark(table, col, row_pk, start_pos, end_pos, mark_name, mark_value, start_side, end_side, ts, actor)` | add a mark over a render-position range |
| `crsql_peritext_unmark(table, col, row_pk, start_pos, end_pos, mark_name, start_side, end_side, ts, actor)` | remove a mark over a range (just an op with `is_add = 0`; never deletes the original add) |
| `crsql_peritext_render(table, col, row_pk)` | explicit render (returns portable-text JSON). Trigger-driven render uses the same code path. |

`crsql_fugue_insert` / `crsql_fugue_delete` are **unchanged** — text
editing operates exactly as in the plain text-CRDT.

## Storage

Two changes vs. the existing text-CRDT:

1. The parent column now stores **portable-text JSON** (not plain text).
2. One new CRR table per Peritext column.

```sql
-- Marks op-log. CRDT-tracked → replicates via cr-sqlite changesets.
CREATE TABLE __crsql_peritext_{table}_{column}_marks (
    lamport_ts   INTEGER NOT NULL,
    actor        BLOB    NOT NULL,
    row_pk       BLOB,              -- which document
    start_item   TEXT,              -- Fugue itemId of start-anchor char
    start_side   INTEGER,           -- 0 = before, 1 = after
    end_item     TEXT,              -- Fugue itemId of end-anchor char
    end_side     INTEGER,           -- 0 = before, 1 = after
    mark_name    TEXT,              -- 'bold', 'italic', 'link', 'color', …
    mark_value   BLOB,              -- opaque payload (URL for link, hex for color, NULL for bool marks)
    is_add       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (lamport_ts, actor)
);
SELECT crsql_as_crr('__crsql_peritext_{table}_{column}_marks');
```

`start_item` / `end_item` reference the Fugue backing table's `itemId`,
which is stable for the lifetime of the document (including across
deletes — tombstoned rows stay in the backing table). Two reserved
sentinel itemIds carry start/end-of-text anchors:

- `__start__` — anchor before any character
- `__end__`   — anchor after any character

## Anchor sides

Each anchor is `(itemId, side)` where side ∈ {before, after}.

A mark with `start_side = before` and `end_side = before` is
"grows-at-end" — new chars inserted at the boundary of the end-anchor
character become part of the mark (Example 7 in the paper). This is
bold/italic semantics.

A mark with `end_side = after` is "doesn't-grow-at-end" — new chars
appended at the end are excluded. This is link semantics (Example 8).

Both `start_side` and `end_side` are exposed as UDF args (0 = before,
1 = after). Common conventions:

| mark | start_side | end_side | growth |
|---|---|---|---|
| bold, italic, underline | before | before | grows at end |
| link | before | after  | doesn't grow either side |
| color, fontSize | before | before | grows at end |
| comment | before | after | doesn't grow either side |

## Position-to-anchor resolution

`crsql_peritext_mark` takes integer render positions (`start_pos`,
`end_pos`). The UDF resolves at call time:

- `start_pos == 0` → `start_item = "__start__"`, `start_side = after`
- `start_pos > 0`  → walk to the `start_pos`-th visible character;
                    `start_item = that char's itemId`, `start_side = before`
- `end_pos == len` → `end_item = "__end__"`, `end_side = before`
- `end_pos < len`  → walk to the `end_pos`-th visible character;
                    `end_item = that char's itemId`, `end_side = end_side_arg`

Position resolution uses the existing Fugue walker.

## Apply algorithm

Inserts into the marks table are straightforward (no undo/redo loop like
the tree CRDT — Peritext apply is commutative by construction, the paper
proves this in Appendix A). The AFTER INSERT trigger just re-renders the
parent column.

The interesting work is **render**.

## Render — single-pass walker

Walk Fugue backing rows in render order. Maintain per-markType state:

```rust
// For each markType, an ordered set of currently-active ops, keyed by opId desc.
// Top of the set = the LWW winner.
active: HashMap<MarkName, BTreeMap<OpId, &MarkOp>>
```

Pre-compute four lookup tables from the marks rows for this row_pk:

```rust
starts_before: HashMap<itemId, Vec<&MarkOp>>  // ops with start_side=before, start_item=itemId
starts_after:  HashMap<itemId, Vec<&MarkOp>>  // ops with start_side=after, start_item=itemId
ends_before:   HashMap<itemId, Vec<&MarkOp>>
ends_after:    HashMap<itemId, Vec<&MarkOp>>
```

Plus sentinels for `__start__` / `__end__`.

The walker:

```
process __start__ anchor (after-side) → seed `active`
emit_span_buffer = ""
current_marks    = project(active)

for ch in fugue_walker:
    # "before-ch" anchor: update active state
    apply_starts(starts_before.get(ch.itemId))
    apply_ends(ends_before.get(ch.itemId))
    new_marks = project(active)

    if new_marks != current_marks:
        flush(emit_span_buffer, current_marks) → spans
        emit_span_buffer = ""
        current_marks    = new_marks

    if not ch.tombstoned:
        emit_span_buffer.push(ch.content)

    # "after-ch" anchor: update active state for next iteration
    apply_starts(starts_after.get(ch.itemId))
    apply_ends(ends_after.get(ch.itemId))

# __end__ anchor — terminal; flush remaining buffer
flush(emit_span_buffer, current_marks) → spans

return json(spans)
```

`apply_starts(op)`: insert `op` into `active[op.mark_name]` if
`op.is_add`, also insert if it's a removeMark (need it in the set so
LWW resolution can see it).

`apply_ends(op)`: remove `op` from `active[op.mark_name]`.

`project(active)`: for each mark_name, take top of BTreeMap (highest
opId). If it's an addMark, include `(name, value)` in the rendered
marks. If it's a removeMark, skip.

Cost: O(n + m·log m) where n = chars, m = marks. Linear scan, BTreeMap
ops are log m. Fine for any realistic doc.

## Portable-text JSON output

The rendered column contains a JSON array of spans:

```json
[
  {"text": "Hello ", "marks": {}},
  {"text": "world", "marks": {"bold": true, "link": "https://example.com"}},
  {"text": "!", "marks": {}}
]
```

- `text` — span content
- `marks` — object keyed by `mark_name`. Value is `true` for boolean
  marks (bold/italic/underline), or the `mark_value` payload for
  parameterized marks (link URL, color hex, etc.)

Lossless for any mark types the consumer defines. Downstream renderers
project to HTML/DOM/whatever.

## Merge semantics — what V1 covers

Text editing and most formatting are fully merge-able:

- **Text** (chars): always Fugue character-level merge. Two peers
  inserting at the same position both land; ordering is deterministic.
- **Concurrent same-name marks over disjoint or overlapping ranges**:
  union. Alice bolds [0,3] + Bob bolds [5,9] → bold across [0,9]
  (paper Example 2).
- **Conflicting same-name marks over the same range** (e.g. one
  addMark + one removeMark, or two `color: red` vs `color: blue`):
  LWW on opId within the overlap region (paper §3.2.1, Examples 4/5).

The "LWW" in "LWW marks" is only the **last** bullet — conflict
resolution within a single markType. The first two bullets work
identically to the full Peritext algorithm.

## Additive marks (comments)

Some markTypes don't LWW-collapse. The classic case: two overlapping
`comment` marks should coexist as two separate highlights (paper
§3.2.2). The consumer declares which markTypes are additive at
registration:

```sql
SELECT crsql_as_peritext('notes', 'body', '["comment", "suggestion"]');
```

Stored as a metadata row keyed by `(table, column)`. Empty / NULL =
all marks are LWW.

Render projection per markType:

- **LWW**: take the top of `active[name]` (highest opId). If addMark,
  include `(name, value)`; if removeMark, omit.
- **Additive**: enumerate all currently-active addMark ops in
  `active[name]`. Emit as an array of values:

```json
{"text": "fox", "marks": {"comment": ["alice: typo?", "bob: agreed"]}}
```

If `mark_value` is NULL on an additive mark, emit `true` per op rather
than NULL (keeps JSON well-typed).

## Out of scope for V1

- **endOfParagraph / block elements**. Paper §1 explicitly excludes
  them ("future paper"). Block CRDTs are a separate algorithm.
- **Op-set materialization**. Render computes lazily. If perf becomes
  an issue, switch to Algorithm 1's materialized op-sets.

## Test plan

Deliberate; not exhaustive. Four load-bearing properties:

1. **phase 1 — local invariants**: registration creates the marks
   table + trigger; a single addMark over a known range produces
   correct portable-text JSON in the parent column.
2. **phase 2 — paper §3 canonical scenarios**, each pinned as a
   regression:
   - Example 2: overlapping bold ranges from two peers → result is
     contiguous bold over their union.
   - Example 5: bold + unbold of overlapping spans → LWW on opId.
   - Example 7: text inserted at end of bold range becomes bold.
   - Example 8: text inserted at end of link does NOT become linked
     (requires `end_side = after`).
3. **phase 3 — two-peer convergence**: peers issue marks and edits in
   parallel, exchange via `crsql_changes`, assert byte-identical JSON.
4. **fuzz** (200-500 iters): random `insert` / `delete` / `mark` /
   `unmark` across 2-4 peers with random sync. Assert convergence.

Not testing: performance/scaling, paper Examples 1/3/4/6 (Ex 1 and 3
are corollaries of Ex 2; Ex 4 is the color-LWW case covered by Ex 5;
Ex 6 needs additive marks which are deferred).
