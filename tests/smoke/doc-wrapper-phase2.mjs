// Phase 2: doc-wrapper two-peer convergence — the Peritext payoff.
// The whole point of layering tree + Peritext under the doc-wrapper is
// that concurrent edits to the same paragraph DON'T garble syntax / drop
// marks. This test pins the canonical scenarios from Peritext §3.

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

function siteId(db) {
  return db.prepare("SELECT quote(crsql_site_id())").pluck().get();
}
function pullChanges(db, excludeSiteHex) {
  return db
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
    )
    .all(excludeSiteHex);
}
function applyChanges(db, rows) {
  const stmt = db.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  db.transaction((rs) => rs.forEach((r) => stmt.run(r)))(rows);
}
function sync(a, b) {
  const aSite = siteId(a).replace(/^X'/, "x'");
  const bSite = siteId(b).replace(/^X'/, "x'");
  const aToB = pullChanges(a, bSite);
  const bToA = pullChanges(b, aSite);
  applyChanges(b, aToB);
  applyChanges(a, bToA);
}

// ── 1. Initial state sync ────────────────────────────────────────
{
  const a = open(), b = open();
  apply(a, [
    { kind: "heading-1", spans: [{ text: "Title", marks: [] }] },
    { kind: "paragraph", spans: [{ text: "Hello world", marks: [] }] },
  ]);
  sync(a, b);
  const ra = render(a), rb = render(b);
  if (JSON.stringify(ra) !== JSON.stringify(rb)) {
    console.error("a:", JSON.stringify(ra));
    console.error("b:", JSON.stringify(rb));
    fail("initial sync diverged");
  }
  console.log("ok: initial apply syncs across peers");
  a.close(); b.close();
}

// ── 2. Concurrent typing in same paragraph (paper §3.2 / Fig 1) ──
//    Both peers edit the same paragraph. CRDT should merge both edits.
{
  const a = open(), b = open();
  apply(a, [{ kind: "paragraph", spans: [{ text: "Hello", marks: [] }] }]);
  sync(a, b);

  // Concurrent: a appends " world", b appends " everyone"
  apply(a, [{ kind: "paragraph", spans: [{ text: "Hello world", marks: [] }] }]);
  apply(b, [{ kind: "paragraph", spans: [{ text: "Hello everyone", marks: [] }] }]);
  sync(a, b);

  const ra = render(a), rb = render(b);
  if (JSON.stringify(ra) !== JSON.stringify(rb)) {
    console.error("a:", JSON.stringify(ra));
    console.error("b:", JSON.stringify(rb));
    fail("concurrent same-block edits diverged");
  }
  // Plaintext should contain BOTH edits (some interleaving is OK).
  const text = ra[0].spans.map((s) => s.text).join("");
  if (!text.includes("world") || !text.includes("everyone")) {
    fail(`expected both edits to survive; got "${text}"`);
  }
  console.log(`ok: concurrent same-paragraph edits converge → "${text}"`);
  a.close(); b.close();
}

// ── 3. Concurrent bold-vs-typing in same range (paper §3.1, Fig 1) ──
//    THE classic Peritext scenario. A bolds "world"; B types "big "
//    before "world". After sync, "big" should be plain and "world"
//    should still be bold (mark anchored to itemIds, not positions).
{
  const a = open(), b = open();
  apply(a, [{ kind: "paragraph", spans: [{ text: "Hello world", marks: [] }] }]);
  sync(a, b);

  // a bolds "world" (positions 6..11)
  apply(a, [{ kind: "paragraph", spans: [
    { text: "Hello ", marks: [] },
    { text: "world", marks: [{ name: "bold" }] },
  ]}]);
  // b inserts "big " at position 6
  apply(b, [{ kind: "paragraph", spans: [{ text: "Hello big world", marks: [] }] }]);
  sync(a, b);

  const ra = render(a), rb = render(b);
  if (JSON.stringify(ra) !== JSON.stringify(rb)) {
    console.error("a:", JSON.stringify(ra));
    console.error("b:", JSON.stringify(rb));
    fail("concurrent bold+typing diverged across peers");
  }
  const text = ra[0].spans.map((s) => s.text).join("");
  if (text !== "Hello big world") fail(`unexpected merged text: "${text}"`);

  // The Peritext promise: "world" stays bold, "big" doesn't.
  const boldSpan = ra[0].spans.find((s) => s.marks && s.marks.bold);
  if (!boldSpan) fail(`bold mark lost in concurrent merge: ${JSON.stringify(ra)}`);
  if (boldSpan.text !== "world") {
    fail(`bold leaked or shifted: expected "world" bold, got "${boldSpan.text}"`);
  }
  console.log('ok: concurrent bold+typing — mark stays anchored to "world"');
  a.close(); b.close();
}

// ── 4. Concurrent block adds at end ───────────────────────────────
//    A adds a heading, B adds a paragraph. Both should land.
{
  const a = open(), b = open();
  apply(a, [{ kind: "paragraph", spans: [{ text: "first", marks: [] }] }]);
  sync(a, b);

  apply(a, [
    { kind: "paragraph", spans: [{ text: "first", marks: [] }] },
    { kind: "heading-2", spans: [{ text: "from-a", marks: [] }] },
  ]);
  apply(b, [
    { kind: "paragraph", spans: [{ text: "first", marks: [] }] },
    { kind: "paragraph", spans: [{ text: "from-b", marks: [] }] },
  ]);
  sync(a, b);

  const ra = render(a), rb = render(b);
  if (JSON.stringify(ra) !== JSON.stringify(rb)) {
    console.error("a:", JSON.stringify(ra));
    console.error("b:", JSON.stringify(rb));
    fail("concurrent block adds diverged");
  }
  const kinds = ra.map((bl) => bl.kind);
  if (kinds.length !== 3) {
    fail(`expected 3 blocks (1 shared + 2 concurrent adds), got ${kinds.length}: ${JSON.stringify(kinds)}`);
  }
  if (!kinds.includes("heading-2") || kinds.filter((k) => k === "paragraph").length !== 2) {
    fail(`expected heading-2 + 2 paragraphs, got ${JSON.stringify(kinds)}`);
  }
  console.log(`ok: concurrent block adds — final shape ${JSON.stringify(kinds)}`);
  a.close(); b.close();
}

console.log("\ndoc-wrapper-phase2: ok");
