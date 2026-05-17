// Smoke: full block-and-inline rich-text document composed out of the
// four primitives (tree-CRDT + peritext + Fugue + fractional index).
// No new CRDT code — verifies the composition works end-to-end:
//
//   1. Build a multi-block doc (heading + paragraph + bullet list).
//   2. Recursive-CTE render → flat preorder traversal.
//   3. Edit text + marks inside a block.
//   4. Block operations: insert, reorder, indent (re-parent), trash.
//   5. Two-peer convergence on doc edits.
//
// The design lives in docs/design/rich-text-blocks.md.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SIDE_BEFORE = 0;
const ROOT = Buffer.from([0x01]);
const TRASH = Buffer.from([0xff]);

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const eq = (a, b, label) => {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}\n  want: ${sb}\n  got:  ${sa}`);
};

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  // BLOB PK needs explicit NOT NULL — only INTEGER PRIMARY KEY is
  // automatically NOT NULL in SQLite. cr-sqlite rejects nullable PKs.
  db.exec(`
    CREATE TABLE blocks (
      id    BLOB PRIMARY KEY NOT NULL,
      kind  TEXT NOT NULL DEFAULT '',
      attrs TEXT,
      body  TEXT
    );
  `);
  db.prepare("SELECT crsql_as_crr('blocks')").get();
  db.prepare("SELECT crsql_as_peritext('blocks', 'body')").get();
  db.prepare("SELECT crsql_create_tree('doc')").get();
  // sentinels
  db.prepare("INSERT INTO blocks (id, kind) VALUES (?, 'document')").run(ROOT);
  db.prepare("INSERT INTO blocks (id, kind) VALUES (?, 'trash')").run(TRASH);
  return db;
}

const newBlock = (db, id, kind, attrs = null) =>
  db.prepare("INSERT INTO blocks (id, kind, attrs) VALUES (?, ?, ?)").run(id, kind, attrs);

const placeBlock = (db, id, parent, frac, ts, actor) =>
  db
    .prepare("SELECT crsql_tree_move('doc', ?, ?, ?, ?, ?)")
    .run(id, parent, Buffer.from(frac), BigInt(ts), actor);

const typeText = (db, blockId, pos, text) =>
  db.prepare("SELECT crsql_fugue_insert('blocks','body',?,?,?)").get(blockId, pos, text);

const markRange = (db, blockId, start, end, name, val, ts, actor) =>
  db
    .prepare("SELECT crsql_peritext_mark('blocks','body',?,?,?,?,?,?,?,?,?)")
    .run(
      blockId,
      BigInt(start),
      BigInt(end),
      name,
      val,
      BigInt(SIDE_BEFORE),
      BigInt(SIDE_BEFORE),
      BigInt(ts),
      actor
    );

// CAST(... AS BLOB) on both rungs of the recursive CTE: SQLite's `||`
// operator silently returns TEXT when either operand is TEXT, and the
// type-affinity rules order all TEXT values before all BLOB values in
// `ORDER BY`, which would put descendants ahead of root-level siblings.
const RENDER_SQL = `
  WITH RECURSIVE walk(node, parent, depth, ord_path) AS (
      SELECT s.node_id, s.parent_id, 0, CAST(s.meta AS BLOB)
      FROM   doc__tree_state s
      WHERE  s.parent_id = ?
    UNION ALL
      SELECT s.node_id, s.parent_id, w.depth + 1,
             CAST(w.ord_path || X'00' || s.meta AS BLOB)
      FROM   doc__tree_state s, walk w
      WHERE  s.parent_id = w.node
  )
  SELECT w.depth, w.node AS id, b.kind, b.attrs, b.body
  FROM   walk w JOIN blocks b ON b.id = w.node
  WHERE  b.id != ?
  ORDER  BY w.ord_path
