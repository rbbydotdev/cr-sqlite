// WASM mirror of sync-two-nodes.mjs.
// Runs the same two-node CRR sync test but against the pre-built @vlcn.io/crsqlite-wasm,
// proving cr-sqlite-in-WASM works in our stack. Does NOT include our cherry-picked PRs —
// that requires rebuilding the .wasm from our fork-baseline.

import "fake-indexeddb/auto"; // crsqlite-wasm registers an IDB-backed VFS at init; Node has no IDB.
import initWasm from "@vlcn.io/crsqlite-wasm";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// crsqlite-wasm uses fetch() to load the .wasm; Node's fetch doesn't accept file://.
// Monkey-patch global.fetch to serve file:// URLs from disk for this run.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("file://")) {
    const filePath = fileURLToPath(url);
    const bytes = await readFile(filePath);
    return new Response(bytes, { headers: { "Content-Type": "application/wasm" } });
  }
  return originalFetch(input, init);
};

const wasmPath = path.resolve(
  __dirname,
  "../node_modules/@vlcn.io/crsqlite-wasm/dist/crsqlite.wasm",
);
const wasmUrl = `file://${wasmPath}`;

const sqlite = await initWasm(() => wasmUrl);

async function open() {
  const db = await sqlite.open(":memory:");
  return db;
}

async function setupSchema(db) {
  await db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, title TEXT, body TEXT);`);
  await db.exec(`SELECT crsql_as_crr('notes')`);
}

async function siteId(db) {
  const rows = await db.execA(`SELECT quote(crsql_site_id())`);
  return rows[0][0];
}

async function pullSince(db, since, excludeSite) {
  // execA returns arrays. crsql_changes columns order: table, pk, cid, val, col_version, db_version, site_id, cl, seq
  const sql = `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
               FROM crsql_changes
               WHERE db_version > ?
                 AND site_id IS NOT ?`;
  return await db.execA(sql, [since, excludeSite]);
}

async function apply(db, rows) {
  if (rows.length === 0) return;
  const sql = `INSERT INTO crsql_changes
               ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (const r of rows) await db.exec(sql, r);
}

async function dump(db, label) {
  const rows = await db.execO(`SELECT * FROM notes ORDER BY id`);
  console.log(`${label}:`, rows);
  return rows;
}

const db1 = await open();
const db2 = await open();
await setupSchema(db1);
await setupSchema(db2);

const s1 = await siteId(db1);
const s2 = await siteId(db2);
console.log("db1 site:", s1);
console.log("db2 site:", s2);

await db1.exec(`INSERT INTO notes (id, title, body) VALUES (1, 'from db1', 'hello')`);
await db2.exec(`INSERT INTO notes (id, title, body) VALUES (2, 'from db2', 'world')`);

// In the changes vtab, site_id is the raw blob; quote() above wraps it as X'...'. Need the raw value.
async function siteIdRaw(db) {
  const rows = await db.execA(`SELECT crsql_site_id()`);
  return rows[0][0];
}
const r1 = await siteIdRaw(db1);
const r2 = await siteIdRaw(db2);

const c1to2 = await pullSince(db1, 0, r2);
const c2to1 = await pullSince(db2, 0, r1);
console.log(`pulled ${c1to2.length} from db1, ${c2to1.length} from db2`);

await apply(db2, c1to2);
await apply(db1, c2to1);

const rows1 = await dump(db1, "db1 after sync");
const rows2 = await dump(db2, "db2 after sync");

const j1 = JSON.stringify(rows1);
const j2 = JSON.stringify(rows2);
if (j1 !== j2) {
  console.error("FAIL: databases did not converge");
  process.exit(1);
}
if (rows1.length !== 2) {
  console.error(`FAIL: expected 2 rows after sync, got ${rows1.length}`);
  process.exit(1);
}
console.log("PASS: two-node CRR sync converged (WASM)");

await db1.close();
await db2.close();
