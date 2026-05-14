// Browser benchmarks for the freshly-built crsqlite.wasm (from our fork).
//
// The page loads @vlcn.io/crsqlite-wasm structure but is pointed at OUR built artifact
// (../../../vlcn-js/packages/crsqlite-wasm/dist/crsqlite.wasm) via the locateWasm callback.
//
// Scenarios:
//   1. Phase smokes — sanity that text-CRDT works in browser at all
//   2. 1K end-of-doc appends (Case-2 path; row count grows linearly)
//   3. 1K mid-run inserts (each insert splits a run — worst case for current code)
//   4. 10K-char single paste (should be 1 row)
//   5. 1K deletes
//   6. 2-peer sync with 100 ops each + cleanup

import initWasm from "@vlcn.io/crsqlite-wasm";

const $status = document.getElementById("status");
const $results = document.getElementById("results");
const $run = document.getElementById("run");

function setStatus(msg, ok = true) {
  $status.textContent = msg;
  $status.className = ok ? "ok" : "err";
}

function rowHtml(r) {
  return `<tr><td>${r.name}</td><td>${r.dt.toFixed(1)} ms</td><td>${r.rows ?? "—"}</td><td>${r.note ?? ""}</td></tr>`;
}

async function open(sqlite, { eager = false } = {}) {
  const db = await sqlite.open(":memory:");
  await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  await db.exec("SELECT crsql_as_crr('notes')");
  // eager=0 (default) → defer; eager=1 → per-row triggers
  await db.exec(`SELECT crsql_as_text_crdt('notes', 'body', ${eager ? 1 : 0})`);
  await db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}
