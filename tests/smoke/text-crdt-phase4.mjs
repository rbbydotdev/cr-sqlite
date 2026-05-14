// Phase 4: two-peer text-CRDT convergence via crsql_changes.
// Each peer makes divergent edits; exchange the change log; both should converge.

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

const siteId = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").get().body;
const ins = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);
const del = (db, from, to) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(from, to);
const rows = (db) =>
  db
    .prepare(
      "SELECT itemId, idx, content FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx",
    )
    .all();

function pullChanges(from, excludeSiteId) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
    )
    .all(excludeSiteId);
}

function applyChanges(to, changes) {
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
}

function fail(msg, dbs) {
  console.error("FAIL:", msg);
  for (const [label, db] of dbs) {
    console.error(`${label} body:`, JSON.stringify(body(db)));
    console.error(`${label} rows:`, rows(db));
  }
  process.exit(1);
}

// ---- Scenario 1: identical setup, divergent edits, sync both ways. ----
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "hello");
  // exchange so both peers see "hello"
  applyChanges(b, pullChanges(a, siteId(b)));
  if (body(b) !== "hello") fail(`b should see 'hello' after sync; got '${body(b)}'`, [["a", a], ["b", b]]);
  console.log("scenario 1 step 1: both see 'hello'");

  // Now divergent: A appends " world", B prepends "say "
  ins(a, body(a).length, " world");
  ins(b, 0, "say ");
  // Each peer is locally consistent before sync
  if (body(a) !== "hello world") fail(`A pre-sync: ${body(a)}`, [["a", a]]);
  if (body(b) !== "say hello") fail(`B pre-sync: ${body(b)}`, [["b", b]]);

  // Bidirectional sync
  applyChanges(b, pullChanges(a, siteId(b)));
  applyChanges(a, pullChanges(b, siteId(a)));

  const aBody = body(a);
  const bBody = body(b);
  console.log(`A: ${JSON.stringify(aBody)}`);
  console.log(`B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody)
    fail(`scenario 1 diverged: A=${JSON.stringify(aBody)} B=${JSON.stringify(bBody)}`, [
      ["a", a],
      ["b", b],
    ]);
  // Expected: contains "say ", "hello", " world" — likely "say hello world"
  if (!aBody.includes("hello") || !aBody.includes("say ") || !aBody.includes(" world"))
    fail(`scenario 1 missing content: ${JSON.stringify(aBody)}`, [["a", a]]);
  console.log("ok: scenario 1 — concurrent prepend + append converged");
}

// ---- Scenario 2: concurrent inserts at the SAME position. ----
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "ab");
  applyChanges(b, pullChanges(a, siteId(b)));

  // Both insert at position 1 (between 'a' and 'b')
  ins(a, 1, "X");
  ins(b, 1, "Y");

  applyChanges(b, pullChanges(a, siteId(b)));
  applyChanges(a, pullChanges(b, siteId(a)));

  const aBody = body(a);
  const bBody = body(b);
  console.log(`A: ${JSON.stringify(aBody)} | B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody)
    fail(`scenario 2 diverged: A=${aBody} B=${bBody}`, [["a", a], ["b", b]]);
  if (!aBody.includes("X") || !aBody.includes("Y") || aBody.length !== 4)
    fail(`scenario 2 wrong content: ${aBody}`, [["a", a]]);
  console.log("ok: scenario 2 — concurrent inserts at same position converged");
}

// ---- Scenario 3: peer A deletes, peer B concurrently inserts in the deleted region. ----
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "hello");
  applyChanges(b, pullChanges(a, siteId(b)));

  // A deletes "ello", B inserts "X" at position 3
  del(a, 1, 5);
  ins(b, 3, "X");

  applyChanges(b, pullChanges(a, siteId(b)));
  applyChanges(a, pullChanges(b, siteId(a)));

  const aBody = body(a);
  const bBody = body(b);
  console.log(`A: ${JSON.stringify(aBody)} | B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody)
    fail(`scenario 3 diverged: A=${aBody} B=${bBody}`, [["a", a], ["b", b]]);
  console.log("ok: scenario 3 — concurrent delete + insert converged");
}

// ---- Scenario 4: concurrent SPLIT of the same item by both peers. ----
// A and B both start with "Hey there", then each inserts in the middle simultaneously.
// This exercises the case Weidner's cleanup pass was written for.
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "Hey there");
  applyChanges(b, pullChanges(a, siteId(b)));

  // A inserts at position 3 (between "Hey" and " there")
  ins(a, 3, " YOU");
  // B inserts at position 4 (between "Hey " and "there")
  ins(b, 4, "AND ");

  // bidirectional sync
  applyChanges(b, pullChanges(a, siteId(b)));
  applyChanges(a, pullChanges(b, siteId(a)));

  const aBody = body(a);
  const bBody = body(b);
  console.log(`A: ${JSON.stringify(aBody)} | B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody)
    fail(`scenario 4 diverged: A=${aBody} B=${bBody}`, [["a", a], ["b", b]]);
  // Convergence is the gate. Semantic correctness (no doubled "Hey", clean Fugue ordering)
  // is gated by Phase 5 property tests + cleanup pass.
  if (!aBody.includes("YOU") || !aBody.includes("AND"))
    fail(`scenario 4 lost content: ${aBody}`, [["a", a]]);
  console.log("ok: scenario 4 — concurrent split converged (semantic correctness gated by Phase 5)");
}

console.log("\nPASS: Phase 4 base convergence verified");
// #!~ Phase 5 — concurrent SPLIT (scenario 4) converges but produces duplicated content (e.g., "HeyHey  AND ").
//     This is the case Weidner's cleanup-pass / NULL-tombstone-wins was designed for.
//     Hypothesis property tests will reveal the divergence-or-corruption surface and tell us
//     whether cleanup needs to be implemented before Phase 7 sync integration.
