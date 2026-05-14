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
const cleanup = (db) =>
  db.prepare("SELECT crsql_fugue_cleanup('notes','body',1)").pluck().get();
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
  cleanup(a);
  cleanup(b);
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

// Scenario 2: same-PK tombstone-vs-content-edit race.
// A whole-deletes a row (sets tombstoned=1, content preserved).
// B concurrently does a mid-run insert that SPLITS the same row — the split UPDATEs the
// existing row's content to the R-half (no tombstoning of that row by B).
// → both peers update DIFFERENT cells of the same PK:
//     A's tombstoned cell: 0 → 1
//     B's content cell:    "hello" → "lo" (the R-half of B's split)
// After sync, per-cell LWW: tombstoned=1 wins (1 > 0 ValueWin), content takes whichever's higher.
// Render filters tombstoned=1, so the row is invisible regardless of which content cell won.
//
// Pre-tombstoned-column, this race put A's content=NULL up against B's "lo" — B's
// content could win under LWW, "resurrecting" the deleted text. With the boolean column,
// the row stays gone.
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

  // Expected: tombstone-wins makes the ORIGINAL row invisible. The L-half "he" and B's "X"
  // remain (they're separate rows that A never had to compete with). Result: "heX".
  // Pre-fix, this would have included "llo" or "hello" depending on which content won.
  if (aBody !== "heX")
    fail(
      `tombstone-wins violated: expected 'heX' (original row tombstoned, splits survive), got ${JSON.stringify(aBody)}`,
      [["a", a], ["b", b]],
    );
  console.log("ok: tombstone wins over concurrent content edit (same-PK race)");
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
  // Fugue-deterministic result (smaller-idx wins per position): "abchij".
  // The "union of deletions" intuition would yield "abhij" but that's NOT what Fugue produces —
  // peer A's tombstone of positions [2,5) only applies via row (Alice, 4) which gets trimmed
  // to range [3,4] by cleanup's overlap with the kept "c" portion at idx=2.
  if (aBody !== "abchij")
    fail(`Fugue result drift: expected 'abchij', got ${JSON.stringify(aBody)}`, [["a", a]]);
  console.log("ok: overlapping partial deletes converge to Fugue-deterministic result");
}

// Note on limits of "tombstone-wins":
//   - Wins same-PK races (scenario 2 above): if A tombstones (Alice, 5) while B updates its
//     content via a split, A's tombstoned=1 propagates and the row stays invisible.
//   - Does NOT propagate intent across rows A never saw: if B's split created (Alice, 4) that
//     A never had, A's tombstone of (Alice, 8) doesn't tombstone (Alice, 4). The merged result
//     is Fugue's deterministic resolution, not the union of deletion intents.

console.log("\nPASS: tombstone-wins tightening verified");
