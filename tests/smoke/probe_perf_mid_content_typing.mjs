// Perf regression probe — sequential typing in the middle of a document.
//
// Simulates the IDE pattern: cursor lands at some position, user types K
// chars there sequentially (without jumping). The cursor cache should make
// each keystroke after the first O(1) — first insert at the new position is
// a cache miss (slow path), subsequent inserts at cursor+1 hit the fast
// path. Total cost: O(N + K) for K keystrokes on a doc of N chars.
//
// Without the cursor cache (tail-only), every mid-content keystroke would
// be a cache miss → slow path → O(N) per op → O(N·K) total.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SAMPLES = [
  // (doc-size, mid-content-keystrokes)
  [1_000, 500],
  [5_000, 500],
  [10_000, 500],
];
const HARD_FAIL_MS = 60_000;
const SOFT_FAIL_MS = 10_000;

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

function seedDoc(db, n) {
  // Build a doc of `n` chars via a single bulk insert. Fast path doesn't
  // apply (empty cache) but completes in <10ms for any size.
  const text = "x".repeat(n);
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(0, text);
}

function timeMidContentTyping(docSize, keystrokes) {
  const db = open();
  seedDoc(db, docSize);
  // Place "cursor" mid-doc; type `keystrokes` chars sequentially at this region.
  const startPos = Math.floor(docSize / 2);
  const stmt = db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)");
  const t0 = performance.now();
  for (let i = 0; i < keystrokes; i++) {
    stmt.get(startPos + i, "y");
  }
  const dt = performance.now() - t0;
  return dt;
}

console.log("Perf probe — typing K chars sequentially mid-doc (cursor cache test)");
console.log("");

const results = [];
for (const [docSize, k] of SAMPLES) {
  const dt = timeMidContentTyping(docSize, k);
  const perOp = dt / k;
  results.push({ docSize, k, dt, perOp });
  console.log(
    `  docSize=${String(docSize).padStart(6)}  keystrokes=${String(k).padStart(5)}  ` +
      `total=${dt.toFixed(0).padStart(6)}ms  per-op=${perOp.toFixed(3)}ms`,
  );
}

console.log("");
console.log("Scaling: per-op should stay roughly constant as doc grows");
console.log("(if it grows ~linearly with docSize → cursor cache isn't working)");
console.log("");

for (let i = 1; i < results.length; i++) {
  const a = results[i - 1];
  const b = results[i];
  const docRatio = b.docSize / a.docSize;
  const opRatio = b.perOp / a.perOp;
  console.log(
    `  doc: ${a.docSize} → ${b.docSize}  (${docRatio.toFixed(1)}×)   per-op ratio: ${opRatio.toFixed(2)}×`,
  );
}

console.log("");
const last = results[results.length - 1];
if (last.dt >= HARD_FAIL_MS) {
  console.error(
    `FAIL: ${last.k} keystrokes on ${last.docSize}-char doc took ${last.dt.toFixed(0)}ms`,
  );
  process.exit(1);
}
if (last.dt >= SOFT_FAIL_MS) {
  console.warn(
    `SOFT-FAIL: ${last.k} keystrokes on ${last.docSize}-char doc took ${last.dt.toFixed(0)}ms`,
  );
} else {
  console.log(
    `PASS: ${last.k} keystrokes on a ${last.docSize}-char doc in ${last.dt.toFixed(0)}ms`,
  );
}
