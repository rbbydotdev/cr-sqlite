// Verifies Case 1 (Weidner): consecutive appends to our own run extend the existing
// row in place instead of creating new rows.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  return db;
}
function setup(db) {
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
}
const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
const ins = (db, p, t) => db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(p, t);
const rowCount = (db) =>
  db.prepare("SELECT count(*) FROM __crsql_fugue_notes_body WHERE row_pk=1").pluck().get();

function fail(msg, db) {
  console.error("FAIL:", msg);
  if (db) {
    console.error(
      "rows:",
      db
        .prepare("SELECT itemId, idx, content FROM __crsql_fugue_notes_body WHERE row_pk=1 ORDER BY itemId, idx")
        .all(),
    );
  }
  process.exit(1);
}

// 1. Sequential appends should collapse to ONE row via Case 1 extension.
{
  const db = open();
  setup(db);
  for (let i = 0; i < 100; i++) ins(db, i, "x");
  const text = body(db);
  if (text.length !== 100) fail(`expected 100 chars, got ${text.length}`, db);
  const rows = rowCount(db);
  if (rows !== 1) fail(`expected 1 row after 100 sequential appends, got ${rows}`, db);
  console.log(`ok: 100 sequential appends → 1 row (Case 1 extension active)`);
}

// 2. Append after a single insert at start.
{
  const db = open();
  setup(db);
  ins(db, 0, "hello");
  if (rowCount(db) !== 1) fail(`after 1 insert: ${rowCount(db)}`, db);
  ins(db, 5, " world");
  if (body(db) !== "hello world") fail(`body: ${body(db)}`, db);
  if (rowCount(db) !== 1) fail(`expected 1 row after sequential appends, got ${rowCount(db)}`, db);
  console.log(`ok: "hello" + " world" → 1 row, body="${body(db)}"`);
}

// 3. Insert + append-elsewhere creates a 2nd row (Case 1 doesn't fire if not after our last run).
{
  const db = open();
  setup(db);
  ins(db, 0, "hello world");
  // Now insert "AND " at position 6 (mid-run) — splits "hello world" first
  ins(db, 6, "AND ");
  // body should be "hello AND world"
  if (body(db) !== "hello AND world") fail(`body: ${body(db)}`, db);
  // Row count: split creates 2 rows from the original, AND is a new row = 3 total
  // Then Case 1 wouldn't fire for "AND" since it's not appended after our last position
  const rows = rowCount(db);
  console.log(`ok: mid-run insert → ${rows} rows, body="${body(db)}"`);
}

// 4. Mixed: append-extend, then mid-run split (which creates new rows), then append-extend again.
{
  const db = open();
  setup(db);
  ins(db, 0, "AAA");      // 1 row "AAA"
  ins(db, 3, "BBB");      // Case 1 extends to "AAABBB", still 1 row
  if (rowCount(db) !== 1) fail(`after extends: ${rowCount(db)}`, db);
  ins(db, 3, "X");        // mid-run split; row "AAABBB" → "AAA" + "BBB", + new "X" between
  if (body(db) !== "AAAXBBB") fail(`body: ${body(db)}`, db);
  // After split: 3 rows (L=AAA, R=BBB, X new)
  // Subsequent append at end (position 7): right neighbor is BBB but Case 1 fails — BBB is
  // rightmost of its itemId now (since L "AAA" has smaller idx) ... wait need to think
  const rowsAfter = rowCount(db);
  ins(db, 7, "CCC");      // append at end
  const rowsFinal = rowCount(db);
  if (body(db) !== "AAAXBBBCCC") fail(`final body: ${body(db)}`, db);
  console.log(
    `ok: AAA + BBB (1 row) → split into AAAXBBB (${rowsAfter} rows) → CCC append (${rowsFinal} rows): "${body(db)}"`,
  );
}

console.log("\nPASS: Case 1 in-place extension verified");
