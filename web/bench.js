// fugue · in-browser benchmarks (matrix layout)
//
// Single table: rows = scenarios, columns = doc sizes, cells = per-op ms.
// One "run" button at the top runs the entire matrix sequentially. Cells
// flash as they complete and pick up color from soft/hard thresholds.
//
// Each cell opens a fresh in-memory DB so samples don't pollute each other.

import { initWasm } from "./vendor/loader.js";

const DOC_SIZES = [1_000, 5_000, 10_000, 50_000];

// Soft / hard per-op limits in milliseconds. Cells that exceed soft are
// tinted; cells that exceed hard are flagged red. These are deliberately
// generous since browser asyncify adds overhead vs the node smoke probes.
const SOFT_PER_OP_MS = 2.0;
const HARD_PER_OP_MS = 10.0;

// All scenarios share the same `run(docSize) -> { totalOps, total }` shape.
// We compute per-op = total / totalOps after the call.
const SCENARIOS = [
  {
    id: "append",
    label: "Sequential append",
    sub: "1000 keys at end-of-doc",
    keystrokes: 1000,
    run: async (db, docSize) => {
      const startPos = docSize;
      const keys = 1000;
      const t0 = performance.now();
      for (let i = 0; i < keys; i++) {
        await db.exec(`SELECT crsql_fugue_insert('notes','body',1,?,?)`, [startPos + i, "y"]);
      }
      return { total: performance.now() - t0, totalOps: keys };
    },
  },
  {
    id: "mid",
    label: "Mid-content typing",
    sub: "500 keys at doc/2 (cursor cache)",
    keystrokes: 500,
    run: async (db, docSize) => {
      const startPos = Math.floor(docSize / 2);
      const keys = 500;
      const t0 = performance.now();
      for (let i = 0; i < keys; i++) {
        await db.exec(`SELECT crsql_fugue_insert('notes','body',1,?,?)`, [startPos + i, "y"]);
      }
      return { total: performance.now() - t0, totalOps: keys };
    },
  },
  {
    id: "multi-4",
    label: "Multi-cluster (K=4)",
    sub: "4 regions × 20 rounds × 5 chars (LRU)",
    run: async (db, docSize) => runMultiCluster(db, docSize, 4, 20, 5),
  },
  {
    id: "multi-8",
    label: "Multi-cluster (K=8)",
    sub: "8 regions × 10 rounds × 5 chars (LRU)",
    run: async (db, docSize) => runMultiCluster(db, docSize, 8, 10, 5),
  },
  {
    id: "multi-16",
    label: "Multi-cluster (K=16)",
    sub: "16 regions × 5 rounds × 5 chars (LRU)",
    run: async (db, docSize) => runMultiCluster(db, docSize, 16, 5, 5),
  },
  // Bulk inserts — single UDF call inserts the whole block. Models agent
  // edits (e.g. replace 100 lines, paste a 1000-line file). Per-op here is
  // per-inserted-char, so it's directly comparable to interactive rows; the
  // sub-line shows the total call duration which is the answer to
  // "how long does the agent edit take?".
  {
    id: "bulk-1k",
    label: "Bulk insert (1k chars)",
    sub: "single call append · ~15 lines",
    run: async (db, docSize) => runBulkAppend(db, docSize, 1_000),
  },
  {
    id: "bulk-10k",
    label: "Bulk insert (10k chars)",
    sub: "single call append · ~150 lines",
    run: async (db, docSize) => runBulkAppend(db, docSize, 10_000),
  },
  {
    id: "bulk-100k",
    label: "Bulk insert (100k chars)",
    sub: "single call append · ~1500 lines",
    run: async (db, docSize) => runBulkAppend(db, docSize, 100_000),
  },
];

async function runBulkAppend(db, docSize, blockSize) {
  const block = "x".repeat(blockSize);
  const t0 = performance.now();
  await db.exec(`SELECT crsql_fugue_insert('notes','body',1,?,?)`, [docSize, block]);
  return { total: performance.now() - t0, totalOps: blockSize };
}

async function runMultiCluster(db, docSize, clusters, rounds, perVisit) {
  const cursors = new Array(clusters);
  for (let c = 0; c < clusters; c++) {
    cursors[c] = Math.floor(((c + 1) / (clusters + 1)) * docSize);
  }
  const totalOps = clusters * rounds * perVisit;
  const t0 = performance.now();
  for (let r = 0; r < rounds; r++) {
    for (let c = 0; c < clusters; c++) {
      for (let i = 0; i < perVisit; i++) {
        await db.exec(`SELECT crsql_fugue_insert('notes','body',1,?,?)`, [cursors[c], "y"]);
        cursors[c]++;
        for (let c2 = 0; c2 < clusters; c2++) {
          if (c2 !== c && cursors[c2] >= cursors[c] - 1) cursors[c2]++;
        }
      }
    }
  }
  return { total: performance.now() - t0, totalOps };
}

