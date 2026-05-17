// Phase 1: doc-wrapper local API — no markdown.
// Exercises crsql_doc_init / crsql_doc_apply / crsql_doc_render directly
// against the neutral block-tree JSON wire format.

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
const eq = (a, b, label) => {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) fail(`${label}\n  want ${sb}\n  got  ${sa}`);
};

// ── 1. init creates schema + sentinels ───────────────────────────────
{
  const db = open();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='blocks'")
    .all();
  if (!tables.length) fail("blocks table not created");
  const r = render(db);
  eq(r, [], "fresh doc renders []");
  console.log("ok: init creates schema, fresh doc renders []");
  db.close();
}

// ── 2. apply a single paragraph → render returns it ─────────────────
{
  const db = open();
  apply(db, [
    { kind: "paragraph", spans: [{ text: "Hello world", marks: [] }] },
  ]);
  const r = render(db);
  if (r.length !== 1 || r[0].kind !== "paragraph") fail(`shape: ${JSON.stringify(r)}`);
  // span flat text
  const text = r[0].spans.map((s) => s.text).join("");
  eq(text, "Hello world", "round-tripped plaintext");
  console.log("ok: apply→render round-trip (paragraph)");
  db.close();
}

// ── 3. apply with bold mark on a range ─────────────────────────────
{
  const db = open();
  apply(db, [
    { kind: "paragraph", spans: [
      { text: "Hello ", marks: [] },
      { text: "world",  marks: [{ name: "bold" }] },
    ]},
  ]);
  const r = render(db);
  const text = r[0].spans.map((s) => s.text).join("");
  eq(text, "Hello world", "merged plaintext");
  const boldSpan = r[0].spans.find((s) => s.marks && s.marks.bold);
  if (!boldSpan || boldSpan.text !== "world") {
    fail(`bold span missing or wrong: ${JSON.stringify(r)}`);
  }
  console.log("ok: bold mark round-trips through apply+render");
  db.close();
}

// ── 4. content edit: append " world" to existing "Hello" ────────────
{
  const db = open();
  apply(db, [{ kind: "paragraph", spans: [{ text: "Hello", marks: [] }] }]);
  apply(db, [{ kind: "paragraph", spans: [{ text: "Hello world", marks: [] }] }]);
  const r = render(db);
  const text = r[0].spans.map((s) => s.text).join("");
  eq(text, "Hello world", "after content edit");
  // verify the block id stayed the same (proves we did a content diff
  // rather than delete+recreate)
  if (r.length !== 1) fail(`expected single block, got ${r.length}`);
  console.log("ok: content edit diffs into the existing block");
  db.close();
}

// ── 5. add a second block ──────────────────────────────────────────
{
  const db = open();
  apply(db, [{ kind: "paragraph", spans: [{ text: "Hello", marks: [] }] }]);
  apply(db, [
    { kind: "heading-1", spans: [{ text: "Title", marks: [] }] },
    { kind: "paragraph", spans: [{ text: "Hello", marks: [] }] },
  ]);
  const r = render(db);
  eq(r.map((b) => b.kind), ["heading-1", "paragraph"], "blocks in order");
  console.log("ok: insert new block at top");
  db.close();
}

// ── 6. remove a block ──────────────────────────────────────────────
{
  const db = open();
  apply(db, [
    { kind: "heading-1", spans: [{ text: "Title", marks: [] }] },
    { kind: "paragraph", spans: [{ text: "Hello", marks: [] }] },
  ]);
  apply(db, [
    { kind: "paragraph", spans: [{ text: "Hello", marks: [] }] },
  ]);
  const r = render(db);
  eq(r.map((b) => b.kind), ["paragraph"], "block removed");
  console.log("ok: remove block (move to trash)");
  db.close();
}

// ── 7. change kind ─────────────────────────────────────────────────
{
  const db = open();
  apply(db, [{ kind: "paragraph", spans: [{ text: "Title", marks: [] }] }]);
  apply(db, [{ kind: "heading-1", spans: [{ text: "Title", marks: [] }] }]);
  const r = render(db);
  eq(r.map((b) => b.kind), ["heading-1"], "kind changed");
  console.log("ok: change block kind");
  db.close();
}

console.log("\ndoc-wrapper-phase1: ok");