async function body(db) {
  return (await db.execA("SELECT crsql_fugue_render('notes','body',1)"))[0][0];
}
async function rowCount(db) {
  return (await db.execA("SELECT count(*) FROM __crsql_fugue_notes_body WHERE row_pk=1"))[0][0];
}
async function ins(db, pos, t) {
  await db.exec("SELECT crsql_fugue_insert('notes','body',1,?,?)", [pos, t]);
}
async function del(db, from, to) {
  await db.exec("SELECT crsql_fugue_delete('notes','body',1,?,?)", [from, to]);
}
async function cleanup(db) {
  await db.exec("SELECT crsql_fugue_cleanup('notes','body',1)");
}
async function siteId(db) {
  return (await db.execA("SELECT crsql_site_id()"))[0][0];
}
async function pull(from, excludeSiteId) {
  return await from.execA(
    `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
     FROM crsql_changes WHERE site_id IS NOT ?`,
    [excludeSiteId],
  );
}
async function apply(to, changes) {
  if (!changes.length) return;
  await to.tx(async (tx) => {
    for (const c of changes) {
      await tx.exec(
        `INSERT INTO crsql_changes
         ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        c,
      );
    }
  });
}

async function bench(name, fn) {
  setStatus(`running: ${name}…`);
  const t0 = performance.now();
  const out = await fn();
  const dt = performance.now() - t0;
  return { name, dt, ...out };
}

async function smokeSanity(sqlite, opts) {
  const db = await open(sqlite, opts);
  await ins(db, 0, "hello");
  await ins(db, 5, " world");
  const b = await body(db);
  if (b !== "hello world") throw new Error(`smoke failed: ${b}`);
  return { rows: await rowCount(db), note: b };
}

async function benchAppends(sqlite, n, opts) {
  const db = await open(sqlite, opts);
  for (let i = 0; i < n; i++) await ins(db, i, "x");
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars` };
}

async function benchMidRun(sqlite, n, opts) {
  const db = await open(sqlite, opts);
  await ins(db, 0, "x".repeat(200));
  for (let i = 0; i < n; i++) {
    const len = (await body(db)).length;
    const pos = Math.floor(len / 2);
    await ins(db, pos, ".");
  }
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars` };
}

async function benchPaste(sqlite, size, opts) {
  const db = await open(sqlite, opts);
  await ins(db, 0, "x".repeat(size));
  const b = await body(db);
  const rows = await rowCount(db);
  return { rows, note: `${b.length} chars, ${rows} row(s)` };
}

async function benchDeletes(sqlite, n, opts) {
  const db = await open(sqlite, opts);
  await ins(db, 0, "x".repeat(n * 2));
  for (let i = 0; i < n; i++) {
    const len = (await body(db)).length;
    if (len === 0) break;
    const pos = Math.floor(len / 2);
    await del(db, pos, pos + 1);
  }
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars left` };
}

// --- Tombstone-stress scenarios for benchmarking coalescing optimization ---

async function benchTypeBackspace(sqlite, n, opts) {
  // Type n chars then backspace all n. Creates n adjacent tombstones.
  const db = await open(sqlite, opts);
  await ins(db, 0, "x".repeat(n));
  for (let i = 0; i < n; i++) {
    const len = (await body(db)).length;
    if (len === 0) break;
    await del(db, len - 1, len);
  }
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars (should be 0)` };
}

async function benchBigRangeDelete(sqlite, size, opts) {
  // Insert size chars, then delete the middle half in ONE op (vs many).
  const db = await open(sqlite, opts);
  await ins(db, 0, "x".repeat(size));
  const len = (await body(db)).length;
  await del(db, Math.floor(len / 4), Math.floor((3 * len) / 4));
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars left` };
}

async function benchEditChurn(sqlite, n, opts) {
  // Insert + delete + insert in a tight cycle at random positions.
  // Stresses cleanup + tombstone management.
  const db = await open(sqlite, opts);
  await ins(db, 0, "x".repeat(50));
  for (let i = 0; i < n; i++) {
    const len = (await body(db)).length;
    if (len === 0) break;
    const pos = Math.floor(Math.random() * len);
    if (Math.random() < 0.5) await ins(db, pos, ".");
    else await del(db, pos, Math.min(pos + 1, len));
  }
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars after churn` };
}

async function bench2PeerSync(sqlite, opsPerPeer, opts) {
  const a = await open(sqlite, opts);
  const b = await open(sqlite, opts);
  await ins(a, 0, "shared text");
  await apply(b, await pull(a, await siteId(b)));
  await cleanup(b);
  for (let i = 0; i < opsPerPeer; i++) {
    const lenA = (await body(a)).length;
    if (lenA > 0) {
      const pos = Math.floor(Math.random() * lenA);
      if (Math.random() < 0.5) await ins(a, pos, ".");
      else await del(a, pos, pos + 1);
    } else {
      await ins(a, 0, "x");
    }
    const lenB = (await body(b)).length;
    if (lenB > 0) {
      const pos = Math.floor(Math.random() * lenB);
      if (Math.random() < 0.5) await ins(b, pos, "_");
      else await del(b, pos, pos + 1);
    } else {
      await ins(b, 0, "y");
    }
  }
  const sB = await siteId(b);
  const sA = await siteId(a);
  await apply(b, await pull(a, sB));
  await apply(a, await pull(b, sA));
  await cleanup(a);
  await cleanup(b);
  const bodyA = await body(a);
  const bodyB = await body(b);
  if (bodyA !== bodyB) throw new Error(`DIVERGED: ${bodyA} vs ${bodyB}`);
  return { rows: await rowCount(a), note: `${bodyA.length} chars, converged` };
}

// Run a scenario N times, return median dt and min/max for noise visibility.
async function benchN(name, fn, runs = 3) {
  const dts = [];
  let lastResult = null;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    lastResult = await fn();
    const dt = performance.now() - t0;
    dts.push(dt);
  }
  dts.sort((a, b) => a - b);
  const median = dts[Math.floor(dts.length / 2)];
  const min = dts[0];
  const max = dts[dts.length - 1];
  return { name, dt: median, min, max, rows: lastResult?.rows, note: lastResult?.note ?? "" };
}

function rowHtmlMulti(r) {
  const range = r.min !== undefined ? `${r.min.toFixed(0)}–${r.max.toFixed(0)}` : "—";
  return `<tr><td>${r.name}</td><td>${r.dt.toFixed(1)} ms</td><td>${range}</td><td>${r.rows ?? "—"}</td><td>${r.note ?? ""}</td></tr>`;
}

async function run() {
  $run.disabled = true;
  $results.innerHTML = "<p>initializing wasm…</p>";
  try {
    console.log("initializing wasm…");
    const sqlite = await initWasm((file) => `./dist/${file}`);
    console.log("wasm initialized");
    const RUNS = 3;
    const benches = [
      ["smoke sanity (defer)", () => smokeSanity(sqlite)],
      ["smoke sanity (eager)", () => smokeSanity(sqlite, { eager: true })],
      ["100 appends (defer)", () => benchAppends(sqlite, 100)],
      ["100 appends (eager)", () => benchAppends(sqlite, 100, { eager: true })],
      ["10K paste (defer)", () => benchPaste(sqlite, 10000)],
      ["10K paste (eager)", () => benchPaste(sqlite, 10000, { eager: true })],
      ["200 deletes (defer)", () => benchDeletes(sqlite, 200)],
      ["200 deletes (eager)", () => benchDeletes(sqlite, 200, { eager: true })],
      ["100 mid-run inserts (defer)", () => benchMidRun(sqlite, 100)],
      ["100 mid-run inserts (eager)", () => benchMidRun(sqlite, 100, { eager: true })],
      ["type+backspace 100 (defer)", () => benchTypeBackspace(sqlite, 100)],
      ["type+backspace 100 (eager)", () => benchTypeBackspace(sqlite, 100, { eager: true })],
      ["1K big-range delete (defer)", () => benchBigRangeDelete(sqlite, 1000)],
      ["1K big-range delete (eager)", () => benchBigRangeDelete(sqlite, 1000, { eager: true })],
      ["100 churn ops (defer)", () => benchEditChurn(sqlite, 100)],
      ["100 churn ops (eager)", () => benchEditChurn(sqlite, 100, { eager: true })],
      ["2-peer sync 50 ops (defer)", () => bench2PeerSync(sqlite, 50)],
      ["2-peer sync 50 ops (eager)", () => bench2PeerSync(sqlite, 50, { eager: true })],
    ];
    const results = [];
    for (const [name, fn] of benches) {
      try {
        console.log(`running: ${name} (×${RUNS})`);
        const r = await benchN(name, fn, RUNS);
        console.log(
          `  → median ${r.dt.toFixed(1)} ms (range ${r.min.toFixed(0)}–${r.max.toFixed(0)}) / ${r.rows ?? "—"} rows / ${r.note}`,
        );
        results.push(r);
      } catch (e) {
        console.log(`  → ERROR: ${e.message}`);
        results.push({ name, dt: 0, note: `ERROR: ${e.message}` });
      }
    }
    let html = `<table><thead><tr><th>scenario</th><th>median</th><th>min–max</th><th>rows</th><th>note</th></tr></thead><tbody>`;
    for (const r of results) html += rowHtmlMulti(r);
    html += `</tbody></table>`;
    $results.innerHTML = html;
    setStatus("done", true);
    window.__BENCH_RESULTS__ = results;
  } catch (e) {
    $results.innerHTML = `<pre class="err">${e.stack || e.message}</pre>`;
    setStatus(`failed: ${e.message}`, false);
  } finally {
    $run.disabled = false;
  }
}

$run.addEventListener("click", run);
// Auto-run on load for unattended test usage
window.addEventListener("load", () => run());
