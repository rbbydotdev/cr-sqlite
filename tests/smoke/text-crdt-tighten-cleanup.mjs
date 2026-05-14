// Verifies the cleanup pass dedups concurrent-split duplication.
// Scenario: two peers each split the same item; without cleanup → "HeyHey..." duplication.
// With cleanup → tantaman's trim algorithm yields the correct Fugue render.

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
const setup = (db) => {
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
};
const siteId = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
const body = (db) => db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const ins = (db, p, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(p, t);
const cleanup = (db) =>
  db.prepare("SELECT crsql_fugue_cleanup('notes','body',1)").pluck().get();
const rows = (db) =>
  db
    .prepare(
      "SELECT itemId, idx, content FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx",
    )
    .all();

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

function fail(msg, dbs) {
  console.error("FAIL:", msg);
  for (const [label, db] of dbs) {
    console.error(`${label} body:`, JSON.stringify(body(db)));
    console.error(`${label} rows:`, rows(db));
  }
  process.exit(1);
}

// Concurrent-split scenario (the case Weidner's cleanup pass was designed for).
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "Hey there");
  syncBoth(a, b);

  // A inserts " YOU" at position 3 (between "Hey" and " there")
  ins(a, 3, " YOU");
  // B inserts "AND " at position 4 (between "Hey " and "there")
  ins(b, 4, "AND ");

  // Mutual sync (no cleanup yet)
  syncBoth(a, b);

  const beforeCleanup = body(a);
  console.log(`pre-cleanup A: ${JSON.stringify(beforeCleanup)}`);
  // Without cleanup: convergent but duplicates "Hey".

  // Run cleanup on both peers
  const updatesA = cleanup(a);
  const updatesB = cleanup(b);
  console.log(`cleanup updates: A=${updatesA}, B=${updatesB}`);

  const aBody = body(a);
  const bBody = body(b);
  console.log(`post-cleanup A: ${JSON.stringify(aBody)}`);
  console.log(`post-cleanup B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody) fail("diverged after cleanup", [["a", a], ["b", b]]);
  // Verify no duplicated "Hey"
  const heyCount = (aBody.match(/Hey/g) || []).length;
  if (heyCount > 1) fail(`'Hey' appears ${heyCount} times — cleanup failed`, [["a", a]]);
  if (!aBody.includes("YOU") || !aBody.includes("AND"))
    fail(`lost content: ${aBody}`, [["a", a]]);
  console.log("ok: concurrent split converged WITHOUT duplication");
}

// Symmetric sync (apply cleanup on either peer first → same result)
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "hello world");
  syncBoth(a, b);
  ins(a, 5, "_AAA_");
  ins(b, 5, "_BBB_");
  syncBoth(a, b);
  // Cleanup on A first, then B
  cleanup(a);
  cleanup(b);
  const aBody = body(a);
  const bBody = body(b);
  if (aBody !== bBody) fail(`sym1 diverged: A=${aBody} B=${bBody}`, [["a", a], ["b", b]]);
  console.log(`ok: symmetric concurrent insert+cleanup → ${JSON.stringify(aBody)}`);
}

console.log("\nPASS: cleanup pass tightened");
