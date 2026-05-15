// Tombstone-wins race: peer A whole-deletes a row while peer B concurrently
// triggers a content change on the SAME row (e.g., partial delete that updates
// the row's content as the R portion). With the `tombstoned` boolean column,
// the two cells are independent in cr-sqlite's per-column LWW:
//   - tombstoned: A's 0→1 transition has higher col_version (1 > 0 under ValueWin)
//   - content: B's update applies on its own cell
// Final state on both peers: tombstoned=1 wins → row not rendered.
//
// Pre-tombstoned-column, this race could "resurrect" deleted content because
// content=NULL would lose to content="goodbye" under LWW ValueWin.

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
const del = (db, f, t) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(f, t);
const rows = (db) =>
  db
    .prepare(
      "SELECT itemId, idx, content, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk = 1 ORDER BY itemId, idx",
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

// Scenario 1: whole-delete vs whole-delete (sanity — both should converge to tombstoned)
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "hello world");
  syncBoth(a, b);

  del(a, 0, 11);
  del(b, 0, 11);
  syncBoth(a, b);
  if (body(a) !== "" || body(b) !== "") fail("scenario 1: both delete should converge to empty", [["a", a], ["b", b]]);
  console.log("ok: concurrent whole-delete on same row converges to empty");
}

// Scenario 2: whole-delete vs mid-run insert on the same row.
//
// A whole-deletes the row (tombstoned=1).
// B mid-run inserts "X" at position 2. Under β-flat semantics, B does NOT split
// the row — instead X attaches as a child with parentIdx pointing into the row's
// content range. The row's content cell is never mutated; atomic-row holds.
//
// After sync:
//   - The row is tombstoned (A's flip wins via cr-sqlite's LWW since 1 > 0).
//   - The render walks the tombstoned row, skips emitting its chars, but still
//     visits children at their attachment positions.
//   - X (child of the tombstoned row at parentIdx=1) is emitted.
//   - Final render: "X".
//
// Pre-β-flat split-based code produced "heX" because B's split materialized a
// new "he" row that A's whole-row tombstone didn't target. That outcome was an
// implementation artifact: A's intent was "delete all of 'hello'," and β-flat
// honors that intent — only B's separate insertion survives.
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "hello");
  syncBoth(a, b);

  // A whole-deletes → tombstoned=1 on the single row
  del(a, 0, 5);
  // B mid-run inserts "X" at position 2 → splits original row into L="he", R="llo",
  // then attaches "X" as a child of L. The existing row's content cell mutates ("hello" → "llo").
  ins(b, 2, "X");

  // Pre-sync local states
  if (body(a) !== "") fail(`A pre-sync expected '', got ${JSON.stringify(body(a))}`, [["a", a]]);
  if (body(b) !== "heXllo")
    fail(`B pre-sync expected 'heXllo', got ${JSON.stringify(body(b))}`, [["b", b]]);

  syncBoth(a, b);

  const aBody = body(a);
  const bBody = body(b);
  console.log(`A: ${JSON.stringify(aBody)} | B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody) fail(`scenario 2 diverged: A=${aBody} B=${bBody}`, [["a", a], ["b", b]]);

  // β-flat: only B's separate insert "X" survives. A's whole-row tombstone
  // removes everything in that row; the split-based "heX" outcome was a pre-
  // β-flat implementation artifact.
  if (aBody !== "X")
    fail(
      `tombstone-wins (β-flat) violated: expected 'X' (whole row tombstoned, only child survives), got ${JSON.stringify(aBody)}`,
      [["a", a], ["b", b]],
    );
  console.log("ok: tombstone wins over concurrent mid-run insert (β-flat semantics)");
}

// Scenario 3: overlapping partial deletes — converge deterministically, *not* to the union
// of deletion intents. Our model is Fugue: smaller-idx-wins per original-item-position, not
// "any peer's delete sticks across rows it never saw." Both peers see the same final string.
{
  const a = open();
  const b = open();
  setup(a);
  setup(b);
  ins(a, 0, "abcdefghij");
  syncBoth(a, b);

  // A deletes [2, 5) → "abfghij"
  del(a, 2, 5);
  // B deletes [3, 7) → "abchij"
  del(b, 3, 7);

  syncBoth(a, b);

  const aBody = body(a);
  const bBody = body(b);
  console.log(`A: ${JSON.stringify(aBody)} | B: ${JSON.stringify(bBody)}`);
  if (aBody !== bBody) fail(`scenario 3 diverged: A=${aBody} B=${bBody}`, [["a", a], ["b", b]]);
  // β-flat: each peer's partial delete becomes a deletion-marker child of
  // the original row, covering its own range. After sync, both markers are
  // applied; the render hides the UNION of covered positions. A deleted [2,5)
  // and B deleted [3,7) → union is [2,7) → "abhij" (cdefg removed).
  //
  // The pre-β-flat code produced "abchij" via the split-based trim mechanism,
  // where peer A's tombstoned middle [2,5) got trimmed against peer B's kept
  // "c" portion at idx=2. That's a specific quirk of the split implementation;
  // β-flat treats deletion-intent as union, which matches user expectation
  // (any peer's delete sticks).
  if (aBody !== "abhij")
    fail(`β-flat union semantics: expected 'abhij', got ${JSON.stringify(aBody)}`, [["a", a]]);
  console.log("ok: overlapping partial deletes converge to β-flat union ('abhij')");
}

// Note on limits of "tombstone-wins":
//   - Wins same-PK races (scenario 2 above): if A tombstones (Alice, 5) while B updates its
//     content via a split, A's tombstoned=1 propagates and the row stays invisible.
//   - Does NOT propagate intent across rows A never saw: if B's split created (Alice, 4) that
//     A never had, A's tombstone of (Alice, 8) doesn't tombstone (Alice, 4). The merged result
//     is Fugue's deterministic resolution, not the union of deletion intents.

console.log("\nPASS: tombstone-wins tightening verified");
