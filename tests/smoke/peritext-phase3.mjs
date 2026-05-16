// Phase 3 smoke: Peritext primitive — two-peer convergence via
// crsql_changes. Each peer issues marks/edits independently; after
// bidirectional sync the rendered portable-text JSON must match
// byte-for-byte across peers.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SIDE_BEFORE = 0;

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_peritext('notes', 'body')").get();
  return db;
}

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const insertText = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

const mark = (db, s, e, name, val, ss, es, ts, actor) =>
  db
    .prepare("SELECT crsql_peritext_mark('notes','body',1,?,?,?,?,?,?,?,?)")
    .run(BigInt(s), BigInt(e), name, val, BigInt(ss), BigInt(es), BigInt(ts), actor);

const unmark = (db, s, e, name, ss, es, ts, actor) =>
  db
    .prepare("SELECT crsql_peritext_unmark('notes','body',1,?,?,?,?,?,?,?)")
    .run(BigInt(s), BigInt(e), name, BigInt(ss), BigInt(es), BigInt(ts), actor);

const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();

function siteId(db) {
  return db.prepare("SELECT quote(crsql_site_id())").pluck().get();
}

function pullSince(db, since, excludeSite) {
  return db
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes
       WHERE db_version > ?
         AND site_id IS NOT ?`
    )
    .all(since, excludeSite);
}

function applyChanges(db, changes) {
  const stmt = db.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`
  );
  const tx = db.transaction((rows) => rows.forEach((r) => stmt.run(r)));
  tx(changes);
}

function sync(a, b) {
  const aToB = pullSince(a, 0, siteId(b).replace(/^X'/, "x'"));
  const bToA = pullSince(b, 0, siteId(a).replace(/^X'/, "x'"));
  applyChanges(b, aToB);
  applyChanges(a, bToA);
}

function initShared(a, b, text) {
  // Insert the base document on a, sync to b, then both insert into notes
  // so the parent row exists on both sides. cr-sqlite syncs the backing
  // table; the parent INSERT primes notes.id so the render trigger has a
  // row to update.
  a.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  b.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  if (text) insertText(a, 0, text);
  sync(a, b);
}

// ── Test 1: concurrent disjoint bolds converge (paper Ex 2 across peers) ──
{
  const a = open();
  const b = open();
  initShared(a, b, "The fox jumped.");
  // Concurrent: a bolds "The" (0-3), b bolds "fox" (4-7)
  mark(a, 0, 3, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  mark(b, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 101, Buffer.from("bob"));
  sync(a, b);
  const ba = body(a);
  const bb = body(b);
  if (ba !== bb) {
    console.error("a:", ba);
    console.error("b:", bb);
    fail("test 1: bodies diverged");
  }
  const parsed = JSON.parse(ba);
  const bolded = parsed.filter((s) => s.marks.bold).map((s) => s.text);
  if (JSON.stringify(bolded) !== JSON.stringify(["The", "fox"])) {
    fail(`test 1: expected ["The","fox"] bolded, got ${ba}`);
  }
  console.log("ok: concurrent disjoint bolds converge");
  a.close();
  b.close();
}

// ── Test 2: concurrent overlapping bold + italic (paper Ex 3) ──────
{
  const a = open();
  const b = open();
  initShared(a, b, "The fox jumped.");
  // a bolds "The fox" (0-7); b italicizes "fox jumped" (4-14)
  mark(a, 0, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  mark(b, 4, 14, "italic", null, SIDE_BEFORE, SIDE_BEFORE, 101, Buffer.from("bob"));
  sync(a, b);
  const ba = body(a);
  const bb = body(b);
  if (ba !== bb) {
    console.error("a:", ba);
    console.error("b:", bb);
    fail("test 2: bodies diverged");
  }
  const parsed = JSON.parse(ba);
  // Expect overlap region "fox" has both bold AND italic.
  const both = parsed.find((s) => s.marks.bold && s.marks.italic);
  if (!both || both.text !== "fox") {
    fail(`test 2: expected "fox" with both bold+italic, got ${ba}`);
  }
  console.log("ok: concurrent bold+italic overlap converges");
  a.close();
  b.close();
}

// ── Test 3: concurrent LWW conflict — bold + unbold same range ────
{
  const a = open();
  const b = open();
  initShared(a, b, "The fox jumped.");
  // a bolds "fox" at ts=10; b unbolds "fox" at ts=11 (higher → wins)
  mark(a, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 10, Buffer.from("alice"));
  unmark(b, 4, 7, "bold", SIDE_BEFORE, SIDE_BEFORE, 11, Buffer.from("bob"));
  sync(a, b);
  const ba = body(a);
  const bb = body(b);
  if (ba !== bb) {
    console.error("a:", ba);
    console.error("b:", bb);
    fail("test 3: bodies diverged");
  }
  const parsed = JSON.parse(ba);
  const hasBold = parsed.some((s) => s.marks.bold);
  if (hasBold) fail(`test 3: expected no bold (unbold ts=11 wins), got ${ba}`);
  console.log("ok: concurrent bold+unbold LWW resolves on opId");
  a.close();
  b.close();
}

// ── Test 4: concurrent text insertions + marks all converge ────────
// a bolds "Hello" (positions 0-5, end_side=BEFORE → mark grows at end).
// b concurrently inserts " beautiful" right at position 5.
// Per paper Example 7, the inserted text inherits the bold because its
// anchor falls inside the bold's [before-H, before-space-original) range.
{
  const a = open();
  const b = open();
  initShared(a, b, "Hello world.");
  mark(a, 0, 5, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  insertText(b, 5, " beautiful");
  sync(a, b);
  const ba = body(a);
  const bb = body(b);
  if (ba !== bb) {
    console.error("a:", ba);
    console.error("b:", bb);
    fail("test 4: bodies diverged");
  }
  const parsed = JSON.parse(ba);
  const fullText = parsed.map((s) => s.text).join("");
  if (fullText !== "Hello beautiful world.") {
    fail(`test 4: text merge wrong, got "${fullText}"`);
  }
  // Bold expanded across the concurrent insert (paper Ex 7 behavior).
  const bolded = parsed.filter((s) => s.marks.bold).map((s) => s.text).join("");
  if (bolded !== "Hello beautiful") {
    fail(`test 4: expected bold expanded to "Hello beautiful", got "${bolded}" in ${ba}`);
  }
  console.log("ok: concurrent text insert at end of mark inherits mark (Ex 7)");
  a.close();
  b.close();
}

// ── Test 5: same scenario but end_side=AFTER → bold stays pinned ─────
{
  const a = open();
  const b = open();
  initShared(a, b, "Hello world.");
  // end_side = SIDE_AFTER (=1): bold doesn't grow at end.
  mark(a, 0, 5, "bold", null, SIDE_BEFORE, 1, 100, Buffer.from("alice"));
  insertText(b, 5, " beautiful");
  sync(a, b);
  if (body(a) !== body(b)) {
    fail("test 5: bodies diverged");
  }
  const parsed = JSON.parse(body(a));
  const bolded = parsed.filter((s) => s.marks.bold).map((s) => s.text).join("");
  if (bolded !== "Hello") {
    fail(`test 5: expected bold pinned to "Hello", got "${bolded}" in ${body(a)}`);
  }
  console.log("ok: end_side=AFTER keeps bold pinned across concurrent insert");
  a.close();
  b.close();
}

console.log("\nphase3: ok");
