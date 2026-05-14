// Probe 99 — large-document stress. Soft-fails (warns) rather than hard-fails;
// the goal is to surface scaling characteristics, not to gate CI on absolute
// numbers. Run with `node tests/smoke/probe_99_large_document.mjs`.
//
// Scenarios:
//   1. 1M-char paste (single fugue_insert call → 1 row)
//   2. 10K sequential keystrokes (10K single-char inserts at end → 10K rows)
//   3. 100K sequential keystrokes (100K rows)
//   4. 1000 random-position inserts after seeding with 10K chars
//   5. 100 partial deletes spread through a 10K-char document — exercises
//      the marker-aware visible-chars walker at scale
//   6. Render trigger scaling — body materialization cost as N grows
//   7. Sync payload size — A creates a 10K-char document, sync to fresh B
//
// Look for: per-op latency that doesn't grow unbounded, render time roughly
// O(N) in visible chars, marker walk not catastrophic, sync time reasonable.

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
const ins = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);
const del = (db, from, to) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(from, to);
const body = (db) => db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const bodyCol = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
const rowCount = (db) =>
  db.prepare("SELECT count(*) FROM __crsql_fugue_notes_body WHERE row_pk = 1").pluck().get();

function pull(from, exclude) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
    )
    .all(exclude);
}
function applyInTx(to, changes) {
  if (!changes.length) return 0;
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
  return changes.length;
}

const time = async (label, fn) => {
  const t0 = performance.now();
  const r = await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label}: ${dt.toFixed(1)}ms`);
  return { dt, r };
};

const mem = () => {
  const m = process.memoryUsage();
  return `heap=${(m.heapUsed / 1024 / 1024).toFixed(1)}MB rss=${(m.rss / 1024 / 1024).toFixed(1)}MB`;
};

// ── 1. 1M-char paste ──
{
  console.log("");
  console.log("--- 1. 1M-char paste (single fugue_insert → 1 row) ---");
  const db = open();
  const text = "x".repeat(1_000_000);
  await time("insert 1M chars", () => ins(db, 0, text));
  const rows = rowCount(db);
  console.log(`  rows in backing: ${rows}`);
  await time("render() 1M chars", () => body(db));
  await time("SELECT body materialized", () => bodyCol(db));
  console.log(`  ${mem()}`);
}

// ── 2. 10K sequential keystrokes ──
{
  console.log("");
  console.log("--- 2. 10K sequential keystrokes (10K single-char inserts at end) ---");
  const db = open();
  await time("10K keystrokes", () => {
    for (let i = 0; i < 10_000; i++) ins(db, i, "x");
  });
  console.log(`  rows in backing: ${rowCount(db)}`);
  await time("render() 10K chars", () => body(db));
  console.log(`  ${mem()}`);
}

// ── 3. 100K sequential keystrokes ──
{
  console.log("");
  console.log("--- 3. 100K sequential keystrokes (100K single-char inserts at end) ---");
  const db = open();
  await time("100K keystrokes", () => {
    for (let i = 0; i < 100_000; i++) ins(db, i, "x");
  });
  console.log(`  rows in backing: ${rowCount(db)}`);
  await time("render() 100K chars", () => body(db));
  console.log(`  ${mem()}`);
}

// ── 4. Random-position inserts after seeding 10K-char doc ──
{
  console.log("");
  console.log("--- 4. 1000 random-position inserts after 10K seed ---");
  const db = open();
  ins(db, 0, "x".repeat(10_000));
  console.log(`  seed rows: ${rowCount(db)}`);
  await time("1000 random inserts", () => {
    for (let i = 0; i < 1000; i++) {
      const len = body(db).length;
      const pos = Math.floor(Math.random() * (len + 1));
      ins(db, pos, "y");
    }
  });
  console.log(`  final rows: ${rowCount(db)}`);
  console.log(`  ${mem()}`);
}

// ── 5. Partial-delete stress — exercises marker-aware walk ──
{
  console.log("");
  console.log("--- 5. 100 partial deletes through a 10K-char doc ---");
  const db = open();
  ins(db, 0, "x".repeat(10_000));
  await time("100 random partial deletes", () => {
    for (let i = 0; i < 100; i++) {
      const len = body(db).length;
      if (len < 10) break;
      const from = Math.floor(Math.random() * (len - 5));
      const to = from + 1 + Math.floor(Math.random() * 4); // 1-4 chars
      del(db, from, to);
    }
  });
  console.log(`  final rows (incl markers): ${rowCount(db)}`);
  const finalBody = body(db);
  console.log(`  body length after deletes: ${finalBody.length}`);
  await time("render() after 100 markers", () => body(db));
  console.log(`  ${mem()}`);
}

// ── 6. Render scaling — measure render time at 1K, 10K, 50K, 100K chars ──
{
  console.log("");
  console.log("--- 6. Render scaling curve ---");
  for (const N of [1_000, 10_000, 50_000, 100_000]) {
    const db = open();
    ins(db, 0, "x".repeat(N));
    const t0 = performance.now();
    const r = body(db);
    const dt = performance.now() - t0;
    console.log(`  N=${N.toString().padStart(7)}  render: ${dt.toFixed(1)}ms (rows=${rowCount(db)}, len=${r.length})`);
  }
}

// ── 7. Sync payload — A creates a 10K-char doc, sync to fresh B ──
{
  console.log("");
  console.log("--- 7. Sync payload: 10K-char doc, A → fresh B ---");
  const a = open();
  const b = open();
  ins(a, 0, "x".repeat(10_000));
  console.log(`  A rows: ${rowCount(a)}`);
  const changes = pull(a, siteId(b));
  const payloadBytes = changes.reduce((sum, c) => {
    return sum + 64 + (typeof c.val === "string" ? c.val.length : 8);
  }, 0);
  console.log(`  changes to ship: ${changes.length} cells (~${(payloadBytes / 1024).toFixed(1)} KB)`);
  await time("applyInTx 10K-char single-row sync", () => applyInTx(b, changes));
  console.log(`  B rows: ${rowCount(b)}`);
  console.log(`  B body length: ${bodyCol(b).length}`);
  if (bodyCol(a) !== bodyCol(b)) {
    console.error("  FAIL: A and B disagree after sync");
    process.exit(1);
  }
  console.log("  ok: peers converged");
}

console.log("");
console.log("PASS: large-document stress completed");
