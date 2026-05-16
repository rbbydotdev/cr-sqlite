# Example: a filesystem layered on the tree-CRDT + text-CRDT primitives

Worked example showing how a downstream consumer would assemble a
collaborative filesystem out of this fork's three primitives:

- **cr-sqlite** — column-level LWW for metadata.
- **`crsql_as_text_crdt`** — Fugue character-CRDT for text-file contents.
- **`crsql_create_tree`** — Kleppmann move-CRDT for directory structure.

The filesystem layer owns the schema below. The CRDT primitives stay
generic — they do not know that a "node" is an inode or that "meta" is a
filename.

```
┌─────────────────────────────────────────────────────────────────────┐
│  application: fs.promises-style API (writeFile, mkdir, rename, …)   │
├─────────────────────────────────────────────────────────────────────┤
│        inodes (LWW metadata + text-CRDT content + LWW blob)         │
│        fs__tree_* (Kleppmann move-CRDT — parent + filename)         │
├─────────────────────────────────────────────────────────────────────┤
│                            cr-sqlite                                │
└─────────────────────────────────────────────────────────────────────┘
```

## Schema

```sql
-- 1. The inode store — owns per-node payload. The tree CRDT references
--    these rows by id but never reads their other columns.
CREATE TABLE inodes (
    id            BLOB PRIMARY KEY,            -- UUIDv7 (16 bytes)
    kind          TEXT    NOT NULL DEFAULT '', -- 'file' | 'dir' | 'symlink'
    mode          INTEGER NOT NULL DEFAULT 0,  -- POSIX mode bits
    mtime_ms      INTEGER NOT NULL DEFAULT 0,
    text_content  TEXT,                        -- text-file body (collaborative)
    blob_content  BLOB,                        -- binary-file body (LWW)
    symlink_target TEXT                        -- for kind='symlink'
);
SELECT crsql_as_crr('inodes');

-- Promote text_content to a character-level CRDT. Two peers editing the
-- same file converge to a Fugue merge instead of LWW-clobbering.
SELECT crsql_as_text_crdt('inodes', 'text_content');

-- 2. Tree CRDT — manages ONLY (parent, name, child). The CRDT primitive
--    treats node_id as opaque BLOB; the FS layer uses inode UUIDs.
SELECT crsql_create_tree('fs');

-- 3. Well-known sentinels. Created once at init. Their ids are the FS
--    layer's convention; the CRDT does not privilege any node.
INSERT INTO inodes (id, kind, mode) VALUES
    (X'00000000000000000000000000000001', 'dir',   0o755),  -- root
    (X'000000000000000000000000000000FF', 'dir',   0o700);  -- trash
```

That is the entire CRDT-aware schema. Everything below is read-side
ergonomics (views, recursive CTEs).

## Operations

### mkdir / write file / mv / rm

```sql
-- mkdir /foo
INSERT INTO inodes (id, kind, mode) VALUES (:foo_id, 'dir', 0o755);
SELECT crsql_tree_move('fs', :foo_id, :root_id, 'foo', :ts, :actor);

-- write text file /foo/note.md (initial empty body, then edits stream in)
INSERT INTO inodes (id, kind, mode) VALUES (:note_id, 'file', 0o644);
SELECT crsql_tree_move('fs', :note_id, :foo_id, 'note.md', :ts, :actor);
SELECT crsql_fugue_insert('inodes', 'text_content', :note_id, 0, 'hello');

-- rename /foo/note.md → /foo/README.md  (same parent, new edge meta)
SELECT crsql_tree_move('fs', :note_id, :foo_id, 'README.md', :ts, :actor);

-- move /foo/README.md → /bar/README.md  (different parent, same name)
SELECT crsql_tree_move('fs', :note_id, :bar_id, 'README.md', :ts, :actor);

-- rm /foo  (and its entire subtree) — move under trash sentinel
SELECT crsql_tree_move('fs', :foo_id, :trash_id, '', :ts, :actor);
```

