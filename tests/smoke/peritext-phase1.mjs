// Phase 1 smoke: Peritext primitive — registration, simple mark, JSON render.
// Single-replica only; convergence is phase 3.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SIDE_BEFORE = 0;
const SIDE_AFTER = 1;

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  return db;
}

function fail(m) {
  console.error("FAIL:", m);
  process.exit(1);
}

function setup(db) {
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_peritext('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

const ACTOR = Buffer.from("alice");

const insertText = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

const mark = (db, start, end, name, value, sSide, eSide, ts) =>
  db.prepare(
    "SELECT crsql_peritext_mark('notes','body',1,?,?,?,?,?,?,?,?)"
  ).run(
    BigInt(start),
    BigInt(end),
    name,
    value,
    BigInt(sSide),
    BigInt(eSide),
    BigInt(ts),
    ACTOR
  );

const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();

// ── 1. registration creates the marks table and meta table ───────────
{
  const db = setup(open());
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  if (!tables.includes("__crsql_peritext_notes_body_marks")) {
    fail(`missing marks table; got ${tables}`);
  }
  if (!tables.includes("__crsql_peritext_meta")) {
    fail(`missing meta table; got ${tables}`);
  }
  console.log("ok: registration creates marks + meta tables");
  db.close();
}

// ── 2. empty document renders as [] (via direct UDF; column reflects
//      whatever the user-INSERT put in it until a Fugue write fires the
//      render trigger — same behavior as plain text-CRDT)
{
  const db = setup(open());
  const out = db
    .prepare("SELECT crsql_peritext_render('notes','body',1)")
    .pluck()
    .get();
  if (out !== "[]") fail(`empty render expected [], got ${JSON.stringify(out)}`);
  console.log("ok: empty document renders as []");
  db.close();
}

// ── 3. text-only (no marks) produces single span with empty marks ────
{
  const db = setup(open());
  insertText(db, 0, "Hello");
  const out = body(db);
  const parsed = JSON.parse(out);
  if (parsed.length !== 1) fail(`expected 1 span, got ${parsed.length}: ${out}`);
  if (parsed[0].text !== "Hello") fail(`expected text "Hello", got ${out}`);
  if (Object.keys(parsed[0].marks).length !== 0)
    fail(`expected empty marks, got ${out}`);
  console.log("ok: plain text → single unformatted span");
  db.close();
}

// ── 4. bold over a middle range splits into 3 spans ──────────────────
{
  const db = setup(open());
  insertText(db, 0, "The fox jumped.");
  // bold "fox" — positions 4..7 (inclusive..exclusive: "fox")
  mark(db, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100);
  const out = body(db);
  const parsed = JSON.parse(out);
  if (parsed.length !== 3) fail(`expected 3 spans, got ${parsed.length}: ${out}`);
  const [a, b, c] = parsed;
  if (a.text !== "The " || Object.keys(a.marks).length !== 0)
    fail(`span 0 wrong: ${JSON.stringify(a)}`);
  if (b.text !== "fox" || b.marks.bold !== true)
    fail(`span 1 wrong: ${JSON.stringify(b)}`);
  if (c.text !== " jumped." || Object.keys(c.marks).length !== 0)
    fail(`span 2 wrong: ${JSON.stringify(c)}`);
  console.log("ok: bold middle range produces 3 spans");
  db.close();
}

// ── 5. link mark with TEXT value round-trips ──────────────────────────
{
  const db = setup(open());
  insertText(db, 0, "Click here.");
  // link "here" — positions 6..10 inclusive..exclusive
  mark(db, 6, 10, "link", "https://example.com", SIDE_BEFORE, SIDE_AFTER, 200);
  const parsed = JSON.parse(body(db));
  const linked = parsed.find((s) => s.marks.link);
  if (!linked) fail(`no linked span: ${JSON.stringify(parsed)}`);
  if (linked.marks.link !== "https://example.com") {
    fail(`link value wrong: ${JSON.stringify(linked)}`);
  }
  console.log("ok: link mark carries TEXT value");
  db.close();
}

// ── 6. unmark cancels: highest opId wins ─────────────────────────────
{
  const db = setup(open());
  insertText(db, 0, "Hello");
  mark(db, 0, 5, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100);
  // Now unmark over the same range with higher ts → removeMark wins.
  db.prepare(
    "SELECT crsql_peritext_unmark('notes','body',1,?,?,?,?,?,?,?)"
  ).run(BigInt(0), BigInt(5), "bold", BigInt(SIDE_BEFORE), BigInt(SIDE_BEFORE), BigInt(200), ACTOR);

  const parsed = JSON.parse(body(db));
  // Should render as plain text (single span, no marks).
  const hasBold = parsed.some((s) => s.marks.bold);
  if (hasBold) fail(`unmark didn't cancel bold: ${body(db)}`);
  console.log("ok: removeMark with higher opId cancels addMark");
  db.close();
}

console.log("\nphase1: ok");
