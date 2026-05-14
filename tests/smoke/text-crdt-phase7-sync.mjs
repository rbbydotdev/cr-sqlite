// Phase 7: end-to-end sync integration. Two-node CRR sync that includes a text-CRDT column,
// flowing through the existing crsql_changes protocol. Builds on tests/smoke/sync-two-nodes.mjs
// but with text-CRDT semantics on `notes.body`.

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
  db.exec("INSERT INTO notes (id, title, body) VALUES (1, 'shared', '')");
}

const siteId = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
const renderBody = (db) =>
  db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const titleOf = (db) => db.prepare("SELECT title FROM notes WHERE id=1").pluck().get();
const ins = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

function pull(from, exclude) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
    )
    .all(exclude);
}
function apply(to, changes) {
  if (!changes.length) return;
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
}
function syncBoth(a, b) {
  apply(b, pull(a, siteId(b)));
  apply(a, pull(b, siteId(a)));
}

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const a = open();
const b = open();
setup(a);
setup(b);
console.log("two nodes initialized");

// 1. A inserts text-CRDT body content
ins(a, 0, "hello");
if (renderBody(a) !== "hello") fail(`A text after insert: ${renderBody(a)}`);

// 2. A also updates title (normal LWW column)
a.prepare("UPDATE notes SET title='alpha' WHERE id=1").run();

// 3. Sync A → B
syncBoth(a, b);
if (renderBody(b) !== "hello") fail(`B text after sync: ${renderBody(b)}`);
if (titleOf(b) !== "alpha") fail(`B title after sync: ${titleOf(b)}`);
console.log("ok: A's text + title synced to B");

// 4. Both peers do divergent edits on the text-CRDT column
ins(a, 5, " world");
ins(b, 0, "say ");
// Different title updates too
a.prepare("UPDATE notes SET title='alpha-2' WHERE id=1").run();
b.prepare("UPDATE notes SET title='beta' WHERE id=1").run();

// 5. Bidirectional sync
syncBoth(a, b);

const aText = renderBody(a);
const bText = renderBody(b);
const aTitle = titleOf(a);
const bTitle = titleOf(b);
console.log(`A: ${JSON.stringify({ title: aTitle, body: aText })}`);
console.log(`B: ${JSON.stringify({ title: bTitle, body: bText })}`);

if (aText !== bText) fail(`text diverged: A=${aText} B=${bText}`);
if (aTitle !== bTitle) fail(`title diverged: A=${aTitle} B=${bTitle}`);
if (!aText.includes("hello") || !aText.includes("say ") || !aText.includes(" world"))
  fail(`text lost content: ${aText}`);
console.log("ok: text-CRDT + LWW columns converge through crsql_changes");

// 6. Confirm cr-sqlite's existing change-log doesn't lose other CRR tables
//    Insert another note row (not text-CRDT, just normal)
a.prepare("INSERT INTO notes (id, title, body) VALUES (2, 'plain', 'plain text')").run();
syncBoth(a, b);
const plain = b.prepare("SELECT id, title, body FROM notes WHERE id=2").get();
if (!plain || plain.title !== "plain") fail(`plain row not synced: ${JSON.stringify(plain)}`);
console.log("ok: normal rows still sync alongside text-CRDT");

console.log("\nPASS: Phase 7 end-to-end sync integration");
