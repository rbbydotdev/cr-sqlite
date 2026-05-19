// Smoke test for `crsql_doc_pull` / `crsql_doc_push`.
// Two peers sync via opaque-blob exchange — no direct access to
// crsql_changes from the test harness.

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
const apply  = (db, tree) => db.prepare("SELECT crsql_doc_apply(?)").get(JSON.stringify(tree));
const render = (db)       => JSON.parse(db.prepare("SELECT crsql_doc_render()").pluck().get());
const pull   = (db, ex)   => db.prepare("SELECT crsql_doc_pull(?)").pluck().get(ex ?? "");
const push   = (db, blob) => db.prepare("SELECT crsql_doc_push(?)").get(blob);
const siteId = (db)       => db.prepare("SELECT lower(hex(crsql_site_id()))").pluck().get();

const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fail(`${label}\n  want ${JSON.stringify(b)}\n  got  ${JSON.stringify(a)}`);
  }
};

// ── 1. pull excluding self on a fresh db returns no rows ─────────────
// (the sentinel inserts from init were originated by self)
{
  const db = open();
  const blob = pull(db, siteId(db));
  eq(JSON.parse(blob), [], "pull excluding self on fresh db");
  console.log("ok: pull(self) on fresh db → []");
  db.close();
}

// ── 2. apply on one peer, sync to the other ─────────────────────────
{
  const A = open(), B = open();
  apply(A, [
    { kind: "heading-1", spans: [{ text: "Hello", marks: [] }] },
    { kind: "paragraph", spans: [{ text: "World", marks: [] }] },
  ]);
  const blobAtoB = pull(A, siteId(B));
  push(B, blobAtoB);
  const r = render(B);
  eq(r.map((b) => b.kind), ["heading-1", "paragraph"], "B kinds after sync");
  const text = r.map((b) => b.spans.map((s) => s.text).join("")).join("|");
  eq(text, "Hello|World", "B text after sync");
  console.log("ok: A → B sync via pull/push");
  A.close(); B.close();
}

// ── 3. round-trip preserves complex content (marks, multiple blocks) ─
{
  const A = open(), B = open();
  apply(A, [
    { kind: "paragraph", spans: [
      { text: "Hi ",    marks: [] },
      { text: "there",  marks: [{ name: "bold" }] },
      { text: " · ",    marks: [] },
      { text: "link",   marks: [{ name: "link", value: "https://x" }] },
    ]},
  ]);
  push(B, pull(A, siteId(B)));
  const r = render(B);
  if (r.length !== 1) fail(`expected 1 block, got ${r.length}`);
  const spans = r[0].spans;
  // Spans converge to text + marks; just check the joined text and that
  // a bold/link mark survived
  const text = spans.map((s) => s.text).join("");
  eq(text, "Hi there · link", "round-tripped plaintext");
  const hasBold = spans.some((s) => s.marks?.bold);
  const hasLink = spans.some((s) => s.marks?.link);
  if (!hasBold) fail("bold mark lost in sync");
  if (!hasLink) fail("link mark lost in sync");
  console.log("ok: marks survive pull/push");
  A.close(); B.close();
}

// ── 4. exclude_site filter: pull(A, A.siteId) returns no A-origin ops ─
{
  const A = open();
  apply(A, [{ kind: "paragraph", spans: [{ text: "self", marks: [] }] }]);
  const ownBlob = pull(A, siteId(A));
  // Every op A made was self-originated, so excluding A's own site
  // should yield an empty result.
  eq(JSON.parse(ownBlob), [], "pull excluding self → empty");
  console.log("ok: exclude_site filter works");
  A.close();
}

// ── 5. bidirectional convergence ────────────────────────────────────
{
  const A = open(), B = open();
  apply(A, [{ kind: "heading-1", spans: [{ text: "from A", marks: [] }] }]);
  apply(B, [{ kind: "paragraph", spans: [{ text: "from B", marks: [] }] }]);
  // A → B
  push(B, pull(A, siteId(B)));
  // B → A
  push(A, pull(B, siteId(A)));
  // both should now have both blocks
  const rA = render(A).map((b) => b.kind).sort();
  const rB = render(B).map((b) => b.kind).sort();
  eq(rA, ["heading-1", "paragraph"], "A converged");
  eq(rB, ["heading-1", "paragraph"], "B converged");
  console.log("ok: bidirectional sync converges");
  A.close(); B.close();
}

// ── 6. idempotent push ──────────────────────────────────────────────
{
  const A = open(), B = open();
  apply(A, [{ kind: "paragraph", spans: [{ text: "once", marks: [] }] }]);
  const blob = pull(A, siteId(B));
  push(B, blob);
  push(B, blob); // applying same blob again should be a no-op via dedup
  const r = render(B);
  if (r.length !== 1) fail(`expected 1 block after double push, got ${r.length}`);
  console.log("ok: re-pushing same blob is idempotent");
  A.close(); B.close();
}

console.log("\ndoc-wrapper-pull-push: ok");
