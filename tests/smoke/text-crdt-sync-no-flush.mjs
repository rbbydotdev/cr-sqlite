// Verifies the transparent-mode contract: clients NEVER need to call crsql_fugue_flush.
// Reading SELECT body directly after sync-apply gives fresh data, with zero client work.

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
const siteId = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
// IMPORTANT: this test reads via SELECT body (the materialized column) — NOT
// crsql_fugue_render — to prove the materialized column is current after sync.
const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
const ins = (db, p, t) => db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(p, t);
const del = (db, f, t) => db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(f, t);

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
// Note: NO cleanup() call here — we want to verify auto-render works even without
// any client-side post-sync hook. Cleanup is its own pass for concurrent-split correctness.

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// Scenario 1: peer A writes, syncs to B. B reads via SELECT body (NOT render).
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);

  ins(a, 0, "hello world");
  if (body(a) !== "hello world") fail(`A local: ${JSON.stringify(body(a))}`);

  // Sync A → B. No client-side flush, cleanup, or anything.
  apply(b, pull(a, siteId(b)));

  // B reads materialized column directly. Must be fresh.
  if (body(b) !== "hello world")
    fail(
      `B materialized stale after sync (transparent contract broken): ${JSON.stringify(body(b))}`,
    );
  console.log("ok: SELECT body fresh on B after sync-apply, no flush call");
}

// Scenario 2: bidirectional sync, both peers' SELECT body fresh.
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "shared");
  apply(b, pull(a, siteId(b)));

  ins(a, 6, " from-A");
  ins(b, 0, "PRE: ");

  // bidirectional sync; client does ZERO extra work
  apply(b, pull(a, siteId(b)));
  apply(a, pull(b, siteId(a)));

  const bodyA = body(a);
  const bodyB = body(b);
  if (bodyA !== bodyB) fail(`diverged: A=${JSON.stringify(bodyA)} B=${JSON.stringify(bodyB)}`);
  if (!bodyA.includes("shared") || !bodyA.includes(" from-A") || !bodyA.includes("PRE: "))
    fail(`lost content: ${JSON.stringify(bodyA)}`);
  console.log("ok: bidirectional sync — SELECT body fresh on both peers");
}

// Scenario 3: delete on A, sync to B, SELECT body reflects deletion.
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "delete me");
  apply(b, pull(a, siteId(b)));
  if (body(b) !== "delete me") fail(`B init: ${JSON.stringify(body(b))}`);

  del(a, 0, 9);
  apply(b, pull(a, siteId(b)));
  if (body(b) !== "")
    fail(`B materialized after sync-applied delete: ${JSON.stringify(body(b))} (should be '')`);
  console.log("ok: delete sync — SELECT body reflects deletion on B without flush");
}

console.log("\nPASS: transparent mode — SELECT body is fresh after sync with no client work");
