// Edge cases pinned by the fast-path opt-out (#2). These would have
// produced corrupted body JSON under the old heuristic WHEN clause:
//
//   1. User types `[hello]` literal — content that LOOKS like JSON but
//      isn't ours. Old check would have classified as valid JSON, skipped
//      re-render, left body holding plain text.
//   2. Tail-append into a Peritext column — old Fugue fast-path did
//      `body = body || ?` directly, corrupting the JSON. Now opt'd out.
//   3. Many sequential tail appends — same as #2 but stresses repeat fires.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_peritext('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const insertText = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();

// ── 1. JSON-like content (literal "[hello]") does not fool the trigger
{
  const db = open();
  insertText(db, 0, "[hello]");
  const out = body(db);
  let parsed;
  try { parsed = JSON.parse(out); }
  catch (e) { fail(`body not valid JSON: ${out}`); }
  if (parsed.length !== 1 || parsed[0].text !== "[hello]")
    fail(`expected single span "[hello]", got ${out}`);
  console.log("ok: bracket-shaped literal text renders as a single span, not raw");
  db.close();
}

// ── 2. Tail append — would have triggered Fugue's fast-path
{
  const db = open();
  insertText(db, 0, "hello");      // sets body to JSON([{text:"hello",marks:{}}])
  insertText(db, 5, " world");     // tail append — pre-fix this corrupted body
  const out = body(db);
  let parsed;
  try { parsed = JSON.parse(out); }
  catch (e) { fail(`body not valid JSON after tail append: ${out}`); }
  const text = parsed.map((s) => s.text).join("");
  if (text !== "hello world") fail(`expected "hello world", got ${out}`);
  console.log("ok: tail append produces valid JSON (fast-path opt-out)");
  db.close();
}

// ── 3. Many sequential tail appends
{
  const db = open();
  insertText(db, 0, "a");
  for (let i = 1; i < 20; i++) {
    insertText(db, i, String.fromCharCode(97 + (i % 26)));
  }
  const out = body(db);
  let parsed;
  try { parsed = JSON.parse(out); }
  catch (e) { fail(`body not valid JSON after sequential appends: ${out}`); }
  const text = parsed.map((s) => s.text).join("");
  if (text.length !== 20) fail(`expected 20 chars, got ${text.length}: ${out}`);
  console.log("ok: 20 sequential tail appends — body stays valid JSON throughout");
  db.close();
}

// ── 4. Append a literal ']' — would have made body look JSON-terminated
{
  const db = open();
  insertText(db, 0, "abc");
  insertText(db, 3, "]");  // tail append `]` — old heuristic could be fooled
  const out = body(db);
  let parsed;
  try { parsed = JSON.parse(out); }
  catch (e) { fail(`body not valid JSON after appending "]": ${out}`); }
  const text = parsed.map((s) => s.text).join("");
  if (text !== "abc]") fail(`expected "abc]", got ${out}`);
  console.log("ok: appending a literal ']' does not fool the trigger");
  db.close();
}

console.log("\nfastpath-edge: ok");
