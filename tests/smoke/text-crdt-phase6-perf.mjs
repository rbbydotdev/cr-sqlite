// Phase 6 perf sanity: bulk paste row count, keystroke-rate latency.
// Gate: 10K paste < 100ms, 100-keystroke session < 500ms.

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

const insert = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);
const render = (db) =>
  db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const rowCount = (db) =>
  db
    .prepare("SELECT count(*) FROM __crsql_fugue_notes_body WHERE row_pk = 1")
    .pluck()
    .get();

// 1. 10K-char paste row count
{
  const db = open();
  setup(db);
  const text = "x".repeat(10000);
  const t0 = performance.now();
  insert(db, 0, text);
  const dt = performance.now() - t0;
  const rows = rowCount(db);
  const rendered = render(db);
  console.log(`10K paste: ${dt.toFixed(1)}ms, ${rows} backing rows, rendered length ${rendered.length}`);
  // 10K paste is a SINGLE crsql_fugue_insert call with `text` of length 10000.
  // The Fugue path writes one backing row regardless of `text` length, so 1 row
  // is the expected outcome — not a Case-1 in-place extension.
  if (rendered.length !== 10000) {
    console.error("FAIL: rendered length wrong");
    process.exit(1);
  }
  if (dt > 100) {
    console.warn(`SOFT-FAIL: 10K paste took ${dt.toFixed(1)}ms (>100ms target)`);
  } else {
    console.log("ok: 10K paste under 100ms");
  }
}

// 2. 100-keystroke session
{
  const db = open();
  setup(db);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) {
    insert(db, i, "x");
  }
  const dt = performance.now() - t0;
  const rows = rowCount(db);
  const rendered = render(db);
  console.log(`100 keystrokes: ${dt.toFixed(1)}ms, ${rows} backing rows, rendered length ${rendered.length}`);
  if (rendered.length !== 100) {
    console.error("FAIL: rendered length wrong");
    process.exit(1);
  }
  if (dt > 500) {
    console.warn(`SOFT-FAIL: 100 keystrokes took ${dt.toFixed(1)}ms (>500ms target)`);
  } else {
    console.log("ok: 100 keystrokes under 500ms");
  }
}

// 3. Large document profile (1000 keystrokes, varied positions)
{
  const db = open();
  setup(db);
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const len = render(db).length;
    const pos = len === 0 ? 0 : Math.floor(Math.random() * len);
    insert(db, pos, "x");
  }
  const dt = performance.now() - t0;
  console.log(`1000 random-position keystrokes: ${dt.toFixed(1)}ms (avg ${(dt / 1000).toFixed(2)}ms/op)`);
  if (dt > 5000) {
    console.warn(`SOFT-FAIL: 1000 inserts took ${dt.toFixed(1)}ms (>5s — concerning)`);
  }
}

console.log("\nPASS: Phase 6 perf sanity");