`:ts` is a Lamport timestamp the FS layer maintains (e.g. `MAX(lamport_ts)
+ 1` over `fs__tree_ops`). `:actor` is a stable per-peer byte string
(e.g. cr-sqlite's `crsql_site_id()`).

### ls a directory

```sql
SELECT
    s.node_id            AS child_id,
    CAST(s.meta AS TEXT) AS name,
    i.kind, i.mode, i.mtime_ms,
    LENGTH(i.text_content) + LENGTH(i.blob_content) AS size
FROM   fs__tree_state s
JOIN   inodes i ON i.id = s.node_id
WHERE  s.parent_id = :dir_id
ORDER  BY name;
```

### Path → inode resolution (recursive CTE)

```sql
WITH RECURSIVE walk(parent_id, remaining) AS (
    -- start at root, with the full path-minus-leading-slash to consume
    SELECT X'00000000000000000000000000000001', 'foo/bar/README.md'
  UNION ALL
    SELECT s.node_id,
           SUBSTR(walk.remaining, INSTR(walk.remaining, '/') + 1)
    FROM   walk
    JOIN   fs__tree_state s ON s.parent_id = walk.parent_id
    WHERE  CAST(s.meta AS TEXT) = CASE
               WHEN INSTR(walk.remaining, '/') = 0 THEN walk.remaining
               ELSE SUBSTR(walk.remaining, 1, INSTR(walk.remaining, '/') - 1)
           END
      AND  walk.remaining != ''
)
SELECT parent_id AS inode FROM walk WHERE remaining = '' LIMIT 1;
```

(In a real Node binding you'd implement this as a regular function over
`fs__tree_state`; the CTE is shown to make the relationship explicit.)

### Visible tree (excludes the trash subtree)

```sql
CREATE VIEW fs_visible AS
WITH RECURSIVE trashed(id) AS (
    SELECT X'000000000000000000000000000000FF'
  UNION ALL
    SELECT s.node_id FROM fs__tree_state s JOIN trashed t ON s.parent_id = t.id
)
SELECT s.node_id, s.parent_id, CAST(s.meta AS TEXT) AS name, i.*
FROM   fs__tree_state s
JOIN   inodes i ON i.id = s.node_id
WHERE  s.node_id NOT IN (SELECT id FROM trashed);
```

A garbage collector can periodically `DELETE FROM inodes WHERE id IN
trashed` once it's confident the deletion is causally stable (paper §3.7).

## Concurrent-edit semantics — what each primitive guarantees

| scenario | resolution | source |
|---|---|---|
| Two peers edit `text_content` of the same file at different offsets | Both edits land, Fugue-merged | text-CRDT |
| Two peers `chmod` the same file concurrently | Higher `(col_version, site_id)` wins | cr-sqlite LWW |
| Two peers rename `/a/x.txt` to different names | Higher `(lamport_ts, actor)` wins; the loser's rename is discarded at apply time | tree-CRDT do_op |
| Peer A `mv /a /b`, peer B `mv /b /a` | Lower-ts op stands; higher-ts op skipped (would form cycle) | tree-CRDT cycle check (Kleppmann Fig. 2) |
| Two peers `mkdir /foo` concurrently | Two distinct inodes with the same `name` meta land in the same parent — both visible. The FS layer is responsible for disambiguating (e.g. by appending `(2)`, or by the user picking a winner). | tree-CRDT preserves both edges |
| Peer A writes `/a/x.txt`, peer B deletes `/a` | A's file ends up under trash (its parent moved). Convergent: the move-to-trash op for `/a` carries `/a/x.txt` along by virtue of `/a` being its parent. | tree-CRDT |

## What this layer does NOT inherit for free

- **Filename uniqueness within a parent**: the tree CRDT keeps every edge.
  Concurrent `mkdir /foo` produces two `foo` siblings. The FS layer needs
  a tie-breaker rule (rename to `foo (2)` at read time, or merge inodes,
  or surface a conflict marker).
- **Hardlinks**: each node has at most one parent in the tree CRDT. A
  filesystem wanting hardlinks needs a separate `links(inode_id, parent,
  name)` table — but multi-link semantics on a CRDT are an open design
  question (the paper's algorithm is for trees, not DAGs).
- **Causal-stability GC**: the tree-CRDT log grows monotonically. Pruning
  is a consumer responsibility (paper §3.7) — typically driven by knowing
  the replica set's min-seen-timestamp.
- **POSIX `O_EXCL` create / atomic rename / locking**: classic concurrent
  filesystem features that rely on synchronous coordination. Out of scope
  for an optimistic CRDT.

## What you'd build in Node on top

A minimal `fs.promises`-shaped wrapper would be:

```ts
import { open } from 'better-sqlite3';
const db = open(':memory:');
db.loadExtension('crsqlite');
db.exec(SCHEMA_SQL);                  // the CREATE TABLE block above

function lamportTs() {
  return (db.prepare("SELECT COALESCE(MAX(lamport_ts), 0) + 1 FROM fs__tree_ops")
          .pluck().get() as number);
}
const me = db.prepare("SELECT crsql_site_id()").pluck().get() as Buffer;

export async function mkdir(path: string) { /* resolve parent, insert inode, tree_move */ }
export async function writeFile(path: string, body: string | Buffer) { /* … */ }
export async function rename(from: string, to: string) { /* tree_move */ }
export async function rm(path: string) { /* tree_move to trash sentinel */ }
export async function readdir(path: string) { /* SELECT … */ }
```

The CRDT layer never enters this code beyond `crsql_tree_move` and
`crsql_fugue_insert`. Substituting a different tree-shaped consumer
(XML/JSON document, scene graph, org-chart) reuses the same primitives
with different `meta` semantics.
