// Phase 2 smoke: Peritext primitive — canonical scenarios from the paper.
// Single-replica; verifies the mark-folding projection algorithm directly
// (paper Algorithm 1 + LWW resolution).

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SIDE_BEFORE = 0;
const SIDE_AFTER = 1;
const ACTOR = Buffer.from("alice");

function open(additive = "") {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  if (additive) {
    db.prepare("SELECT crsql_as_peritext('notes', 'body', ?)").get(additive);
  } else {
    db.prepare("SELECT crsql_as_peritext('notes', 'body')").get();
  }
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const insertText = (db, pos, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

const mark = (db, s, e, name, val, ss, es, ts, actor = ACTOR) =>
  db
    .prepare("SELECT crsql_peritext_mark('notes','body',1,?,?,?,?,?,?,?,?)")
    .run(BigInt(s), BigInt(e), name, val, BigInt(ss), BigInt(es), BigInt(ts), actor);

const unmark = (db, s, e, name, ss, es, ts, actor = ACTOR) =>
  db
    .prepare("SELECT crsql_peritext_unmark('notes','body',1,?,?,?,?,?,?,?)")
    .run(BigInt(s), BigInt(e), name, BigInt(ss), BigInt(es), BigInt(ts), actor);

const body = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();

// ── Example 2: non-overlapping bolds from two actors both apply ──────
// Paper §3.2, Example 2: Alice bolds [0,3] "The", Bob bolds [4,7] "fox".
// Both bolds end up applied (union over disjoint ranges).
{
  const db = open();
  insertText(db, 0, "The fox jumped.");
  mark(db, 0, 3, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  mark(db, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 101, Buffer.from("bob"));
  const parsed = JSON.parse(body(db));
  // Expect spans: "The" bold, " " unformatted, "fox" bold, " jumped." unformatted
  const bolded = parsed.filter((s) => s.marks.bold).map((s) => s.text);
  if (JSON.stringify(bolded) !== JSON.stringify(["The", "fox"])) {
    fail(`Example 2: expected ["The","fox"] bold, got ${JSON.stringify(parsed)}`);
  }
  console.log("ok: Example 2 — disjoint bolds both apply");
  db.close();
}

// ── Example 2 variant: overlapping bolds collapse to union ───────────
// Alice bolds [0,7] "The fox", Bob bolds [4,15] "fox jumped." — overlap on "fox".
// Both bolds active in overlap → still bold. Expect: "The fox jumped." all bold.
{
  const db = open();
  insertText(db, 0, "The fox jumped.");
  mark(db, 0, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  mark(db, 4, 15, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 101, Buffer.from("bob"));
  const parsed = JSON.parse(body(db));
  // Should be all bold — possibly split into adjacent spans by mark transitions,
  // but every char should carry bold:true.
  const allBold = parsed.every((s) => s.marks.bold === true);
  const fullText = parsed.map((s) => s.text).join("");
  if (!allBold || fullText !== "The fox jumped.") {
    fail(
      `Example 2 variant: expected full bold, got ${JSON.stringify(parsed)}`
    );
  }
  console.log("ok: Example 2 variant — overlapping bolds → union");
  db.close();
}

// ── Example 5: bold + unbold same range → higher opId wins ───────────
// Alice bolds "fox", then with HIGHER ts Bob unbolds "fox". Result: not bold.
{
  const db = open();
  insertText(db, 0, "The fox jumped.");
  mark(db, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  unmark(db, 4, 7, "bold", SIDE_BEFORE, SIDE_BEFORE, 200, Buffer.from("bob"));
  const parsed = JSON.parse(body(db));
  const hasBold = parsed.some((s) => s.marks.bold);
  if (hasBold) fail(`Example 5: expected no bold, got ${JSON.stringify(parsed)}`);
  console.log("ok: Example 5 — unmark with higher ts wins");
  db.close();
}

// ── Example 5 reversed: bold ts > unbold ts → bold wins ──────────────
{
  const db = open();
  insertText(db, 0, "The fox jumped.");
  unmark(db, 4, 7, "bold", SIDE_BEFORE, SIDE_BEFORE, 100, Buffer.from("alice"));
  mark(db, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 200, Buffer.from("bob"));
  const parsed = JSON.parse(body(db));
  const bolded = parsed.filter((s) => s.marks.bold).map((s) => s.text);
  if (JSON.stringify(bolded) !== JSON.stringify(["fox"])) {
    fail(`Example 5 reversed: expected "fox" bold, got ${JSON.stringify(parsed)}`);
  }
  console.log("ok: Example 5 reversed — bold with higher ts wins");
  db.close();
}

// ── Example 7: text inserted at end of bold range grows the bold ─────
// Bold "fox" with end_side=before. Insert "ier" after "fox" (position 7).
// Expected (per paper Ex 7 + Table 1): end-side=before means the mark
// expands at the end; "foxier" becomes bold.
{
  const db = open();
  insertText(db, 0, "The fox jumped.");
  mark(db, 4, 7, "bold", null, SIDE_BEFORE, SIDE_BEFORE, 100);
  // Insert "ier" at position 7 — right after "fox", before the space.
  insertText(db, 7, "ier");
  const parsed = JSON.parse(body(db));
  const bolded = parsed.filter((s) => s.marks.bold).map((s) => s.text).join("");
  if (bolded !== "foxier") {
    fail(`Example 7: expected "foxier" bold, got ${JSON.stringify(parsed)}`);
  }
  console.log("ok: Example 7 — text appended at end of bold inherits bold");
  db.close();
}

// ── Example 7 variant: link with end_side=after does NOT grow ────────
{
  const db = open();
  insertText(db, 0, "Click here.");
  mark(db, 6, 10, "link", "https://example.com", SIDE_BEFORE, SIDE_AFTER, 100);
  // Insert "!" right after "here" (position 10), before the period.
  insertText(db, 10, "!");
  const parsed = JSON.parse(body(db));
  const linked = parsed.filter((s) => s.marks.link).map((s) => s.text).join("");
  if (linked !== "here") {
    fail(
      `Example 7 link variant: expected only "here" linked, got ${JSON.stringify(parsed)}`
    );
  }
  console.log("ok: Example 7 variant — end_side=after prevents link growth");
  db.close();
}

// ── Example 6 (100% scope): additive comments coexist as array ───────
// Two overlapping comments. Declared additive at registration. Both
// values must appear in the marks array over the overlap region.
{
  const db = open("comment");
  insertText(db, 0, "The fox jumped.");
  // Alice comments [4, 7] (= "fox") with value "typo?"
  mark(db, 4, 7, "comment", "typo?", SIDE_BEFORE, SIDE_AFTER, 100, Buffer.from("alice"));
  // Bob comments [4, 11] (= "fox jum") with value "agreed"
  mark(db, 4, 11, "comment", "agreed", SIDE_BEFORE, SIDE_AFTER, 101, Buffer.from("bob"));
  const parsed = JSON.parse(body(db));
  // Find the span where both comments overlap (should be "fox")
  const both = parsed.find(
    (s) => Array.isArray(s.marks.comment) && s.marks.comment.length === 2
  );
  if (!both) {
    fail(`Example 6: no span with both comments, got ${JSON.stringify(parsed)}`);
  }
  if (both.text !== "fox") {
    fail(`Example 6: both-comments span should be "fox", got ${JSON.stringify(both)}`);
  }
  const vals = [...both.marks.comment].sort();
  if (JSON.stringify(vals) !== JSON.stringify(["agreed", "typo?"])) {
    fail(`Example 6: expected both values, got ${JSON.stringify(vals)}`);
  }
  console.log("ok: Example 6 — overlapping comments coexist (additive marks)");
  db.close();
}

console.log("\nphase2: ok");