// ── engine wiring ────────────────────────────────────────────────────────

let sqlite = null;

const SETUP_SQL = [
  `CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)`,
  `SELECT crsql_as_crr('notes')`,
  `SELECT crsql_as_text_crdt('notes', 'body')`,
  `INSERT INTO notes (id, body) VALUES (1, '')`,
];

async function openDoc(docSize) {
  const db = await sqlite.open(":memory:");
  for (const stmt of SETUP_SQL) await db.exec(stmt);
  if (docSize > 0) {
    await db.exec(`SELECT crsql_fugue_insert('notes','body',1,?,?)`, [0, "x".repeat(docSize)]);
  }
  return db;
}

// ── matrix DOM ───────────────────────────────────────────────────────────

const matrixHead = document.getElementById("matrix-head");
const matrixBody = document.getElementById("matrix-body");
const runBtn = /** @type {HTMLButtonElement} */ (document.getElementById("run-btn"));
const bootDot = document.getElementById("boot-dot");
const bootMsg = document.getElementById("boot-msg");
const runInfo = document.getElementById("run-info");

function setBoot(state, msg) {
  bootDot.classList.remove("dot-pending", "dot-ok", "dot-fail");
  bootDot.classList.add(`dot-${state}`);
  bootMsg.textContent = msg;
}

function buildMatrix() {
  matrixHead.innerHTML = "";
  matrixBody.innerHTML = "";

  // header row: scenario column + one per doc size
  const thScen = document.createElement("th");
  thScen.className = "col-scenario";
  thScen.textContent = "scenario";
  matrixHead.appendChild(thScen);
  for (const n of DOC_SIZES) {
    const th = document.createElement("th");
    th.textContent = fmtDoc(n);
    matrixHead.appendChild(th);
  }

  // one row per scenario
  for (const sc of SCENARIOS) {
    const tr = document.createElement("tr");
    tr.dataset.scenario = sc.id;
    const tdLabel = document.createElement("td");
    tdLabel.className = "scenario";
    tdLabel.innerHTML = `${escape(sc.label)}<span class="sub">${escape(sc.sub)}</span>`;
    tr.appendChild(tdLabel);
    for (const n of DOC_SIZES) {
      const td = document.createElement("td");
      td.className = "cell idle";
      td.dataset.docSize = String(n);
      td.innerHTML = `<span class="v">—</span>`;
      tr.appendChild(td);
    }
    matrixBody.appendChild(tr);
  }

  // ratio footer: per-column ratio vs the smallest doc size in each row
  const ratioRow = document.createElement("tr");
  ratioRow.className = "ratio-row";
  const tdR0 = document.createElement("td");
  tdR0.className = "scenario";
  tdR0.textContent = "col scaling (per-op)";
  ratioRow.appendChild(tdR0);
  for (const n of DOC_SIZES) {
    const td = document.createElement("td");
    td.dataset.docSize = String(n);
    td.textContent = "—";
    ratioRow.appendChild(td);
  }
  matrixBody.appendChild(ratioRow);
}

function getCell(scenarioId, docSize) {
  const row = matrixBody.querySelector(`tr[data-scenario="${scenarioId}"]`);
  if (!row) return null;
  return row.querySelector(`td.cell[data-doc-size="${docSize}"]`);
}

function setCell(cell, state, value, sub) {
  cell.classList.remove("idle", "running", "pass", "soft", "fail", "error");
  cell.classList.add(state);
  cell.innerHTML = "";
  const v = document.createElement("span");
  v.className = "v";
  v.textContent = value;
  cell.appendChild(v);
  if (state === "pass" || state === "soft" || state === "fail") {
    const u = document.createElement("span");
    u.className = "u";
    u.textContent = "ms";
    cell.appendChild(u);
  }
  if (sub) {
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = sub;
    cell.appendChild(s);
  }
  // flash
  cell.classList.remove("flash");
  void cell.offsetWidth;
  cell.classList.add("flash");
}

