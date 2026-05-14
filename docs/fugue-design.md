# Fugue Text-CRDT in cr-sqlite — Design Reference

**Source:** [vlcn-io/cr-sqlite#65](https://github.com/vlcn-io/cr-sqlite/issues/65)
**Authors of the design:** `mweidner037` (Matthew Weidner, Fugue paper) + `tantaman` (Matt Wonlaw, cr-sqlite)
**Status:** Final design endorsed by both. Issue closed. **Never implemented.**

This document is a quote-faithful extraction of the design. We build from this, not from paraphrase.

---

## Core insight: rows are RUNS, not characters

An **item** is "a run of text inserted contiguously, left-to-right, by a single user." A **sub-item** is a slice of an item. The sub-item's `index` is the **last** index it strictly contains.

A user typing "Hey there" creates ONE row:

```
(itemId="Alice724", index=8, content="Hey there")
```

A 10KB document typed normally is tens of rows, not 10K. Splits only happen when a peer inserts inside an existing run.

---

## Table schema

```sql
CREATE TABLE fugue (
    itemId TEXT,
    index INT,
    content TEXT,                    -- NULL = tombstone
    parentItemId TEXT,
    parentIndex INT,
    PRIMARY KEY (itemId, index),
    FOREIGN KEY (parentItemId, parentIndex) REFERENCES fugue
);
```

**Index decision (our call — Weidner didn't specify):** add `CREATE INDEX ON fugue (parentItemId, parentIndex)` — the recursive read query joins on these columns.

---

## Tree order

> "The `parentItemId` and `parentIndex` columns reference an existing sub-item, turning the rows into a tree. This tree is sorted in depth-first order, with siblings sorted by `itemId`, then `index`."

`(itemId, index)` lex-ordering is the **sole** sibling tie-breaker. This is how Fugue's non-interleaving guarantee is captured: concurrent inserts as children of the same parent get a deterministic, globally agreed order.

---

## Read path (recursive CTE)

```sql
WITH RECURSIVE under_node(content, level, itemId, index) AS (
    VALUES ('Root', 0, ?, ?)               -- start at root
    UNION ALL
    SELECT fugue.content, under_node.level + 1, fugue.itemId, fugue.index
        FROM fugue
        JOIN under_node ON fugue.parentItemId = under_node.itemId
                       AND fugue.parentIndex  = under_node.index
        ORDER BY 2 DESC, fugue.itemId, fugue.index
)
SELECT content, itemId, index FROM under_node
WHERE index != -1;                          -- filter "fake" left-children sentinels
```

The `index != -1` filter drops the sentinel rows used by insertion case 3 (see below). Tombstoned rows (`content IS NULL`) survive the read but contribute no text; group_concat naturally skips NULLs.

---

## Insertion (3 cases)

> "To insert a new character, assume you know the `(itemId, index)` of its left and right neighbors. You need to insert it somewhere that will be between these neighbors."

**Case 1 — extend the left neighbor's item.**
Allowed if (a) the local device created that item, (b) the left neighbor is the last char in that item, (c) sub-item `(leftItemId, leftIndex)` has no children. Append to its `content`, increment its `index`.

**Case 2 — create a new child of the left neighbor.**
If `(leftItemId, leftIndex)` has no children. If the sub-item doesn't exist yet, create it by splitting.

**Case 3 — left-side child of the right neighbor (Fugue's left/right distinction).**
Else: create `(rightItemId, -1)` with `content = NULL` as a sentinel, then create a new child under that sentinel. The `-1` makes the new sub-item sort to the left of the right neighbor. This is how this design captures Fugue's "left-origin vs right-origin" insertion to avoid interleaving anomalies. The read query filters `index = -1`.

---

## Split example

Starting:
```
Root
  (itemId="Alice724", index=8, content="Hey there")
```

Bob inserts "you " between "Hey " and "there":
```
Root
  (itemId="Alice724", index=3, content="Hey ")     -- split: new sub-item
    (itemId="Bob639",   index=3, content="you ")   -- child of "Hey "
  (itemId="Alice724", index=8, content="there")    -- trimmed: was "Hey there"
```

---

## Deletion — tombstone sub-items

`content = NULL` rows are tombstones.

Single-char delete of the "y" in "Hey you":
```
Starting:
  (itemId="Alice724", index=6, content="Hey you")

After:
  (itemId="Alice724", index=3, content="Hey ")
  (itemId="Alice724", index=4, content=NULL)        -- tombstone for "y"
  (itemId="Alice724", index=6, content="ou")
```

---

## Merge — cleanup pass (tantaman's algorithm, Weidner-endorsed)

When applying remote changes, you union rows (skipping duplicate primary keys; Weidner: "whichever you pick, the cleanup algorithm gives the same final answer"). Then you must trim overlapping sub-items of the same item.

**Algorithm:**

1. Take the row with the smallest `index` (for a given `itemId`).
2. For each row of the same `itemId` whose `startIndex < currentIndex` where `startIndex = otherIndex - len(otherContent) - 1`, trim its content from offset `currentIndex + 1` to its end.
3. Repeat with the next smallest index.

Tombstone pass (after the normal cleanup):

> "For each primary key `(itemId, lastIndex)` whose content is NULL in either source table, set its content to NULL in the merged table."

This means: if any peer says "this slice is deleted," the slice stays deleted in the merge result. Adopt-the-tombstone semantics.

---

## Tombstone coalescing (optional, performance)

> "Adjacent deletions within the same item are logically equivalent to one big tombstone sub-item. You are free to 'coalesce' these: delete the non-rightmost tombstone sub-items. Except, don't delete any sub-items that have children."

Weidner's caveat: *"(Have not checked this thoroughly.)"* — mark as ambiguous, defer until perf measurements demand it.

---

## What Weidner explicitly left open

- **Whole design is "(Untested)".** No reference implementation exists, in any language.
- **No indexes specified.** We pick.
- **itemId generation.** Implied `(replicaId, counter)` UID but never nailed down.
- **cr-sqlite changes-vtab integration.** Never re-addressed for the Fugue design. We have to design this.
- **Coalescing safety.** "(Have not checked this thoroughly.)"
- **Mapping site_id / clock to cr-sqlite's db_version model.** Surfaced in the thread for the prior Yjs sketch, never re-addressed for Fugue.

---

## Our additions / decisions for the build

These are **our** decisions, not Weidner's. Capture them as such:

| Question | Our decision |
|----------|--------------|
| Index on `(parentItemId, parentIndex)` | Yes — read query joins on it. |
| `itemId` format | `{site_id_hex}.{counter}` — `site_id` from `crsql_site_id()`, counter monotonic per-peer per-table. |
| Multiple Fugue columns per project | Each `crsql_as_text_crdt(table, col)` creates its own backing table: `__crsql_fugue_{table}_{col}`. |
| Parent-column materialization | Trigger on the Fugue backing table updates `{table}.{col}` to the rendered text. Consumers `SELECT body FROM notes` and get the live string. |
| Coalescing | Deferred until perf requires it. Single-tenant single-project means we can afford uncoalesced tombstones longer than upstream-scale systems could. |
| Cleanup pass on remote-apply | Trigger fires on INSERT/UPDATE into the Fugue table during sync. Cleanup runs scoped to the affected `itemId`. **Open: should this run per-row or at commit?** |
