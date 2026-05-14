// Perf regression probe — sequential keystroke scaling.
//
// Measures fugue_insert per-op latency at three document sizes (1K, 2K, 5K
// keystrokes appended at end) and reports a scaling ratio so future runs can
// catch O(N²) regressions even if the absolute numbers shift.
//
// Why these N values: 1K is "small file," 5K is "typical IDE source file"
// (a few hundred lines). The 5K measurement runs ~ N² so even modest
// regressions move it noticeably. Keeps total run under ~30s.
//
// Gate: 5K keystrokes must complete in under SOFT_FAIL_MS (warns but exits
// 0) and HARD_FAIL_MS (exits non-zero). Tune as the engine improves.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SAMPLES = [1_000, 2_000, 5_000];
const HARD_FAIL_MS = 60_000; // 5K keystrokes must beat 60s (12ms/op @ 5K)
const SOFT_FAIL_MS = 30_000; // warn under 30s but still pass

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

const insertStmt = (db) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)");

function timeKeystrokes(n) {
  const db = open();
  const stmt = insertStmt(db);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) stmt.get(i, "x");
  const dt = performance.now() - t0;
  return dt;
}

console.log("Perf scaling probe — sequential keystrokes appended at end");
console.log("");

const results = [];
for (const n of SAMPLES) {
  const dt = timeKeystrokes(n);
  const perOp = dt / n;
  results.push({ n, dt, perOp });
  console.log(`  N=${String(n).padStart(5)}  total=${dt.toFixed(0).padStart(6)}ms  per-op=${perOp.toFixed(3)}ms`);
}

console.log("");
console.log("Scaling ratios (should be ~N²/N for O(N²); ideally closer to ~1 for O(1)):");
for (let i = 1; i < results.length; i++) {
  const a = results[i - 1];
  const b = results[i];
  const nRatio = b.n / a.n;
  const tRatio = b.dt / a.dt;
  const opRatio = b.perOp / a.perOp;
  console.log(
    `  N: ${a.n} → ${b.n}  (${nRatio.toFixed(1)}×)   ` +
      `total: ${tRatio.toFixed(2)}×   per-op: ${opRatio.toFixed(2)}×`,
  );
}

console.log("");
const last = results[results.length - 1];
if (last.dt >= HARD_FAIL_MS) {
  console.error(
    `FAIL: ${last.n} keystrokes took ${last.dt.toFixed(0)}ms (hard gate ${HARD_FAIL_MS}ms)`,
  );
  process.exit(1);
}
if (last.dt >= SOFT_FAIL_MS) {
  console.warn(
    `SOFT-FAIL: ${last.n} keystrokes took ${last.dt.toFixed(0)}ms (soft gate ${SOFT_FAIL_MS}ms). Optimisation opportunity.`,
  );
} else {
  console.log(`PASS: ${last.n} keystrokes in ${last.dt.toFixed(0)}ms`);
}
