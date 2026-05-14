// Regression: child inserted while one peer is "offline" (no sync) AT a mid-run
// position of a Case-1-extended parent run must render correctly on both peers
// after reconnect. Earlier the SQL render joined on exact parentIdx=idx, so a
// child attached at parentIdx=11 was lost when the parent's stored idx jumped
// to 29 via Case 1 in-place extension. compute_render walks per-character now.

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
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

const siteId = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
const body = (db) => db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
// The materialized `notes.body` column is what real consumers read. After
// apply-time split, it MUST match the explicit render — that's the whole point
// of pushing the work into the engine (no client-side render workarounds).
const bodyCol = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
const ins = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

function pull(from, excludeSiteId) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
    )
    .all(excludeSiteId);
}

function apply(to, changes) {
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
}

function bidiSync(a, b) {
  apply(b, pull(a, siteId(b)));
  apply(a, pull(b, siteId(a)));
}

const a = open();
const b = open();

// Step 1: A types "hello world " — all from A's site, single run via Case 1.
ins(a, 0, "hello world ");
if (body(a) !== "hello world ") throw new Error(`A step1 body: '${body(a)}'`);
console.log("step 1: A typed 'hello world ' → 1 row via Case 1");

// Step 2: sync to B.
bidiSync(a, b);
if (body(b) !== "hello world ") throw new Error(`B step2 body: '${body(b)}'`);
console.log("step 2: sync → B sees 'hello world '");

// Step 3: B "goes offline". A continues typing — Case 1 extends A's run.
ins(a, body(a).length, "(while B offline) ");
if (body(a) !== "hello world (while B offline) ")
  throw new Error(`A step3 body: '${body(a)}'`);
const aRowsAfterExtend = a
  .prepare("SELECT itemId, idx, content FROM __crsql_fugue_notes_body WHERE row_pk = 1 AND idx != -1 AND tombstoned = 0")
  .all();
if (aRowsAfterExtend.length !== 1)
  throw new Error(`A should have 1 row after Case 1 extend, got ${aRowsAfterExtend.length}: ${JSON.stringify(aRowsAfterExtend)}`);
console.log("step 3: A extended to 'hello world (while B offline) ' — still 1 row (Case 1)");

// Step 4: B (still offline) inserts at end of its local view (pos=12, after "hello world ")
ins(b, body(b).length, "[B was offline] ");
if (body(b) !== "hello world [B was offline] ")
  throw new Error(`B step4 body: '${body(b)}'`);
console.log("step 4: B inserted '[B was offline] ' at end of its local 'hello world '");

// Step 5: reconnect — bidirectional sync.
bidiSync(a, b);

// Both peers must converge AND include B's offline insert.
const aFinal = body(a);
const bFinal = body(b);
console.log("step 5: after reconnect → A:", JSON.stringify(aFinal), "B:", JSON.stringify(bFinal));
console.log("A rows after reconnect:");
for (const r of a.prepare("SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx").all()) console.log("  ", r);
console.log("B rows after reconnect:");
for (const r of b.prepare("SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx").all()) console.log("  ", r);

if (aFinal !== bFinal) {
  console.error("FAIL: peers diverged after reconnect");
  process.exit(1);
}
const expected = "hello world [B was offline] (while B offline) ";
if (aFinal !== expected) {
  console.error(`FAIL: expected '${expected}'`);
  console.error(`got     '${aFinal}'`);
  console.error("A rows:", a.prepare("SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk = 1").all());
  process.exit(1);
}

console.log("A rows after reconnect:");
for (const r of a.prepare("SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx").all()) console.log("  ", r);
console.log("B rows after reconnect:");
for (const r of b.prepare("SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx").all()) console.log("  ", r);

// Test gap from the audit: the materialized `body` column on the parent table
// must also match the explicit render, otherwise consumers reading via
// `SELECT body FROM notes` see stale state. Apply-time split is what restores
// the invariant; without it the trigger's exact-idx CTE drops B's child.
const aBodyCol = bodyCol(a);
const bBodyCol = bodyCol(b);
if (aBodyCol !== expected) {
  console.error(`FAIL: notes.body on A is stale: ${JSON.stringify(aBodyCol)}`);
  console.error(`      expected:                ${JSON.stringify(expected)}`);
  process.exit(1);
}
if (bBodyCol !== expected) {
  console.error(`FAIL: notes.body on B is stale: ${JSON.stringify(bBodyCol)}`);
  console.error(`      expected:                ${JSON.stringify(expected)}`);
  process.exit(1);
}
console.log("step 6: notes.body materialized column matches on both peers");

console.log("\nPASS: Case-1 extended run + offline mid-run child renders correctly");