`;

function render(db) {
  return db
    .prepare(RENDER_SQL)
    .all(ROOT, TRASH)
    .map((r) => ({
      depth: r.depth,
      kind: r.kind,
      attrs: r.attrs == null ? null : JSON.parse(r.attrs),
      // body may be null (non-text blocks) or empty before any text typed
      body: r.body && r.body.length > 0 ? JSON.parse(r.body) : null,
    }));
}

// ── Test 1: build doc + render via CTE in preorder ──────────────────
{
  const db = open();
  const alice = Buffer.from("alice");

  // Block IDs (1-byte BLOBs for test readability)
  const H1 = Buffer.from([0x10]);
  const P1 = Buffer.from([0x11]);
  const UL = Buffer.from([0x12]);
  const LI1 = Buffer.from([0x13]);
  const LI1_P = Buffer.from([0x14]);
  const LI2 = Buffer.from([0x15]);
  const LI2_P = Buffer.from([0x16]);

  newBlock(db, H1, "heading", '{"level":1}');
  newBlock(db, P1, "paragraph");
  newBlock(db, UL, "list", '{"style":"bullet"}');
  newBlock(db, LI1, "list-item");
  newBlock(db, LI1_P, "paragraph");
  newBlock(db, LI2, "list-item");
  newBlock(db, LI2_P, "paragraph");

  // Tree placement — top-level order: H1, P1, UL
  placeBlock(db, H1, ROOT, "a", 1, alice);
  placeBlock(db, P1, ROOT, "b", 2, alice);
  placeBlock(db, UL, ROOT, "c", 3, alice);
  // list-items under UL: LI1, LI2
  placeBlock(db, LI1, UL, "a", 4, alice);
  placeBlock(db, LI2, UL, "b", 5, alice);
  // each li has one paragraph
  placeBlock(db, LI1_P, LI1, "a", 6, alice);
  placeBlock(db, LI2_P, LI2, "a", 7, alice);

  // type content
  typeText(db, H1, 0, "Heading");
  typeText(db, P1, 0, "Hello world.");
  typeText(db, LI1_P, 0, "First item");
  typeText(db, LI2_P, 0, "Second item");

  const flat = render(db);
  // Expect preorder traversal at correct depths.
  eq(
    flat.map((r) => [r.depth, r.kind]),
    [
      [0, "heading"],
      [0, "paragraph"],
      [0, "list"],
      [1, "list-item"],
      [2, "paragraph"],
      [1, "list-item"],
      [2, "paragraph"],
    ],
    "preorder depth+kind"
  );
  eq(flat[0].attrs, { level: 1 }, "heading attrs");
  eq(flat[0].body[0].text, "Heading", "heading body text");
  eq(flat[1].body[0].text, "Hello world.", "paragraph body text");
  console.log("ok: build + CTE render preserves preorder");
  db.close();
}

// ── Test 2: edit text + marks within a block ─────────────────────────
{
  const db = open();
  const alice = Buffer.from("alice");
  const P = Buffer.from([0x20]);
  newBlock(db, P, "paragraph");
  placeBlock(db, P, ROOT, "a", 1, alice);

  typeText(db, P, 0, "Hello world.");
  // bold "world" — positions 6..11
  markRange(db, P, 6, 11, "bold", null, 10, alice);

  const flat = render(db);
  eq(flat.length, 1, "one paragraph");
  const spans = flat[0].body;
  // Three spans: "Hello ", "world", "."
  eq(
    spans.map((s) => [s.text, s.marks]),
    [
      ["Hello ", {}],
      ["world", { bold: true }],
      [".", {}],
    ],
    "spans with bold"
  );
  console.log("ok: text edit + inline mark inside block");
  db.close();
}

// ── Test 3: block operations — insert, reorder, indent, trash ────────
{
  const db = open();
  const alice = Buffer.from("alice");
  const A = Buffer.from([0x30]);
  const B = Buffer.from([0x31]);
  const C = Buffer.from([0x32]);

  newBlock(db, A, "paragraph");
  newBlock(db, B, "paragraph");
  newBlock(db, C, "paragraph");

  // Initial order: A, B, C under root
  placeBlock(db, A, ROOT, "a", 1, alice);
  placeBlock(db, B, ROOT, "b", 2, alice);
  placeBlock(db, C, ROOT, "c", 3, alice);
  typeText(db, A, 0, "A");
  typeText(db, B, 0, "B");
  typeText(db, C, 0, "C");

  eq(
    render(db).map((r) => r.body[0].text),
    ["A", "B", "C"],
    "initial order"
  );

  // Reorder: move B to first position via a fractional index that sorts
  // before 'a'. With BLOB byte-comparison, '0' (0x30) < 'a' (0x61).
  placeBlock(db, B, ROOT, "0", 10, alice);
  eq(
    render(db).map((r) => r.body[0].text),
    ["B", "A", "C"],
    "B reordered to front"
  );

  // Indent: make A a child of B (think of B as a list-item, A as its
  // nested paragraph).
  placeBlock(db, A, B, "a", 11, alice);
  const flat = render(db);
  eq(
    flat.map((r) => [r.depth, r.body[0].text]),
    [
      [0, "B"],
      [1, "A"],
      [0, "C"],
    ],
    "A indented under B"
  );

  // Trash: delete C by moving it under the trash sentinel.
  placeBlock(db, C, TRASH, "a", 12, alice);
  eq(
    render(db).map((r) => [r.depth, r.body[0].text]),
    [
      [0, "B"],
      [1, "A"],
    ],
    "C trashed"
  );

  console.log("ok: insert/reorder/indent/trash all via tree_move");
  db.close();
}

// ── Test 4: two-peer convergence on doc edits ───────────────────────
{
  const a = open();
  const b = open();
  const alice = Buffer.from("alice");
  const bob = Buffer.from("bob");

  // Seed a's doc with one paragraph, sync to b
  const P = Buffer.from([0x40]);
  newBlock(a, P, "paragraph");
  placeBlock(a, P, ROOT, "a", 1, alice);
  typeText(a, P, 0, "hello");

  const syncPair = (x, y) => {
    const sy = y.prepare("SELECT quote(crsql_site_id())").pluck().get().replace(/^X'/, "x'");
    const sx = x.prepare("SELECT quote(crsql_site_id())").pluck().get().replace(/^X'/, "x'");
    const stmt = (db) =>
      db.prepare(
        `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
         VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`
      );
    const apply = (db, rows) => {
      const s = stmt(db);
      db.transaction((rs) => rs.forEach((r) => s.run(r)))(rows);
    };
    const pullX = x
      .prepare(
        `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
         FROM crsql_changes WHERE site_id IS NOT ?`
      )
      .all(sy);
    const pullY = y
      .prepare(
        `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
         FROM crsql_changes WHERE site_id IS NOT ?`
      )
      .all(sx);
    apply(y, pullX);
    apply(x, pullY);
  };
  // b needs the sentinels first
  syncPair(a, b);

  // Concurrent: a types more text in P; b adds a new heading before P.
  typeText(a, P, 5, " world");
  const H = Buffer.from([0x41]);
  newBlock(b, H, "heading", '{"level":1}');
  placeBlock(b, H, ROOT, "0", 10, bob); // sorts before 'a'
  typeText(b, H, 0, "Title");

  syncPair(a, b);

  const ra = render(a);
  const rb = render(b);
  eq(
    ra.map((r) => [r.depth, r.kind, r.body && r.body[0].text]),
    rb.map((r) => [r.depth, r.kind, r.body && r.body[0].text]),
    "two peers converge structurally"
  );
  // Doc should have heading first, then paragraph with "hello world"
  eq(
    ra.map((r) => [r.kind, r.body[0].text]),
    [
      ["heading", "Title"],
      ["paragraph", "hello world"],
    ],
    "merged doc content"
  );
  console.log("ok: two-peer convergence on concurrent block-add + text-edit");
  a.close();
  b.close();
}

console.log("\nrich-text-blocks: ok");
