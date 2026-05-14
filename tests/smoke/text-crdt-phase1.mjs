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

// 7. Render trigger is installed in both modes; transparent mode has a WHEN suppression
//    clause that skips renders while a fugue_* function is mid-flight.
const trigger = db
  .prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='__crsql_fugue_notes_body__render_ai'",
  )
  .get();
if (!trigger) fail("expected render trigger to exist in transparent mode");
if (!trigger.sql.includes("WHEN") || !trigger.sql.includes("__crsql_fugue_active"))
  fail(`transparent-mode trigger missing WHEN suppression clause:\n${trigger.sql}`);
console.log("ok: transparent-mode trigger installed with suppression WHEN clause");

// Eager mode was removed in β-flat — it produced identical outputs to the
// default mode and only added duplicate trigger fires for local writes. The
// `crsql_as_text_crdt` UDF now ignores a 3rd argument if passed, for
// compatibility with older scripts. Verify that the (otherwise-ignored) 3rd
// arg still doesn't change trigger behaviour: WHEN-suppression remains.
db.exec("CREATE TABLE eager_notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
db.prepare("SELECT crsql_as_crr('eager_notes')").get();
db.prepare("SELECT crsql_as_text_crdt('eager_notes', 'body', 1)").get();
const legacyTrigger = db
  .prepare(
    "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='__crsql_fugue_eager_notes_body__render_ai'",
  )
  .get();
if (!legacyTrigger) fail("expected render trigger");
if (!legacyTrigger.sql.includes("WHEN") || !legacyTrigger.sql.includes("__crsql_fugue_active"))
  fail(`render trigger missing WHEN suppression clause:\n${legacyTrigger.sql}`);
console.log("ok: legacy 3rd-arg accepted; trigger still suppression-gated");

// Active-counter helper table exists (idempotent across registrations).
const activeTable = db
  .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='__crsql_fugue_active'")
  .get().n;
if (activeTable !== 1) fail("expected __crsql_fugue_active helper table");
console.log("ok: __crsql_fugue_active helper table exists");

// 8. Idempotent — second call is a no-op (no error)
db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
console.log("ok: idempotent");

// 9. Manual INSERT into backing fires the transparent-mode trigger (counter=0),
//    which auto-renders notes.body. No flush needed.
db.exec("INSERT INTO notes (id, title, body) VALUES (1, 't', '')");
db.prepare(
  `INSERT INTO __crsql_fugue_notes_body (row_pk, itemId, idx, content, parentItemId, parentIdx, tombstoned)
   VALUES (1, 'Alice', 4, 'Hey ', '', -2, 0)`,
).run();
const row = db.prepare("SELECT body FROM notes WHERE id = 1").get();
if (row.body !== "Hey ")
  fail(`auto-render wrong: got ${JSON.stringify(row.body)} expected 'Hey '`);
console.log("ok: transparent-mode trigger auto-renders on manual INSERT (sync-apply path)");

console.log("\nPASS: Phase 1 registration verified (transparent mode)");
