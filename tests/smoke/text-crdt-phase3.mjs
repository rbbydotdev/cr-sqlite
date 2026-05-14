// Phase 3: insertion + deletion round-trip via crsql_fugue_insert/_delete.
// Gate: insert-delete sequences produce correct rendered text.

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
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, title TEXT, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, title, body) VALUES (1, 't', '')");
}

const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").get().body;
const insert = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);
const del = (db, from, to) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(from, to);
const rows = (db) =>
  db
    .prepare(
      "SELECT itemId, idx, content FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx",
    )
    .all();

function fail(msg, db) {
  console.error("FAIL:", msg);
  console.error("rows:", rows(db));
  process.exit(1);
}

const db = open();
setup(db);

insert(db, 0, "hello world");
if (body(db) !== "hello world") fail(`init: '${body(db)}'`, db);
console.log("ok: 'hello world'");

// 1. Whole-row delete: delete everything.
del(db, 0, body(db).length);
if (body(db) !== "") fail(`whole delete: '${body(db)}'`, db);
console.log("ok: whole delete → ''");

// 2. Re-insert and try mid-row delete.
insert(db, 0, "hello world");
if (body(db) !== "hello world") fail(`re-insert: '${body(db)}'`, db);

// 3. Delete the space → "helloworld" (split: L="hello", M=" ", R="world")
del(db, 5, 6);
if (body(db) !== "helloworld") fail(`del space: '${body(db)}'`, db);
console.log("ok: del space → 'helloworld'");

// 4. Delete the first char → "elloworld"
del(db, 0, 1);
if (body(db) !== "elloworld") fail(`del first: '${body(db)}'`, db);
console.log("ok: del first → 'elloworld'");

// 5. Delete the last char → "elloworl"
del(db, body(db).length - 1, body(db).length);
if (body(db) !== "elloworl") fail(`del last: '${body(db)}'`, db);
console.log("ok: del last → 'elloworl'");

// 6. Insert "X" at position 4 of "elloworl" → "elloXworl" (before the 'w')
insert(db, 4, "X");
if (body(db) !== "elloXworl") fail(`insert mid: '${body(db)}'`, db);
console.log("ok: insert mid → 'elloXworl'");

// 7. Multi-row span delete: with "elloXworl" (positions 0-8), del[1,7) removes "lloXwo" → "erl".
//    "X" is its own row, "worl" is a different row; this exercises crossing row boundaries.
del(db, 1, 7);
if (body(db) !== "erl") fail(`multi-row del: '${body(db)}'`, db);
console.log("ok: multi-row del → 'erl'");

// 8. Edge: delete empty range is no-op
const beforeRows = rows(db).length;
del(db, 1, 1);
if (rows(db).length !== beforeRows) fail("empty range should be no-op", db);
console.log("ok: empty range is no-op");

// 9. Delete out of range (past end) — should do nothing
del(db, 100, 200);
if (body(db) !== "erl") fail(`out-of-range delete changed body: '${body(db)}'`, db);
console.log("ok: out-of-range delete no-op");

console.log("\nPASS: Phase 3 deletion verified");
console.log("final rows:", rows(db).length);
