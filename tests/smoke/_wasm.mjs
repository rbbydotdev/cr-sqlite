// Node test harness over the browser's WASM build.
//
// Same crsqlite.wasm that web/rich.html loads. Verifies the binary
// users actually run, not a parallel native dylib. Pre-reads the wasm
// off disk and hands it to emscripten as `wasmBinary` so we don't hit
// the URL-vs-path fetch confusion in Node.

import { initWasm } from "../../web/vendor/loader.js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(__dirname, "../../web/vendor");

let _sqlite = null;

export async function getSqlite() {
  if (_sqlite) return _sqlite;
  const wasmBinary = await readFile(path.join(VENDOR, "crsqlite.wasm"));
  _sqlite = await initWasm(() => "", { wasmBinary });
  return _sqlite;
}

export async function openPeer() {
  const sqlite = await getSqlite();
  const db = await sqlite.open(":memory:");
  await db.exec("SELECT crsql_doc_init()");
  return db;
}

export async function siteId(db) {
  const r = await db.execA("SELECT lower(hex(crsql_site_id()))");
  return r[0][0];
}

export async function syncPair(a, b) {
  const aSite = await siteId(a);
  const bSite = await siteId(b);
  const aToB = await a.execA(
    `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
     FROM crsql_changes WHERE site_id IS NOT ?`,
    [hexToBytes(bSite)],
  );
  const bToA = await b.execA(
    `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
     FROM crsql_changes WHERE site_id IS NOT ?`,
    [hexToBytes(aSite)],
  );
  await applyChanges(b, aToB);
  await applyChanges(a, bToA);
}

async function applyChanges(db, rows) {
  for (const r of rows) {
    await db.exec(
      `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r,
    );
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export const applyTree = (db, tree) =>
  db.exec("SELECT crsql_doc_apply(?)", [JSON.stringify(tree)]);

export const render = async (db) =>
  JSON.parse((await db.execA("SELECT crsql_doc_render()"))[0][0]);

export const plain = (block) =>
  (block.spans ?? []).map((s) => s.text ?? "").join("");

// Find a span by predicate within a block; null if none.
export const findSpan = (block, pred) =>
  (block.spans ?? []).find(pred) ?? null;
