// Regression: when a new block is applied between two existing blocks
// whose fractional indices form a prefix relationship (e.g. "m" and "mm"),
// the engine must place the new block strictly between them — not after
// both via frac collision.
//
// Bug exposed: frac_between heuristic always returned `b + "m"`, which
// collides with `a` whenever a == b + "m". The colliding block ended up
// ordered by SQLite's BLOB-tie tiebreaker (ROWID), landing AFTER its
// intended successor and corrupting document structure during sync.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.prepare("SELECT crsql_doc_init()").get();
  return db;
}
const apply = (db, tree) =>
  db.prepare("SELECT crsql_doc_apply(?)").get(JSON.stringify(tree));
const render = (db) => JSON.parse(db.prepare("SELECT crsql_doc_render()").pluck().get());

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const eqKinds = (r, want, label) => {
  const got = r.map((b) => b.kind);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`${label}\n  want kinds ${JSON.stringify(want)}\n  got       ${JSON.stringify(got)}`);
  }
};

// ── 1. paper case: insert list-item between two adjacent headings ────
// Reproduces the user-typed scenario: "# foo\n\n# bar" → "# foo\n\n- \n\n# bar".
// The new list-item must land between the two headings, not at the end.
{
  const db = open();
  apply(db, [
    { kind: "heading-1", spans: [{ text: "foo", marks: [] }] },
    { kind: "heading-1", spans: [{ text: "bar", marks: [] }] },
  ]);
  apply(db, [
    { kind: "heading-1", spans: [{ text: "foo", marks: [] }] },
    { kind: "list-item",  spans: [{ text: "",    marks: [] }] },
    { kind: "heading-1", spans: [{ text: "bar", marks: [] }] },
  ]);
  eqKinds(render(db), ["heading-1", "list-item", "heading-1"],
    "list-item inserted between two headings");
  console.log("ok: insert list-item between two headings");
  db.close();
}

// ── 2. insert paragraph between two list items ──────────────────────
// Same shape, different kinds. Confirms it's not specific to headings.
{
  const db = open();
  apply(db, [
    { kind: "list-item", spans: [{ text: "one",   marks: [] }] },
    { kind: "list-item", spans: [{ text: "two",   marks: [] }] },
  ]);
  apply(db, [
    { kind: "list-item", spans: [{ text: "one",   marks: [] }] },
    { kind: "paragraph", spans: [{ text: "aside", marks: [] }] },
    { kind: "list-item", spans: [{ text: "two",   marks: [] }] },
  ]);
  eqKinds(render(db), ["list-item", "paragraph", "list-item"],
    "paragraph inserted between two list-items");
  console.log("ok: insert paragraph between two list-items");
  db.close();
}

// ── 3. multiple new blocks between same pair preserve order ─────────
// Two new blocks land between the same paired neighbors. Each must
// get a frac strictly between left and right, AND distinct from each other.
{
  const db = open();
  apply(db, [
    { kind: "heading-1", spans: [{ text: "top",    marks: [] }] },
    { kind: "heading-1", spans: [{ text: "bottom", marks: [] }] },
  ]);
  apply(db, [
    { kind: "heading-1", spans: [{ text: "top",    marks: [] }] },
    { kind: "paragraph", spans: [{ text: "a",      marks: [] }] },
    { kind: "paragraph", spans: [{ text: "b",      marks: [] }] },
    { kind: "heading-1", spans: [{ text: "bottom", marks: [] }] },
  ]);
  const r = render(db);
  eqKinds(r, ["heading-1", "paragraph", "paragraph", "heading-1"],
    "two new paragraphs between headings");
  const txts = r.map((b) => b.spans.map((s) => s.text).join(""));
  if (JSON.stringify(txts) !== JSON.stringify(["top", "a", "b", "bottom"])) {
    fail(`order wrong:\n  want ${JSON.stringify(["top","a","b","bottom"])}\n  got  ${JSON.stringify(txts)}`);
  }
  console.log("ok: two new blocks between same pair, in order");
  db.close();
}

// ── 4. iterated inserts between same pair (regression for collisions) ─
// Insert N new blocks one at a time, each between the first and last.
// Without proper fractional indexing, later inserts collide with earlier
// ones and ordering degrades.
{
  const db = open();
  apply(db, [
    { kind: "heading-1", spans: [{ text: "L", marks: [] }] },
    { kind: "heading-1", spans: [{ text: "R", marks: [] }] },
  ]);
  // After each iteration the doc should have [L, m1..mn, R] in this order.
  const inserted = [];
  for (let i = 0; i < 6; i++) {
    inserted.unshift(String.fromCharCode(97 + i)); // 'a','b','c'...
    apply(db, [
      { kind: "heading-1", spans: [{ text: "L", marks: [] }] },
      ...inserted.map((t) => ({
        kind: "paragraph", spans: [{ text: t, marks: [] }],
      })),
      { kind: "heading-1", spans: [{ text: "R", marks: [] }] },
    ]);
    const r = render(db);
    const txts = r.map((b) => b.spans.map((s) => s.text).join(""));
    const want = ["L", ...inserted, "R"];
    if (JSON.stringify(txts) !== JSON.stringify(want)) {
      fail(`iter ${i}: order wrong\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(txts)}`);
    }
  }
  console.log("ok: iterated inserts between pair (6 rounds)");
  db.close();
}

console.log("\ndoc-wrapper-insert-between: ok");
