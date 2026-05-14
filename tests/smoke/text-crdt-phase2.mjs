// Phase 2: crsql_fugue_insert covers single-peer insertion (Case 2 + Case 3).
// Gate: insert sequences at varied positions; SELECT body returns correct string.

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

function body(db) {
  return db.prepare("SELECT body FROM notes WHERE id = 1").get().body;
}

function insert(db, pos, text) {
  return db.prepare("SELECT crsql_fugue_insert('notes', 'body', 1, ?, ?) AS n").get(pos, text).n;
}

function rows(db) {
  return db
    .prepare(
      "SELECT itemId, idx, content, parentItemId, parentIdx FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx",
    )
    .all();
}

function fail(msg) {
  console.error("FAIL:", msg);
  console.error("rows:", rows(globalThis.__db));
  process.exit(1);
}

const db = open();
globalThis.__db = db;
setup(db);

// 1. Empty doc → insert at 0 → body = "hello"
let n = insert(db, 0, "hello");
console.log("rows written:", n);
if (body(db) !== "hello") fail(`expected 'hello', got ${JSON.stringify(body(db))}`);
console.log("ok: empty → 'hello'");

// 2. Append at end → body = "hello world"
insert(db, 5, " world");
if (body(db) !== "hello world") fail(`expected 'hello world', got ${JSON.stringify(body(db))}`);
console.log("ok: append → 'hello world'");

// 3. Prepend at 0 → body = "say hello world"
//    (left has children = "hello"'s child " world"? No — root has multiple children,
//     "hello" run has no children of its own. So this is a new root child.)
insert(db, 0, "say ");
if (body(db) !== "say hello world") fail(`expected 'say hello world', got ${JSON.stringify(body(db))}`);
console.log("ok: prepend → 'say hello world'");

// 4. Insert at a boundary position (between "say " and "hello"). Mid-run splits
//    at arbitrary offsets are covered by tests/smoke/text-crdt-tighten-mid-run.mjs;
//    here we just verify boundary inserts work in the base Phase 2 path.
insert(db, 4, "great ");
if (body(db) !== "say great hello world")
  fail(`expected 'say great hello world', got ${JSON.stringify(body(db))}`);
console.log("ok: insert at boundary → 'say great hello world'");

// 5. Append again at end
insert(db, body(db).length, "!");
if (body(db) !== "say great hello world!")
  fail(`expected 'say great hello world!', got ${JSON.stringify(body(db))}`);
console.log("ok: append → 'say great hello world!'");

// 6. Row count sanity: 5 inserts should produce ~5–7 backing rows (one per run, plus any sentinels)
const backingCount = rows(db).length;
console.log(`backing row count: ${backingCount} (5 inserts)`);
if (backingCount > 12) fail(`too many backing rows: ${backingCount}`);
console.log("ok: row count reasonable");

// 7. Empty text is a no-op
const beforeRows = rows(db).length;
const wrote = insert(db, 0, "");
if (wrote !== 0 || rows(db).length !== beforeRows) fail("empty insert should be no-op");
console.log("ok: empty insert is no-op");

console.log("\nPASS: Phase 2 insertion verified");
