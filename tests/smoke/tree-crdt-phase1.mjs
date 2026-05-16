// Phase 1 smoke: tree CRDT primitive — registration + local moves + cycle reject.
// Single-replica behavior only; multi-replica convergence is phase 2.

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

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
}

// ----- 0. registration: idempotent + creates the three tables ----------------
{
  const db = open();
  db.prepare("SELECT crsql_create_tree('t')").get();
  db.prepare("SELECT crsql_create_tree('t')").get(); // re-call is a no-op

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 't\\_\\_%' ESCAPE '\\' ORDER BY name"
    )
    .all()
    .map((r) => r.name);
  // includes t__tree_ops (+ its cr-sqlite clock), t__tree_log, t__tree_state
  if (!tables.includes("t__tree_ops")) fail(`missing t__tree_ops, got ${tables}`);
  if (!tables.includes("t__tree_log")) fail(`missing t__tree_log, got ${tables}`);
  if (!tables.includes("t__tree_state")) fail(`missing t__tree_state, got ${tables}`);
  console.log("ok: registration creates ops/log/state");

  // bad name
  try {
    db.prepare("SELECT crsql_create_tree('bad name')").get();
    fail("expected error for bad name");
  } catch (e) {
    if (!/letters, digits/.test(String(e.message)))
      fail(`unexpected name error: ${e.message}`);
  }
  console.log("ok: invalid name rejected");
  db.close();
}

// ----- 1. single move creates a node, updates state --------------------------
{
  const db = open();
  db.prepare("SELECT crsql_create_tree('t')").get();
  const actor = Buffer.from("alice");

  // Move(child=10, parent=NULL, meta='root'), ts=1
  db.prepare("SELECT crsql_tree_move('t', ?, NULL, ?, 1, ?)").run(
    10,
    Buffer.from("root"),
    actor
  );
  const state = db
    .prepare("SELECT node_id, parent_id, meta FROM t__tree_state")
    .all();
  eq(state.length, 1, "state row count");
  eq(state[0].node_id, 10, "node_id");
  eq(state[0].parent_id, null, "parent_id");
  eq(Buffer.from(state[0].meta).toString(), "root", "meta");

  // Move(child=20, parent=10, meta='child'), ts=2
  db.prepare("SELECT crsql_tree_move('t', ?, ?, ?, 2, ?)").run(
    20,
    10,
    Buffer.from("child"),
    actor
  );
  const all = db
    .prepare("SELECT node_id, parent_id FROM t__tree_state ORDER BY node_id")
    .all();
  eq(all, [{ node_id: 10, parent_id: null }, { node_id: 20, parent_id: 10 }], "two-node state");
  console.log("ok: local moves materialize state");

  // Log table populated with snapshots
  const log = db
    .prepare("SELECT lamport_ts, old_existed FROM t__tree_log ORDER BY lamport_ts")
    .all();
  eq(log, [{ lamport_ts: 1, old_existed: 0 }, { lamport_ts: 2, old_existed: 0 }], "log snapshots");
  console.log("ok: log entries recorded");

  db.close();
}

// ----- 2. self-parent rejected silently --------------------------------------
{
  const db = open();
  db.prepare("SELECT crsql_create_tree('t')").get();
  const actor = Buffer.from("alice");

  db.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run(10, actor);
  // Move(child=10, parent=10) — self-loop. State should remain at parent=NULL.
  db.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 2, ?)").run(10, 10, actor);
  const row = db.prepare("SELECT parent_id FROM t__tree_state WHERE node_id=10").get();
  eq(row.parent_id, null, "self-parent left state unchanged");
  console.log("ok: self-parent rejected");

  db.close();
}

// ----- 3. cycle prevention: A→B then B→A is rejected -------------------------
{
  const db = open();
  db.prepare("SELECT crsql_create_tree('t')").get();
  const actor = Buffer.from("alice");

  // create A and B at root
  db.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run(100, actor);
  db.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 2, ?)").run(200, actor);
  // move A under B
  db.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 3, ?)").run(100, 200, actor);
  // attempt: move B under A → would form a cycle A→B→A
  db.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 4, ?)").run(200, 100, actor);
  const rows = db
    .prepare("SELECT node_id, parent_id FROM t__tree_state ORDER BY node_id")
    .all();
  eq(
    rows,
    [
      { node_id: 100, parent_id: 200 },
      { node_id: 200, parent_id: null },
    ],
    "B stays at root, cycle move ignored"
  );
  console.log("ok: cycle rejected at apply");

  db.close();
}

// ----- 4. out-of-order apply: late op interleaves correctly ------------------
// Here we insert ops with non-monotonic timestamps to exercise undo/redo.
// Sequence (in arrival order): ts=3 (move A under B), ts=2 (create A at root), ts=1 (create B at root).
// Final state must match an in-order replay: B at root, A under B.
{
  const db = open();
  db.prepare("SELECT crsql_create_tree('t')").get();
  const actor = Buffer.from("alice");

  db.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 3, ?)").run(100, 200, actor);
  db.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 2, ?)").run(100, actor);
  db.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run(200, actor);

  const rows = db
    .prepare("SELECT node_id, parent_id FROM t__tree_state ORDER BY node_id")
    .all();
  eq(
    rows,
    [
      { node_id: 100, parent_id: 200 },
      { node_id: 200, parent_id: null },
    ],
    "out-of-order ops produce in-order state"
  );
  console.log("ok: undo/redo across out-of-order apply");

  db.close();
}

console.log("\nphase1: ok");