function updateRatios() {
  const ratioRow = matrixBody.querySelector("tr.ratio-row");
  if (!ratioRow) return;
  // Per-column ratio: median per-op across scenarios for this doc size,
  // divided by median for the first doc size. We just use first-row
  // (append) per-op as a stable anchor: cells store result on dataset.perOp.
  const cells = ratioRow.querySelectorAll("td[data-doc-size]");
  // gather per-op per docSize, averaged across scenarios
  const avgByDoc = new Map();
  for (const n of DOC_SIZES) {
    const vals = [];
    for (const sc of SCENARIOS) {
      const c = getCell(sc.id, n);
      const v = c?.dataset?.perOp;
      if (v != null && v !== "") vals.push(Number(v));
    }
    if (vals.length) {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      avgByDoc.set(n, mean);
    }
  }
  const base = avgByDoc.get(DOC_SIZES[0]);
  cells.forEach((td) => {
    const n = Number(td.dataset.docSize);
    const v = avgByDoc.get(n);
    if (v == null || base == null) {
      td.textContent = "—";
      td.classList.remove("ratio-ok", "ratio-warn");
      return;
    }
    const ratio = v / base;
    td.textContent = `${ratio.toFixed(2)}×`;
    td.classList.toggle("ratio-ok", ratio < 1.5);
    td.classList.toggle("ratio-warn", ratio >= 1.5);
  });
}

// ── run loop ─────────────────────────────────────────────────────────────

let running = false;

async function runMatrix() {
  if (running) return;
  running = true;
  runBtn.disabled = true;

  // reset every cell to idle
  for (const sc of SCENARIOS) {
    for (const n of DOC_SIZES) {
      const c = getCell(sc.id, n);
      delete c.dataset.perOp;
      setCell(c, "idle", "—");
    }
  }
  updateRatios();

  const total = SCENARIOS.length * DOC_SIZES.length;
  let done = 0;
  const tStart = performance.now();
  runInfo.textContent = `0 / ${total}`;
  setBoot("pending", "running benchmarks…");

  for (const sc of SCENARIOS) {
    for (const n of DOC_SIZES) {
      const cell = getCell(sc.id, n);
      setCell(cell, "running", "…");
      runInfo.textContent = `${done} / ${total}  ·  ${sc.label} @ ${fmtDoc(n)}`;
      // let the browser paint between cells
      await new Promise((r) => requestAnimationFrame(r));

      let result;
      const db = await openDoc(n);
      try {
        result = await sc.run(db, n);
      } catch (err) {
        console.error(`${sc.id} @ ${n} failed:`, err);
        setCell(cell, "error", "err", err?.message?.slice(0, 24) ?? "");
        await db.close().catch(() => {});
        done++;
        continue;
      }
      await db.close().catch(() => {});

      const perOp = result.total / result.totalOps;
      cell.dataset.perOp = String(perOp);
      const state = perOp >= HARD_PER_OP_MS ? "fail" : perOp >= SOFT_PER_OP_MS ? "soft" : "pass";
      setCell(cell, state, fmtPerOp(perOp), `${fmtMs(result.total)}ms · ${fmtInt(result.totalOps)} ops`);
      done++;
      updateRatios();
    }
  }

  const elapsed = (performance.now() - tStart) / 1000;
  runInfo.textContent = `done · ${total} cells · ${elapsed.toFixed(1)}s`;
  setBoot("ok", "wasm loaded — engine ready");
  running = false;
  runBtn.disabled = false;
}

// ── formatters ────────────────────────────────────────────────────────────

function fmtDoc(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k chars`;
  return `${n} chars`;
}
function fmtInt(n) {
  return Number(n).toLocaleString();
}
function fmtMs(n) {
  return n >= 100 ? n.toFixed(0) : n.toFixed(1);
}
function fmtPerOp(n) {
  if (n >= 10) return n.toFixed(2);
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(5);
}
function escape(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));
}

// ── boot ──────────────────────────────────────────────────────────────────

async function boot() {
  setBoot("pending", "loading wasm…");
  buildMatrix();
  try {
    sqlite = await initWasm((file) => `./vendor/${file}`);
  } catch (err) {
    setBoot("fail", `wasm load failed: ${err?.message ?? err}`);
    throw err;
  }
  // tiny self-check
  try {
    const probe = await sqlite.open(":memory:");
    for (const s of SETUP_SQL) await probe.exec(s);
    await probe.execA(`SELECT crsql_fugue_render('notes','body',1)`);
    await probe.close();
  } catch (err) {
    setBoot("fail", `engine self-check failed: ${err?.message ?? err}`);
    throw err;
  }
  setBoot("ok", "wasm loaded — engine ready");
  runBtn.disabled = false;
}

runBtn.addEventListener("click", runMatrix);

boot().catch((e) => {
  console.error("bench boot failed:", e);
});
