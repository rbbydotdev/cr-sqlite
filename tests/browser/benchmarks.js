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

async function open(sqlite) {
  const db = await sqlite.open(":memory:");
  await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  await db.exec("SELECT crsql_as_crr('notes')");
  await db.exec("SELECT crsql_as_text_crdt('notes', 'body')");
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

async function smokeSanity(sqlite) {
  const db = await open(sqlite);
  await ins(db, 0, "hello");
  await ins(db, 5, " world");
  const b = await body(db);
  if (b !== "hello world") throw new Error(`smoke failed: ${b}`);
  return { rows: await rowCount(db), note: b };
}

async function benchAppends(sqlite, n) {
  const db = await open(sqlite);
  for (let i = 0; i < n; i++) await ins(db, i, "x");
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars` };
}

async function benchMidRun(sqlite, n) {
  const db = await open(sqlite);
  await ins(db, 0, "x".repeat(200));
  for (let i = 0; i < n; i++) {
    const len = (await body(db)).length;
    const pos = Math.floor(len / 2);
    await ins(db, pos, ".");
  }
  const b = await body(db);
  return { rows: await rowCount(db), note: `${b.length} chars` };
}

async function benchPaste(sqlite, size) {
  const db = await open(sqlite);
  await ins(db, 0, "x".repeat(size));
  const b = await body(db);
  const rows = await rowCount(db);
  return { rows, note: `${b.length} chars, ${rows} row(s)` };
}

async function benchDeletes(sqlite, n) {
  const db = await open(sqlite);
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

async function bench2PeerSync(sqlite, opsPerPeer) {
  const a = await open(sqlite);
  const b = await open(sqlite);
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

async function run() {
  $run.disabled = true;
  $results.innerHTML = "<p>initializing wasm…</p>";
  try {
    console.log("initializing wasm…");
    const sqlite = await initWasm((file) => `./dist/${file}`);
    console.log("wasm initialized");
    const benches = [
      ["smoke sanity (insert+append)", () => smokeSanity(sqlite)],
      ["100 appends", () => benchAppends(sqlite, 100)],
      ["10K-char single paste", () => benchPaste(sqlite, 10000)],
      ["200 deletes", () => benchDeletes(sqlite, 200)],
      ["100 mid-run inserts (O(n²))", () => benchMidRun(sqlite, 100)],
      ["2-peer sync 50 ops each + cleanup", () => bench2PeerSync(sqlite, 50)],
    ];
    const results = [];
    for (const [name, fn] of benches) {
      try {
        console.log(`running: ${name}`);
        const r = await bench(name, fn);
        console.log(`  → ${r.dt.toFixed(1)} ms / ${r.rows ?? "—"} rows / ${r.note}`);
        results.push(r);
      } catch (e) {
        console.log(`  → ERROR: ${e.message}`);
        results.push({ name, dt: 0, note: `ERROR: ${e.message}` });
      }
    }
    let html = `<table><thead><tr><th>scenario</th><th>time</th><th>rows</th><th>note</th></tr></thead><tbody>`;
    for (const r of results) html += rowHtml(r);
    html += `</tbody></table>`;
    $results.innerHTML = html;
    setStatus("done", true);
    // Expose results for Playwright to read
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
