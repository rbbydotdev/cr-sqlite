// Regression test for the #!~ "end-of-doc append with tombstone children"
// case (insertion.rs:375).
//
// The case: left neighbor has 1+ children, but ALL of them are invisible
// (tombstoned or empty sentinels), AND we're inserting at end-of-doc
// (right neighbor is None). The current code falls back to Case-2 — the
// new node becomes a child of left, sharing parent_idx with the
// tombstones. The marker asked whether a different placement
// (deepest-rightmost-visible) would be "more stable".
//
// What this test pins down: the current placement is correct and
// converges across peers under the concrete patterns that produce the
// case. If we ever change the placement and it breaks one of these
// scenarios, the test catches it.

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
const setup = (db) => {
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
};
const site = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
const body = (db) =>
  db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const ins = (db, p, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(p, t);
const del = (db, f, t) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(f, t);
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
const syncBoth = (a, b) => {
  apply(b, pull(a, site(b)));
  apply(a, pull(b, site(a)));
};

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

// ── 1. Local: type → delete tail → re-type at end-of-doc ─────────────────
// This is the simplest path that produces "left has tombstone children at EOD".
{
  const db = open();
  setup(db);
  ins(db, 0, "ab");
  ins(db, 2, "c"); // "abc"
  del(db, 2, 3);    // tombstone 'c' → visible "ab"
  ins(db, 2, "X");  // insert at end-of-doc, left='b' has tombstone child 'c'
  const got = body(db);
  if (got !== "abX") fail(`local re-type at EOD: expected 'abX', got ${JSON.stringify(got)}`);
  console.log(`ok: local re-type at EOD → ${JSON.stringify(got)}`);
}

// ── 2. Two peers, concurrent insert-then-delete vs append ────────────────
// A: types 'c' at end + deletes it → tombstone-with-empty-row
// B: concurrently types 'X' at end of pre-sync state
// After sync both peers should agree on the body — the order of the EOD
// insertions is determined by Fugue tiebreak, but render must agree.
{
  const a = open();
  const b = open();
  setup(a); setup(b);
  ins(a, 0, "ab");
  syncBoth(a, b);

  ins(a, 2, "c");
  del(a, 2, 3);    // A's local view: "ab" with tombstoned 'c' child of 'b'
  ins(b, 2, "X"); // B's local view: "abX" (no 'c' yet)
  syncBoth(a, b);

  const aBody = body(a);
  const bBody = body(b);
  if (aBody !== bBody)
    fail(`concurrent EOD diverged: A=${JSON.stringify(aBody)} B=${JSON.stringify(bBody)}`);
  // 'X' is alive on both. 'c' is tombstoned on both. Only "X" should survive
  // past the "ab" prefix. Possible orderings:
  //   "ab" + 'X' (sibling of tombstoned 'c', X wins itemId tiebreak)
  //   or just "abX" because 'c' renders empty.
  if (aBody !== "abX") fail(`expected 'abX', got ${JSON.stringify(aBody)}`);
  console.log(`ok: concurrent insert+delete vs EOD append → ${JSON.stringify(aBody)}`);
}

// ── 3. Two peers, concurrent EOD inserts on same parent ──────────────────
// A: types 'X' at end
// B: types 'Y' at end (concurrently — neither has seen the other's edit)
// After sync, both peers must agree (Fugue tiebreaks by itemId).
{
  const a = open();
  const b = open();
  setup(a); setup(b);
  ins(a, 0, "ab");
  syncBoth(a, b);

  ins(a, 2, "X");
  ins(b, 2, "Y");
  syncBoth(a, b);

  const aBody = body(a);
  const bBody = body(b);
  if (aBody !== bBody) fail(`concurrent EOD inserts diverged: A=${aBody} B=${bBody}`);
  if (!aBody.includes("X") || !aBody.includes("Y")) fail(`lost a char: ${aBody}`);
  if (!aBody.startsWith("ab")) fail(`prefix mangled: ${aBody}`);
  console.log(`ok: concurrent EOD inserts → ${JSON.stringify(aBody)}`);
}

// ── 4. Three-way merge: A deletes tail, B+C type at end ──────────────────
// Stresses the case with more contenders for the same parent_idx slot.
{
  const a = open();
  const b = open();
  const c = open();
  setup(a); setup(b); setup(c);
  ins(a, 0, "abc");
  // Hand sync to b and c.
  apply(b, pull(a, site(b)));
  apply(c, pull(a, site(c)));

  del(a, 2, 3);    // A: "ab" + tombstoned 'c'
  ins(b, 3, "X"); // B (still has 'c'): "abcX"
  ins(c, 3, "Y"); // C: "abcY"

  // Full N×N sync until stable
  const peers = [a, b, c];
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (let i = 0; i < peers.length; i++) {
      for (let j = 0; j < peers.length; j++) {
        if (i === j) continue;
        const before = body(peers[j]);
        const changes = pull(peers[i], site(peers[j]));
        apply(peers[j], changes);
        if (body(peers[j]) !== before) changed = true;
      }
    }
    if (!changed) break;
  }

  const ab = body(a);
  const bb = body(b);
  const cb = body(c);
  if (ab !== bb || bb !== cb)
    fail(`3-way diverged: A=${ab} B=${bb} C=${cb}`);
  // 'c' is tombstoned. 'X' and 'Y' both alive. Result is "ab" + {XY,YX in itemId order}.
  if (!ab.startsWith("ab")) fail(`prefix wrong: ${ab}`);
  if (!ab.includes("X") || !ab.includes("Y")) fail(`lost char: ${ab}`);
  if (ab.includes("c")) fail(`'c' should be hidden by tombstone: ${ab}`);
  console.log(`ok: 3-way EOD merge with tombstone → ${JSON.stringify(ab)}`);
}

console.log("\nPASS: EOD tombstone-children edge case converges");
