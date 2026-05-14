// Phase 1 smoke: crsql_as_text_crdt creates the backing table + index + render trigger.
// Does not test insert/delete yet (those are Phase 2/3).

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

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const db = open();

// 0. Error path: column doesn't exist
db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, title TEXT, body TEXT)");
db.prepare("SELECT crsql_as_crr('notes')").get();

try {
  db.prepare("SELECT crsql_as_text_crdt('notes', 'nope')").get();
  fail("expected error for missing column");
} catch (e) {
  if (!String(e.message).includes("does not exist")) fail(`wrong error for missing column: ${e.message}`);
  console.log("ok: missing column rejected");
}

// 1. Error path: table is not a CRR
db.exec("CREATE TABLE plain (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
try {
  db.prepare("SELECT crsql_as_text_crdt('plain', 'body')").get();
  fail("expected error for non-CRR table");
} catch (e) {
  if (!String(e.message).includes("is not a CRR")) fail(`wrong error for non-CRR: ${e.message}`);
  console.log("ok: non-CRR table rejected");
}

// 2. Happy path: notes.body becomes a text-CRDT column
db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
console.log("ok: registration succeeded");

// 3. Backing table exists
const tbls = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__crsql_fugue_%'")
  .all()
  .map((r) => r.name);
if (!tbls.includes("__crsql_fugue_notes_body")) fail(`backing table missing; got ${JSON.stringify(tbls)}`);
console.log("ok: backing table exists");

// 4. Backing table is WITHOUT ROWID
const tableInfo = db
  .prepare("SELECT sql FROM sqlite_master WHERE name='__crsql_fugue_notes_body'")
  .get();
if (!tableInfo.sql.toUpperCase().includes("WITHOUT ROWID"))
  fail(`backing table missing WITHOUT ROWID: ${tableInfo.sql}`);
console.log("ok: WITHOUT ROWID");

// 5. Backing table is a CRR (has its own __crsql_clock)
const clockExists = db
  .prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE name='__crsql_fugue_notes_body__crsql_clock'",
  )
  .get();
if (clockExists.n !== 1) fail("backing not marked as CRR (clock table missing)");
console.log("ok: backing is a CRR");

// 6. Parent index exists
const idxExists = db
  .prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='__crsql_fugue_notes_body__parent_idx'",
  )
  .get();
if (idxExists.n !== 1) fail("parent index missing");
console.log("ok: parent index exists");

// 7. Render trigger exists
const trgExists = db
  .prepare(
    "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name='__crsql_fugue_notes_body__render_ai'",
  )
  .get();
if (trgExists.n !== 1) fail("render trigger missing");
console.log("ok: render trigger exists");

// 8. Idempotent — second call is a no-op (no error)
db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
console.log("ok: idempotent");

// 9. Manual insert into backing fires the render trigger and populates notes.body
db.exec("INSERT INTO notes (id, title, body) VALUES (1, 't', '')");
db.prepare(
  `INSERT INTO __crsql_fugue_notes_body (row_pk, itemId, idx, content, parentItemId, parentIdx)
   VALUES (1, 'Alice', 4, 'Hey ', '', -2)`,
).run();
const row = db.prepare("SELECT body FROM notes WHERE id = 1").get();
if (row.body !== "Hey ") fail(`render trigger wrong: got ${JSON.stringify(row.body)} expected 'Hey '`);
console.log("ok: render trigger materializes 'Hey '");

console.log("\nPASS: Phase 1 registration verified");
