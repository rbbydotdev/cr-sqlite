// Acceptance test for compound/TEXT primary-key support (hard fix #1).
//
// The engine accepts row_pk as INTEGER, TEXT, or BLOB. This test exercises
// the TEXT path end-to-end:
//   1. parent table has TEXT PK
//   2. fugue_insert / fugue_render / fugue_delete addressed by TEXT pk
//   3. multi-peer sync converges on a TEXT-PK doc
//
// Also smoke-checks that compound PKs are rejected with a clear error.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const open = () => {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  return db;
};

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// ── 1. TEXT primary key, single-peer round trip ──────────────────────────
{
  const db = open();
  db.exec(`CREATE TABLE users (
    handle TEXT PRIMARY KEY NOT NULL,
    bio TEXT
  )`);
  db.prepare(`SELECT crsql_as_crr('users')`).get();
  db.prepare(`SELECT crsql_as_text_crdt('users', 'bio')`).get();
  db.exec(`INSERT INTO users (handle, bio) VALUES ('alice', '')`);

  db.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get(
    "alice",
    0,
    "hello world",
  );
  let body = db.prepare(`SELECT bio FROM users WHERE handle='alice'`).pluck().get();
  if (body !== "hello world") fail(`TEXT PK insert: expected 'hello world', got ${JSON.stringify(body)}`);

  db.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get("alice", 5, ", brave");
  body = db.prepare(`SELECT bio FROM users WHERE handle='alice'`).pluck().get();
  if (body !== "hello, brave world")
    fail(`TEXT PK mid-insert: expected 'hello, brave world', got ${JSON.stringify(body)}`);

  db.prepare(`SELECT crsql_fugue_delete('users','bio',?,?,?)`).get("alice", 7, 12);
  body = db.prepare(`SELECT bio FROM users WHERE handle='alice'`).pluck().get();
  if (body !== "hello,  world")
    fail(`TEXT PK delete: expected 'hello,  world', got ${JSON.stringify(body)}`);

  const rendered = db.prepare(`SELECT crsql_fugue_render('users','bio',?)`).pluck().get("alice");
  if (rendered !== "hello,  world")
    fail(`TEXT PK render: expected 'hello,  world', got ${JSON.stringify(rendered)}`);

  console.log("ok: TEXT PK insert/delete/render");
}

// ── 2. Two TEXT-PK rows on the same parent must not collide ──────────────
{
  const db = open();
  db.exec(`CREATE TABLE users (
    handle TEXT PRIMARY KEY NOT NULL,
    bio TEXT
  )`);
  db.prepare(`SELECT crsql_as_crr('users')`).get();
  db.prepare(`SELECT crsql_as_text_crdt('users', 'bio')`).get();
  db.exec(`INSERT INTO users (handle, bio) VALUES ('alice', ''), ('bob', '')`);

  db.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get("alice", 0, "alice's bio");
  db.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get("bob", 0, "bob's bio");

  const aBody = db.prepare(`SELECT bio FROM users WHERE handle='alice'`).pluck().get();
  const bBody = db.prepare(`SELECT bio FROM users WHERE handle='bob'`).pluck().get();
  if (aBody !== "alice's bio") fail(`row isolation: alice=${JSON.stringify(aBody)}`);
  if (bBody !== "bob's bio") fail(`row isolation: bob=${JSON.stringify(bBody)}`);
  console.log("ok: two TEXT-PK rows stay isolated");
}

// ── 3. Two peers, TEXT PK, sync converges ────────────────────────────────
{
  const a = open();
  const b = open();
  for (const db of [a, b]) {
    db.exec(`CREATE TABLE users (handle TEXT PRIMARY KEY NOT NULL, bio TEXT)`);
    db.prepare(`SELECT crsql_as_crr('users')`).get();
    db.prepare(`SELECT crsql_as_text_crdt('users', 'bio')`).get();
    db.exec(`INSERT INTO users (handle, bio) VALUES ('alice', '')`);
  }
  const siteId = (db) => db.prepare(`SELECT crsql_site_id()`).pluck().get();
  const pull = (from, exclude) =>
    from
      .prepare(
        `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
         FROM crsql_changes WHERE site_id IS NOT ?`,
      )
      .all(exclude);
  const apply = (to, changes) => {
    if (!changes.length) return;
    const stmt = to.prepare(
      `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
       VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
    );
    to.transaction((rs) => rs.forEach((r) => stmt.run(r)))(changes);
  };
  const syncBoth = () => {
    apply(b, pull(a, siteId(b)));
    apply(a, pull(b, siteId(a)));
  };

  a.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get("alice", 0, "hi");
  syncBoth();
  // Concurrent inserts
  a.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get("alice", 2, " A");
  b.prepare(`SELECT crsql_fugue_insert('users','bio',?,?,?)`).get("alice", 2, " B");
  syncBoth();

  const aBody = a.prepare(`SELECT bio FROM users WHERE handle='alice'`).pluck().get();
  const bBody = b.prepare(`SELECT bio FROM users WHERE handle='alice'`).pluck().get();
  if (aBody !== bBody) fail(`peers diverged on TEXT PK: A=${JSON.stringify(aBody)} B=${JSON.stringify(bBody)}`);
  console.log(`ok: TEXT-PK sync converged → ${JSON.stringify(aBody)}`);
}

// ── 4. Compound PK → reject with clear error ─────────────────────────────
{
  const db = open();
  db.exec(`CREATE TABLE orders (
    year INTEGER NOT NULL,
    customer TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (year, customer)
  )`);
  db.prepare(`SELECT crsql_as_crr('orders')`).get();
  let threw = false;
  let msg = "";
  try {
    db.prepare(`SELECT crsql_as_text_crdt('orders', 'note')`).get();
  } catch (e) {
    threw = true;
    msg = e.message;
  }
  if (!threw) fail("compound PK should have errored at registration but didn't");
  if (!/compound primary key/i.test(msg))
    fail(`compound PK error should mention 'compound primary key', got: ${msg}`);
  console.log(`ok: compound PK rejected (${msg.slice(0, 80)}…)`);
}

console.log("\nPASS: TEXT/compound PK acceptance verified");
