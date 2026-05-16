// Phase 2 smoke: tree CRDT primitive — two-node convergence on the paper's
// canonical concurrent-move scenarios (Kleppmann 2022 §2, Figs. 1 & 2).
//
// The transport is plain cr-sqlite change-exchange — same shape as
// sync-two-nodes.mjs. Each peer issues a Move, then they exchange
// {tree_ops} rows via crsql_changes. The AFTER INSERT trigger on
// {name}__tree_ops drives apply on each side. After exchange, both
// __tree_state tables must match exactly.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.prepare("SELECT crsql_create_tree('t')").get();
  return db;
}

function siteId(db) {
  return db.prepare("SELECT quote(crsql_site_id())").pluck().get();
}

function pullSince(db, since, excludeSite) {
  return db
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes
       WHERE db_version > ?
         AND site_id IS NOT ?`
    )
    .all(since, excludeSite);
}

function applyChanges(db, changes) {
  const stmt = db.prepare(
    `INSERT INTO crsql_changes
       ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
       VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`
  );
  const tx = db.transaction((rows) => rows.forEach((r) => stmt.run(r)));
  tx(changes);
}

function dumpState(db) {
  return db
    .prepare(
      "SELECT node_id, parent_id, meta FROM t__tree_state ORDER BY node_id"
    )
    .all()
    .map((r) => ({
      node_id: r.node_id,
      parent_id: r.parent_id,
      meta: r.meta == null ? null : Buffer.from(r.meta).toString(),
    }));
}

function sync(a, b) {
  const aToB = pullSince(a, 0, siteId(b).replace(/^X'/, "x'"));
  const bToA = pullSince(b, 0, siteId(a).replace(/^X'/, "x'"));
  applyChanges(b, aToB);
  applyChanges(a, bToA);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL ${label}:`);
    console.error("  expected:", e);
    console.error("  actual:  ", a);
    process.exit(1);
  }
}

// ----- Fig. 1: concurrent move-same-node to different parents -----
// Init: A, B, C all at root.
// Concurrently: peer1 moves A under B (ts=10 alice), peer2 moves A under C (ts=11 bob).
// Greater timestamp wins → both peers must agree A is under C.
{
  const a = open();
  const b = open();
  const alice = Buffer.from("alice");
  const bob = Buffer.from("bob");

  // shared init: create A, B, C at root on `a`, then sync to `b`
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, ?, 1, ?)").run(
    1,
    Buffer.from("A"),
    alice
  );
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, ?, 2, ?)").run(
    2,
    Buffer.from("B"),
    alice
  );
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, ?, 3, ?)").run(
    3,
    Buffer.from("C"),
    alice
  );
  sync(a, b);

  // Concurrent moves
  a.prepare("SELECT crsql_tree_move('t', ?, ?, ?, 10, ?)").run(
    1,
    2,
    Buffer.from("A"),
    alice
  ); // A under B
  b.prepare("SELECT crsql_tree_move('t', ?, ?, ?, 11, ?)").run(
    1,
    3,
    Buffer.from("A"),
    bob
  ); // A under C
  sync(a, b);

  const sa = dumpState(a);
  const sb = dumpState(b);
  eq(sa, sb, "fig1 convergence");
  // Greater (ts, actor) wins → A under C (ts=11)
  const aRow = sa.find((r) => r.node_id === 1);
  if (aRow.parent_id !== 3) {
    console.error("FAIL fig1: A should be under C (3), got parent", aRow.parent_id);
    process.exit(1);
  }
  console.log("ok: fig1 concurrent move-same-node converges to greater-ts winner");
  a.close();
  b.close();
}

// ----- Fig. 2: concurrent would-form-cycle -----
// Init: A and B siblings at root.
// Concurrently: peer1 moves A under B (ts=10 alice), peer2 moves B under A (ts=11 bob).
// Higher-ts op (B under A) replays second — at that point A is already under B,
// so moving B under A would create A→B→A. do_op detects cycle, ignores. Final:
// A is under B (the lower-ts op stands).
{
  const a = open();
  const b = open();
  const alice = Buffer.from("alice");
  const bob = Buffer.from("bob");

  // init: A, B at root
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run(1, alice);
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 2, ?)").run(2, alice);
  sync(a, b);

  // Concurrent cycle-forming moves
  a.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 10, ?)").run(1, 2, alice); // A under B
  b.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 11, ?)").run(2, 1, bob); // B under A
  sync(a, b);

  const sa = dumpState(a);
  const sb = dumpState(b);
  eq(sa, sb, "fig2 convergence");
  // Lower-ts op (A under B) wins because the higher-ts op (B under A) would
  // create a cycle when replayed against the state already containing A→B.
  const aRow = sa.find((r) => r.node_id === 1);
  const bRow = sa.find((r) => r.node_id === 2);
  if (!(aRow.parent_id === 2 && bRow.parent_id === null)) {
    console.error("FAIL fig2: expected A under B and B at root");
    console.error("  got:", sa);
    process.exit(1);
  }
  console.log("ok: fig2 cycle-forming concurrent moves: lower-ts op wins, higher-ts ignored");
  a.close();
  b.close();
}

// ----- Three-peer convergence: same final state regardless of arrival order -----
{
  const a = open();
  const b = open();
  const c = open();
  const A = Buffer.from("a");
  const B = Buffer.from("b");
  const C = Buffer.from("c");

  // a creates X, Y, Z all at root
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run(10, A);
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 2, ?)").run(20, A);
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 3, ?)").run(30, A);
  sync(a, b);
  sync(a, c);

  // b moves 10 under 20; c moves 20 under 30; a moves 30 under 10 (cycle).
  b.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 10, ?)").run(10, 20, B);
  c.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 11, ?)").run(20, 30, C);
  a.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 12, ?)").run(30, 10, A);

  // Sync all pairs until quiescent
  sync(a, b);
  sync(b, c);
  sync(a, c);
  sync(a, b); // second round to flush echoes

  const sa = dumpState(a);
  const sb = dumpState(b);
  const sc = dumpState(c);
  eq(sa, sb, "3-peer a==b");
  eq(sb, sc, "3-peer b==c");
  console.log("ok: 3-peer convergence");
  console.log("    final state:", sa);
  a.close();
  b.close();
  c.close();
}

console.log("\nphase2: ok");
