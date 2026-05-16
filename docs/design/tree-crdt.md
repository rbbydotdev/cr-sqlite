# Tree CRDT (Kleppmann 2022) — design

A **generic** replicated-tree primitive for cr-sqlite. Knows nothing about
filesystems, JSON, or any specific consumer. Operates on:

- opaque BLOB **node IDs**
- opaque BLOB **edge metadata** (a name, an ordering tag, a label, whatever
  the consumer wants — the CRDT never inspects it)
- a totally-ordered **(lamport_ts, actor)** stamp on each op

Faithful implementation of Kleppmann, Mulligan, Gomes, Beresford 2022,
*A highly-available move operation for replicated trees* — see
`docs/refs/kleppmann-2022-move-op.pdf` §3, Fig. 4.

## Model

A tree is a set of `(parent, meta, child)` triples with two invariants:

1. **Unique parent**: each `child` appears at most once.
2. **Acyclic**: no node is its own ancestor.

`parent = NULL` means top-level (a root of the forest). The CRDT allows
multiple roots — a "single root" is a consumer convention, not a CRDT
property.

A move is a 4-tuple `Move(t, p, m, c)`:
- `t` — totally-ordered timestamp `(lamport_ts, actor)`
- `p` — new parent node ID (or NULL)
- `m` — opaque metadata bytes
- `c` — child node ID being moved

Node creation is implicit: a `Move` whose `c` does not yet exist creates it.
Node deletion = move under a designated "trash" node chosen by the consumer
(again, not a CRDT concept).

## Storage layout

For a tree registered with name `T`:

| table | replicated? | purpose |
|---|---|---|
| `T__tree_ops`   | **yes** (cr-sqlite CRR) | raw moves, the wire op-log |
| `T__tree_log`   | no (local)              | per-op `old_parent`/`old_meta`/`old_existed` snapshot needed for undo |
| `T__tree_state` | no (derived)            | current `(node_id, parent_id, meta)` parent-of relation |

```sql
CREATE TABLE T__tree_ops (
    lamport_ts INTEGER NOT NULL,
    actor      BLOB    NOT NULL,
    node_id    BLOB    NOT NULL,
    new_parent BLOB,                  -- NULL = top-level
    meta       BLOB,
    PRIMARY KEY (lamport_ts, actor)
);
SELECT crsql_as_crr('T__tree_ops');

CREATE TABLE T__tree_log (
    lamport_ts  INTEGER NOT NULL,
    actor       BLOB    NOT NULL,
    old_parent  BLOB,
    old_meta    BLOB,
    old_existed INTEGER NOT NULL,     -- 0 = node did not exist (paper's None)
    PRIMARY KEY (lamport_ts, actor)
);

CREATE TABLE T__tree_state (
    node_id   BLOB PRIMARY KEY,
    parent_id BLOB,
    meta      BLOB
);
CREATE INDEX T__tree_state__parent ON T__tree_state (parent_id);
```

Why ops are split from log: the `old_*` snapshot is **replica-local** —
each replica computes it from its own tree at apply time. Only the
raw `Move(t,p,m,c)` travels over the wire.

## Algorithm (Kleppmann §3.4, Fig. 4)

Order: ops sorted by `(lamport_ts, actor)` ascending.
Comparison: standard tuple compare; `actor` BLOB byte order breaks ts ties.

### do_op(t, p, m, c)
1. Snapshot `(old_parent, old_meta, old_existed) = lookup_parent(c)`.
2. Append `(t, *old)` to `T__tree_log`.
3. **Cycle check**: walk ancestors of `p` via recursive CTE; if `c` appears
   (or `c == p`), the op is "ignored" — log entry still recorded with the
   snapshotted old state, but `T__tree_state` left unchanged.
4. Else: upsert `T__tree_state` setting `(parent_id, meta) = (p, m)` for
   `node_id = c`.

### undo_op(log_entry)
- If `old_existed = 0`: delete `c` from `T__tree_state`.
- Else: upsert `T__tree_state` for `c` setting `(parent, meta) = (old_parent, old_meta)`.

### apply_op(new_op)
Run inside a single SQL transaction.

```
later := SELECT log entries WHERE (ts, actor) > (new_op.ts, new_op.actor)
                            ORDER BY (ts, actor) DESC

for each entry in later:  undo_op(entry); DELETE FROM T__tree_log WHERE ...
do_op(new_op)
for each entry in reverse(later):  do_op(entry)   # rebuilds log + state
```

This is identical to the paper's recursive `apply_op` (Fig. 4 lines 42–49)
collapsed into an iterative loop. The recursion's "rest of log" is the
prefix with `ts > new_op.ts`; we undo them, do the new op, redo them.

## Cycle check — recursive CTE

```sql
WITH RECURSIVE anc(node) AS (
    SELECT :new_parent
    WHERE :new_parent IS NOT NULL
  UNION ALL
    SELECT s.parent_id
    FROM   T__tree_state s, anc
    WHERE  s.node_id = anc.node
      AND  s.parent_id IS NOT NULL
)
SELECT EXISTS(SELECT 1 FROM anc WHERE node = :child);
```

Stops naturally at NULL or at the child. O(d) where d = tree depth.

## Wire-up

```
local move:
    crsql_tree_move(name, c, p, m, ts, actor)
        → INSERT INTO T__tree_ops VALUES (ts, actor, c, p, m)
            (cr-sqlite ships row to peers via crsql_changes)
        → AFTER INSERT trigger calls apply_op UDF

remote move (arriving via cr-sqlite apply):
        same AFTER INSERT trigger on T__tree_ops fires
        → apply_op UDF
```

One code path. The trigger is the seam.

## UDFs

| name | signature | purpose |
|---|---|---|
| `crsql_create_tree(name)` | `(TEXT) → NULL` | register a tree (creates the 3 tables + trigger) |
| `crsql_tree_move(name, c, p, m, ts, actor)` | `(TEXT, BLOB, BLOB?, BLOB?, INT, BLOB) → NULL` | append + locally apply |
| `crsql_tree_apply(name, ts, actor)` | `(TEXT, INT, BLOB) → NULL` | trigger-only: run apply_op for the named op |

`crsql_tree_apply` is the AFTER INSERT trigger body. Single entry point —
both local and remote ops route through it.

## What's deliberately not here

- **Lamport clock**: caller-supplied. The CRDT does not own time. A consumer
  builds a Lamport clock on top (read max ts from `T__tree_ops`, +1, write).
- **Actor IDs**: caller-supplied. A consumer picks how it identifies itself.
- **Trash / deletion**: caller convention. Pick a sentinel node, move there.
- **Sibling ordering**: caller puts a fractional index or RGA tag in `meta`.
  The CRDT just preserves whatever bytes the caller wrote.
- **Log truncation (§3.7)**: deferred. Causally-stable threshold tracking
  needs replica-set knowledge, which is a consumer concern.

## Testing

- **Pinned regressions** (paper §2): the cases real systems get wrong.
  - Concurrent move-same-node: A→B vs A→C (Fig. 1).
  - Concurrent would-form-cycle: A→B vs B→A (Fig. 2).
  - Move-to-descendant-of-self: rejected locally.
- **Property fuzz**: random multi-peer scenarios with `mkdir`/`move`,
  assert all peers converge to identical `T__tree_state`. Mirrors
  `tests/smoke/text-crdt-fuzz.mjs`.
