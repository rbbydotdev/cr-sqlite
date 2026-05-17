# Rich-text documents — composing the four primitives

How to assemble a full block-and-inline rich-text document model (the
shape that ProseMirror, Slate, TipTap, Notion, Obsidian sync engines use)
out of the primitives this fork already ships. **No new CRDT code** —
the composition is at the schema / consumer layer.

## The four layers

```
┌─────────────────────────────────────────────────────────────────┐
│ app: editor view (ProseMirror, Slate, custom DOM)               │
│      renderer (portable-text spans + block tree → DOM/MD/HTML)  │
├─────────────────────────────────────────────────────────────────┤
│ blocks table       — one row per block, body holds Peritext JSON│
│ doc__tree_*        — block structure (parent + sibling order)   │
├─────────────────────────────────────────────────────────────────┤
│ peritext-marks     — inline formatting per block (rich-text-2)  │
│ text-crdt-fugue    — character order per block                  │
│ tree-crdt-kleppmann — block tree (Kleppmann 2022)               │
│ fractindex-core    — sibling ordering tag (BLOB in meta)        │
├─────────────────────────────────────────────────────────────────┤
│                            cr-sqlite                             │
└─────────────────────────────────────────────────────────────────┘
```

Every box below the dotted line already exists; **nothing in this doc
asks you to write a new CRDT**.

## Schema (single SQL file)

```sql
-- 1. Blocks — one row per node in the document tree.
--    body is the inline rich-text content for text-bearing blocks
--    (paragraph, heading, code-block, etc.).
CREATE TABLE blocks (
    id    BLOB PRIMARY KEY,         -- UUIDv7 (16 bytes) recommended
    kind  TEXT NOT NULL DEFAULT '', -- 'document' | 'paragraph' | 'heading'
                                    --   | 'list' | 'list-item' | 'code' | …
    attrs TEXT,                     -- JSON, kind-specific: {"level":1}
                                    --   for heading; {"lang":"rust"} for code
    body  TEXT                      -- portable-text JSON (Peritext-managed)
);
SELECT crsql_as_crr('blocks');
SELECT crsql_as_peritext('blocks', 'body');

-- 2. Block tree — manages (parent, sibling order, block id).
--    node_id = block_id (BLOB); meta = fractional-index BLOB.
SELECT crsql_create_tree('doc');

-- 3. Well-known sentinels — caller convention, not CRDT primitives.
--    Use any stable id; the CRDT does not privilege them.
INSERT INTO blocks (id, kind) VALUES
    (X'00000000000000000000000000000001', 'document'),  -- root
    (X'000000000000000000000000000000FF', 'trash');     -- deleted-blocks holder
```

That's the entire schema. Three statements + two sentinels.

## Materialized example

A document:

```markdown
# Heading
A paragraph with **bold**.

- First item
- Second item with *italic*
```

Lands as the following row state (sentinel IDs abbreviated to single
hex bytes for readability):

```
blocks
┌──────┬───────────┬───────────────┬───────────────────────────────────────────────┐
│ id   │ kind      │ attrs         │ body                                          │
├──────┼───────────┼───────────────┼───────────────────────────────────────────────┤
│ 01   │ document  │ null          │ null                                          │
│ FF   │ trash     │ null          │ null                                          │
│ a0   │ heading   │ {"level":1}   │ [{"text":"Heading","marks":{}}]               │
│ a1   │ paragraph │ null          │ [{"text":"A paragraph with ","marks":{}},     │
│      │           │               │  {"text":"bold","marks":{"bold":true}},       │
│      │           │               │  {"text":".","marks":{}}]                     │
│ a2   │ list      │ {"style":"bul │ null                                          │
│      │           │   let"}       │                                               │
│ a3   │ list-item │ null          │ null                                          │
│ a4   │ paragraph │ null          │ [{"text":"First item","marks":{}}]            │
│ a5   │ list-item │ null          │ null                                          │
│ a6   │ paragraph │ null          │ [{"text":"Second item with ","marks":{}},     │
│      │           │               │  {"text":"italic","marks":{"italic":true}}]   │
└──────┴───────────┴───────────────┴───────────────────────────────────────────────┘

doc__tree_state
┌──────┬────────┬──────┐
│ node │ parent │ meta │   meta = fractional-index BLOB (sibling order)
├──────┼────────┼──────┤
│ a0   │ 01     │ 'a'  │   (heading is first child of root)
│ a1   │ 01     │ 'b'  │   (paragraph second)
│ a2   │ 01     │ 'c'  │   (list third)
│ a3   │ a2     │ 'a'  │   (li1 first under list)
│ a4   │ a3     │ 'a'  │   (paragraph inside li1)
│ a5   │ a2     │ 'b'  │   (li2 second under list)
│ a6   │ a5     │ 'a'  │   (paragraph inside li2)
└──────┴────────┴──────┘
```

## Operations — every block-level edit is ≤3 primitive calls

| operation | primitive calls |
|---|---|
| Create a paragraph at end of doc | `INSERT INTO blocks` + `crsql_tree_move('doc', new_id, root, frac_next, ts, actor)` |
| Type text in paragraph | `crsql_fugue_insert('blocks', 'body', block_id, pos, text)` |
| Bold a range | `crsql_peritext_mark('blocks', 'body', block_id, start, end, 'bold', NULL, 0, 0, ts, actor)` |
| Split paragraph at offset N | (a) `crsql_fugue_delete(block_id, N, len)` to chop tail (b) `INSERT INTO blocks` (new id) (c) `crsql_tree_move('doc', new_id, parent_of_old, frac_after_old, ts, actor)` (d) `crsql_fugue_insert(new_id, 0, tail_text)` — or (cleaner) capture tail char IDs and re-parent via tree-CRDT (not implemented; defer) |
| Indent a list-item (make child of preceding sibling) | `crsql_tree_move('doc', li_id, prev_sibling_id, frac, ts, actor)` |
| Dedent | `crsql_tree_move('doc', li_id, grandparent_id, frac_after_old_parent, ts, actor)` |
| Move block to new position | `crsql_tree_move('doc', block_id, new_parent, new_frac, ts, actor)` |
| Delete block (and subtree) | `crsql_tree_move('doc', block_id, trash_id, '', ts, actor)` |
| Change paragraph → heading | `UPDATE blocks SET kind='heading', attrs='{"level":2}' WHERE id=?` |

