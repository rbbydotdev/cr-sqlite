// Regression test for the #!~ "tighten itemId to {site}.{counter}" marker
// (insertion.rs:605).
//
// The marker proposed making itemIds monotonic per site instead of using a
// random 6-byte suffix, for "ordering stability". The current
// fresh_item_id is `{site_hex}_{lower(hex(randomblob(6)))}` — random
// suffix. Same-site siblings at the same parent_idx tiebreak by
// lexicographic string compare on itemId.
//
// This test pins down that:
//   * Same-site, same-parent_idx siblings (created by type → delete →
//     re-type) render deterministically.
//   * Render is bit-stable across repeated reads — the random suffix
//     doesn't introduce non-determinism within a session.
//   * Two peers exchanging the same workload converge to the same
//     rendered body and the same backing-row sort order.
//
// If we ever swap to monotonic itemIds, all three properties must
// continue to hold. The first two are correctness; the third (canonical
// backing-row order across peers) is what monotonic IDs would buy us
// over random ones — and the test asserts the current random scheme
// already gives it.

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
const rows = (db) =>
  db
    .prepare(
      "SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned \
       FROM __crsql_fugue_notes_body WHERE row_pk = 1 \
       ORDER BY parentItemId, parentIdx, itemId, idx",
    )
    .all();
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

// ── 1. Render is bit-stable across repeated reads ────────────────────────
{
  const db = open();
  setup(db);
  ins(db, 0, "hello world");
  for (let i = 0; i < 5; i++) {
    del(db, 5, 6);
    ins(db, 5, "_");
  }
  // The body should be stable across consecutive renders — random itemIds
  // aren't re-generated on read.
  const first = body(db);
  for (let i = 0; i < 5; i++) {
    if (body(db) !== first) fail(`render not stable across reads: ${first} vs ${body(db)}`);
  }
  console.log(`ok: render bit-stable across 5 reads → ${JSON.stringify(first)}`);
}

// ── 2. Same-site siblings at same parent_idx render deterministically ────
// Create N same-site inserts that all share a parent_idx (via repeated
// "type at pos 0 then delete" cycle). Verify the visible output is the
// LAST insert (others tombstoned) regardless of itemId tiebreak.
{
  const db = open();
  setup(db);
  for (let i = 0; i < 10; i++) {
    ins(db, 0, String.fromCharCode(65 + i)); // A, B, C...
    del(db, 0, 1);
  }
  ins(db, 0, "Z");
  const got = body(db);
  if (got !== "Z") fail(`expected 'Z' after 10 type-delete cycles + 'Z', got ${JSON.stringify(got)}`);
  console.log(`ok: 10 type/delete cycles + final 'Z' renders → ${JSON.stringify(got)}`);
}

// ── 3. Two peers, parallel same-position workloads converge ───────────────
// Both peers start from the same seed state, then do parallel
// (non-concurrent across the wire) edits to the same regions. Sync after
// each pair of edits. Random itemIds must still produce a deterministic
// merged state — both peers see bit-identical backing-row ordering.
{
  const a = open();
  const b = open();
  setup(a); setup(b);
  ins(a, 0, "Hello world");
  syncBoth(a, b);

  // Series of partial overlap edits.
  ins(a, 5, " brave");      // A: "Hello brave world"
  ins(b, 6, "lovely ");      // B: "Hello lovely world"
  syncBoth(a, b);

  ins(a, 0, "Greetings, ");
  ins(b, 0, "Sup, ");
  syncBoth(a, b);

  del(a, 0, 4);
  del(b, 4, 8);
  syncBoth(a, b);

  const aBody = body(a);
  const bBody = body(b);
  if (aBody !== bBody) fail(`bodies diverged: A=${aBody} B=${bBody}`);

  // Stronger check: the backing-row ordering should be bit-identical too.
  // This is the property monotonic itemIds would have explicitly given us —
  // random itemIds already provide it because both peers see the same
  // (itemId, idx) pairs for the same logical chars.
  const aRows = JSON.stringify(rows(a));
  const bRows = JSON.stringify(rows(b));
  if (aRows !== bRows) fail(`backing-row order diverged across peers`);
  console.log(`ok: peers converged on bit-identical state → ${JSON.stringify(aBody)}`);
}

// ── 4. Three peers, mixed-author insertion at same EOD ───────────────────
// Three peers concurrently type one char at EOD. Tie-break by itemId
// (= site_hex prefix lexicographic, since random suffixes start with the
// site_hex). All peers must agree on the final order.
{
  const peers = [open(), open(), open()];
  for (const p of peers) setup(p);
  ins(peers[0], 0, "x");
  // Sync seed to all
  for (let i = 1; i < peers.length; i++) {
    apply(peers[i], pull(peers[0], site(peers[i])));
  }

  ins(peers[0], 1, "A");
  ins(peers[1], 1, "B");
  ins(peers[2], 1, "C");

  // N×N sync until stable
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (let i = 0; i < peers.length; i++) {
      for (let j = 0; j < peers.length; j++) {
        if (i === j) continue;
        const before = body(peers[j]);
        apply(peers[j], pull(peers[i], site(peers[j])));
        if (body(peers[j]) !== before) changed = true;
      }
    }
    if (!changed) break;
  }
  const out = peers.map(body);
  if (new Set(out).size !== 1) fail(`3-peer EOD diverged: ${out.join(" | ")}`);
  if (out[0].length !== 4 || !out[0].startsWith("x")) fail(`unexpected shape: ${out[0]}`);
  for (const c of "ABC") {
    if (!out[0].includes(c)) fail(`lost char ${c}: ${out[0]}`);
  }
  console.log(`ok: 3-peer concurrent EOD → ${JSON.stringify(out[0])}`);
}

console.log("\nPASS: sibling-ordering with random itemIds converges deterministically");
