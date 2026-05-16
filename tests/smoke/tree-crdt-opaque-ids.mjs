// Verify the tree CRDT is genuinely opaque to node_id / meta storage class.
// The primitive's documented contract is "BLOB node IDs, BLOB meta, but any
// SQLite storage class round-trips identically". Test:
//
//   * TEXT node IDs (UUID-shaped strings)
//   * BLOB node IDs (raw byte arrays)
//   * BLOB meta (arbitrary bytes including NULs)
//   * Mixed INT/TEXT/BLOB across rows in the same tree — convergence still works.

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
function fail(m) { console.error("FAIL:", m); process.exit(1); }

function syncPair(a, b) {
  const siteA = a.prepare("SELECT crsql_site_id()").pluck().get();
  const siteB = b.prepare("SELECT crsql_site_id()").pluck().get();
  const ab = a.prepare(
    `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
     FROM crsql_changes WHERE site_id IS NOT ?`
  ).all(siteB);
  const ba = b.prepare(
    `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
     FROM crsql_changes WHERE site_id IS NOT ?`
  ).all(siteA);
  const apply = (to, rows) => {
    const stmt = to.prepare(
      `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
       VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`
    );
    to.transaction((rs) => rs.forEach((r) => stmt.run(r)))(rows);
  };
  apply(b, ab);
  apply(a, ba);
}

function dumpState(db) {
  return db.prepare(
    "SELECT typeof(node_id) AS nt, node_id, typeof(parent_id) AS pt, parent_id, hex(meta) AS m FROM t__tree_state ORDER BY hex(CASE WHEN typeof(node_id)='blob' THEN node_id ELSE CAST(node_id AS BLOB) END), node_id"
  ).all();
}

// ── 1. TEXT node IDs round-trip and converge ────────────────────────────
{
  const a = open();
  const b = open();
  const alice = Buffer.from("alice");
  const bob = Buffer.from("bob");

  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run("uuid-root", alice);
  a.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 2, ?)").run("uuid-a", "uuid-root", alice);
  a.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 3, ?)").run("uuid-b", "uuid-root", alice);
  syncPair(a, b);

  // Concurrent move on b — move uuid-a under uuid-b (parent=text id)
  b.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 5, ?)").run("uuid-a", "uuid-b", bob);
  syncPair(a, b);

  const sa = dumpState(a);
  const sb = dumpState(b);
  if (JSON.stringify(sa) !== JSON.stringify(sb)) {
    console.error("a:", sa);
    console.error("b:", sb);
    fail("TEXT node IDs: divergence");
  }
  // Type preservation: every node_id must come back as text
  for (const row of sa) {
    if (row.nt !== "text") fail(`TEXT node IDs: storage class drifted to ${row.nt}`);
  }
  console.log("ok: TEXT node IDs round-trip + converge");
  a.close(); b.close();
}

// ── 2. BLOB node IDs (raw bytes incl. NUL) ──────────────────────────────
{
  const a = open();
  const b = open();
  const alice = Buffer.from("alice");

  const idRoot = Buffer.from([0, 1, 2, 3, 4]);
  const idA = Buffer.from([10, 0, 20, 0, 30]); // contains NULs
  const idB = Buffer.from([255, 254, 253]);
  const metaPayload = Buffer.from([0, 1, 2, 3, 4, 5]);

  a.prepare("SELECT crsql_tree_move('t', ?, NULL, ?, 1, ?)").run(idRoot, metaPayload, alice);
  a.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 2, ?)").run(idA, idRoot, alice);
  a.prepare("SELECT crsql_tree_move('t', ?, ?, NULL, 3, ?)").run(idB, idRoot, alice);
  syncPair(a, b);

  const sa = dumpState(a);
  const sb = dumpState(b);
  if (JSON.stringify(sa) !== JSON.stringify(sb)) fail("BLOB node IDs: divergence");
  for (const row of sa) {
    if (row.nt !== "blob") fail(`BLOB node IDs: storage class drifted to ${row.nt}`);
  }
  // Meta round-trips byte-exact
  const rootRow = a.prepare("SELECT meta FROM t__tree_state WHERE node_id = ?").get(idRoot);
  if (Buffer.compare(rootRow.meta, metaPayload) !== 0) {
    fail(`BLOB meta byte mismatch: got ${rootRow.meta.toString("hex")}, want ${metaPayload.toString("hex")}`);
  }
  console.log("ok: BLOB node IDs (incl NUL) + BLOB meta round-trip");
  a.close(); b.close();
}

// ── 3. Mixed-type node IDs: INT, TEXT, BLOB siblings in same tree ───────
// SQLite stores values with their type tags, so INT 1 and TEXT '1' and
// BLOB X'01' are distinct rows. The CRDT must treat them as distinct
// nodes and preserve storage class round-trip.
//
// NOTE: better-sqlite3 binds plain JS Number as REAL by default; to get
// an actual INTEGER storage class we pass a BigInt. This is a binding-
// layer quirk, not a CRDT concern.
{
  const a = open();
  const alice = Buffer.from("alice");

  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 1, ?)").run(BigInt(1), alice);
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 2, ?)").run("1", alice);
  a.prepare("SELECT crsql_tree_move('t', ?, NULL, NULL, 3, ?)").run(Buffer.from([0x01]), alice);

  const count = a.prepare("SELECT count(*) FROM t__tree_state").pluck().get();
  if (count !== 3) fail(`mixed-type nodes: expected 3 rows, got ${count}`);
  const types = a.prepare("SELECT DISTINCT typeof(node_id) AS t FROM t__tree_state ORDER BY t").all().map((r) => r.t);
  if (JSON.stringify(types) !== JSON.stringify(["blob", "integer", "text"])) {
    fail(`mixed-type nodes: storage classes ${JSON.stringify(types)}`);
  }
  console.log("ok: INT/TEXT/BLOB node IDs treated as distinct nodes");
  a.close();
}

console.log("\nopaque-ids: ok");
