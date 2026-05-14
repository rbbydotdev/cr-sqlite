// Perf probe — multi-region clustered typing (the N-marker LRU sweet spot).
//
// Simulates a more realistic IDE pattern: cursor jumps between several
// "clusters" in the doc, types a few chars in each, jumps to the next.
// Pattern: pick K cluster positions, then for R rounds, visit each cluster
// and type C chars there. Total keystrokes = K * R * C.
//
// With single-marker (tail-only or cursor-only) cache: only ONE cluster
// stays warm at a time. Jumping to another cluster blows the cache → slow
// path. Per-op cost grows with doc size.
//
// With N-marker LRU: up to N clusters stay warm simultaneously. Visiting
// any of them hits the fast path. Per-op cost stays flat regardless of
// doc size, as long as K ≤ N.
//
// Expectation: with MAX_MARKERS=16, K=4 clusters easily fit. Per-op time
// should match the mid-content typing probe (~0.05ms).

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SAMPLES = [
  // (doc-size, num-clusters, rounds, chars-per-visit)
  [5_000,  4,  20, 5],   //  4 clusters × 20 rounds × 5 chars = 400 keystrokes
  [10_000, 4,  20, 5],
  [10_000, 8,  10, 5],   //  8 clusters × 10 rounds × 5 chars = 400 keystrokes
];
const HARD_FAIL_MS = 30_000;
const SOFT_FAIL_MS = 5_000;

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
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(0, "x".repeat(n));
}

function timeClusteredTyping(docSize, numClusters, rounds, charsPerVisit) {
  const db = open();
  seedDoc(db, docSize);
  const stmt = db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)");
  // Cluster anchors spread evenly across the doc.
  // Each cluster has its own "current cursor" that advances as we type in it.
  const cursors = [];
  for (let c = 0; c < numClusters; c++) {
    const startPos = Math.floor(((c + 1) / (numClusters + 1)) * docSize);
    cursors.push(startPos);
  }
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) {
    for (let c = 0; c < numClusters; c++) {
      for (let i = 0; i < charsPerVisit; i++) {
        stmt.get(cursors[c], "y");
        cursors[c]++;
        // Other cursors at positions >= this one shift by 1 too
        for (let c2 = 0; c2 < numClusters; c2++) {
          if (c2 !== c && cursors[c2] >= cursors[c] - 1) {
            cursors[c2]++;
          }
        }
      }
    }
  }
  return performance.now() - t0;
}

console.log("Perf probe — multi-region clustered typing (N-marker LRU test)");
console.log("");

const results = [];
for (const [docSize, K, rounds, chars] of SAMPLES) {
  const totalOps = K * rounds * chars;
  const dt = timeClusteredTyping(docSize, K, rounds, chars);
  const perOp = dt / totalOps;
  results.push({ docSize, K, rounds, chars, totalOps, dt, perOp });
  console.log(
    `  doc=${String(docSize).padStart(6)}  K=${K}  rounds=${rounds}  ` +
      `chars=${chars}  total=${dt.toFixed(0).padStart(5)}ms  per-op=${perOp.toFixed(3)}ms`,
  );
}

console.log("");
console.log("Per-op should stay constant as doc size grows AND as cluster count");
console.log("grows (up to MAX_MARKERS=16). If per-op tracks doc size, the LRU is");
console.log("thrashing or cluster count exceeds marker capacity.");
console.log("");
console.log("Cross-doc-size comparison (K=4, same workload):");
const k4 = results.filter((r) => r.K === 4);
for (let i = 1; i < k4.length; i++) {
  const a = k4[i - 1];
  const b = k4[i];
  const docRatio = b.docSize / a.docSize;
  const opRatio = b.perOp / a.perOp;
  console.log(
    `  doc: ${a.docSize} → ${b.docSize}  (${docRatio.toFixed(1)}×)   per-op ratio: ${opRatio.toFixed(2)}×`,
  );
}

console.log("");
const last = results[results.length - 1];
if (last.dt >= HARD_FAIL_MS) {
  console.error(`FAIL: ${last.totalOps} multi-cluster keystrokes took ${last.dt.toFixed(0)}ms`);
  process.exit(1);
}
if (last.dt >= SOFT_FAIL_MS) {
  console.warn(`SOFT-FAIL: ${last.totalOps} multi-cluster keystrokes took ${last.dt.toFixed(0)}ms`);
} else {
  console.log(`PASS: ${last.totalOps} multi-cluster keystrokes in ${last.dt.toFixed(0)}ms`);
}