Split paragraph is the only non-trivial composition — it chops, creates,
moves. Notebook editors generally do this in app code (one transaction);
no need for a CRDT-level helper.

## Render — recursive CTE

Walk the tree in depth-first preorder, joining blocks for content:

```sql
WITH RECURSIVE walk(node, parent, depth, ord_path) AS (
    -- root's children, ordered by fractional-index meta
    SELECT s.node_id, s.parent_id, 0, s.meta
    FROM   doc__tree_state s
    WHERE  s.parent_id = :doc_root_id
  UNION ALL
    -- descendants — accumulate ancestors' metas into a sortable path
    SELECT s.node_id, s.parent_id, w.depth + 1,
           w.ord_path || X'00' || s.meta
    FROM   doc__tree_state s, walk w
    WHERE  s.parent_id = w.node
)
SELECT w.depth, b.id, b.kind, b.attrs, b.body
FROM   walk w
JOIN   blocks b ON b.id = w.node
WHERE  b.id != :trash_id
ORDER  BY w.ord_path;
```

Returns a flat preorder traversal: depth tells the app where in the
tree each block sits. The app folds (depth, kind, attrs, body) into
ProseMirror nodes / Slate values / HTML / markdown / whatever.

`ord_path` concatenates ancestor metas with `X'00'` separators — works
as long as `meta` values never contain literal NUL bytes (true for the
fractional indices `crsql_fractindex_core` generates). Comparing the
concatenated BLOB lexicographically gives correct depth-first preorder.

## Concurrent-edit semantics

Everything below resolves automatically without consumer logic:

| scenario | resolves via |
|---|---|
| Two users type at different offsets in same paragraph | Fugue (text-CRDT) |
| Two users bold overlapping ranges in same paragraph | Peritext mark union |
| Two users add bold + italic in same paragraph | Peritext (both apply) |
| Bold + unbold conflict on same range | Peritext LWW by opId |
| One user types in para-1, other inserts new para-2 | tree-CRDT (new block lands) + Fugue (text intact) |
| Reorder list items vs add new list item | tree-CRDT moves + fractional index slot |
| Move paragraph into list-item vs concurrent text edit | tree-CRDT move + Fugue text — both apply |
| Both users move para-1 to be a child of para-2 (impossible cycle) | tree-CRDT cycle skip (Kleppmann §3.4) |
| Delete paragraph vs comment on it | tree-CRDT moves block to trash; mark survives; app decides render |
| Concurrent block deletes | same trash; tree-CRDT idempotent |

## What the consumer layer owns

CRDT machinery handles the merge. The app layer still owns:

- **Block-kind vocabulary**: define what kinds exist (`paragraph`,
  `heading`, `code`, `quote`, `list`, `list-item`, `image`, `hr`,
  `embed`, …). Validate `attrs` per-kind.
- **Block-level operations**: split paragraph, indent list-item, merge
  paragraphs at backspace-on-empty. Composed from ≤3 primitive calls.
- **Cross-block selections**: delete from offset N in block A to offset
  M in block B. Decomposes into Fugue deletes + possibly a tree-CRDT
  delete (if B is fully consumed) + maybe a merge of remainders.
- **Render target**: portable-text-spans-per-block + block tree →
  ProseMirror JSON / Slate value / HTML / markdown / Notion blocks /
  Obsidian source / whatever.
- **Block-kind-aware mark rules**: e.g. a `code` block probably doesn't
  accept `bold` marks. App validates / strips.
- **Causally-stable trash GC**: paper §3.7 — eventually delete from
  `blocks` (and dependent `__crsql_peritext_blocks_body_marks` rows)
  for blocks under the trash sentinel that all replicas have observed.

None of those need CRDT changes; they're application concerns over a
schema that already converges.

## Why not a single "rich-doc column"?

A single column that bundles the whole doc into one cell would either:

1. **Store JSON of the full doc** — denormalized projection of the
   underlying blocks+tree. Writes still decompose into tree+peritext
   ops, so the column is misleading; it costs one full-doc rewrite
   per keystroke (or constant invalidation).
2. **Store an opaque doc-id pointer** — column is dead weight, real
   storage is the blocks+tree pair, app accesses them directly.

Either way the abstraction flattens the composition without buying
anything. Keeping blocks as rows preserves granular sync, per-block
queries, partial loads, backlink resolution — and zero new CRDT code.

## Smoke test

`tests/smoke/rich-text-blocks.mjs` exercises:

1. Build a multi-block doc programmatically (heading + paragraph + list)
2. Render via the recursive CTE; assert the flat preorder is correct.
3. Edit within a block: insert text, apply marks; re-render and verify.
4. Block operations: insert new block, reorder via fractional index,
   indent list item by re-parenting, delete block via trash move.
5. Two-peer convergence: each peer edits different blocks, syncs, asserts
   identical state. Concurrent edit-vs-block-move on the same block.

No fuzz needed at this layer — the underlying primitives already have
property fuzzes that cover the composition's components.
