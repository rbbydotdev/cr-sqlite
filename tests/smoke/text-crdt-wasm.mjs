// Verifies the text-CRDT functions (crsql_as_text_crdt, fugue_insert/delete/render)
// are exposed in the freshly-built crsqlite.wasm artifact.

import "fake-indexeddb/auto";
import initWasm from "@vlcn.io/crsqlite-wasm";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const db = await sqlite.open(":memory:");
await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
await db.exec("SELECT crsql_as_crr('notes')");
await db.exec("SELECT crsql_as_text_crdt('notes', 'body')");
await db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
console.log("ok: setup");

// 1. Basic insertion
await db.exec("SELECT crsql_fugue_insert('notes','body',1,?,?)", [0, "hello"]);
let r = (await db.execA("SELECT crsql_fugue_render('notes','body',1)"))[0][0];
if (r !== "hello") fail(`expected 'hello', got ${r}`);
console.log("ok: insert 'hello' →", r);

await db.exec("SELECT crsql_fugue_insert('notes','body',1,?,?)", [5, " world"]);
r = (await db.execA("SELECT crsql_fugue_render('notes','body',1)"))[0][0];
if (r !== "hello world") fail(`expected 'hello world', got ${r}`);
console.log("ok: append → 'hello world'");

// 2. Mid-run insert
await db.exec("SELECT crsql_fugue_insert('notes','body',1,?,?)", [5, " GREAT"]);
r = (await db.execA("SELECT crsql_fugue_render('notes','body',1)"))[0][0];
if (r !== "hello GREAT world") fail(`mid-run: ${r}`);
console.log("ok: mid-run insert →", r);

// 3. Delete
await db.exec("SELECT crsql_fugue_delete('notes','body',1,?,?)", [5, 11]);
r = (await db.execA("SELECT crsql_fugue_render('notes','body',1)"))[0][0];
if (r !== "hello world") fail(`after delete: ${r}`);
console.log("ok: delete → 'hello world'");

// 4. Tombstoned column exists in the schema
const schema = (
  await db.execA("SELECT sql FROM sqlite_master WHERE name='__crsql_fugue_notes_body'")
)[0][0];
if (!schema.includes("tombstoned")) fail(`schema missing tombstoned column:\n${schema}`);
console.log("ok: tombstoned column present in WASM build");

await db.close();
console.log("\nPASS: text-CRDT verified in WASM build");
