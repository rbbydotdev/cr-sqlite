// Defer-by-default vs eager opt-in: same workload on two columns, one of each mode.
// Both must produce identical observable rendered output. Only the internal trigger work differs.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  return db;
}

function setup(db) {
  db.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body_defer TEXT, body_eager TEXT);
  `);
  db.prepare("SELECT crsql_as_crr('notes')").get();
  // body_defer: default = defer mode
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body_defer')").get();
  // body_eager: explicit eager=1
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body_eager', 1)").get();
  db.exec("INSERT INTO notes (id, body_defer, body_eager) VALUES (1, '', '')");
}

const renderD = (db) =>
  db.prepare("SELECT crsql_fugue_render('notes','body_defer',1)").pluck().get();
const renderE = (db) =>
  db.prepare("SELECT crsql_fugue_render('notes','body_eager',1)").pluck().get();
const matD = (db) => db.prepare("SELECT body_defer FROM notes WHERE id=1").pluck().get();
const matE = (db) => db.prepare("SELECT body_eager FROM notes WHERE id=1").pluck().get();
const insD = (db, p, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body_defer',1,?,?)").get(p, t);
const insE = (db, p, t) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body_eager',1,?,?)").get(p, t);
const delD = (db, f, t) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body_defer',1,?,?)").get(f, t);
const delE = (db, f, t) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body_eager',1,?,?)").get(f, t);

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const db = open();
setup(db);

// Apply the same operations to both columns; both must produce identical text.
const ops = [
  ["ins", 0, "hello"],
  ["ins", 5, " world"],
  ["ins", 5, " GREAT"],
  ["del", 5, 11],
  ["ins", 11, "!"],
  ["ins", 0, "Say: "],
  ["del", 4, 5],
];

for (const op of ops) {
  if (op[0] === "ins") {
    insD(db, op[1], op[2]);
    insE(db, op[1], op[2]);
  } else {
    delD(db, op[1], op[2]);
    delE(db, op[1], op[2]);
  }
  const rd = renderD(db);
  const re = renderE(db);
  if (rd !== re) fail(`render diverged after ${JSON.stringify(op)}: defer=${rd} eager=${re}`);
  const md = matD(db);
  const me = matE(db);
  // After a local fugue call, both modes should have the parent column updated.
  // Defer mode: the fugue function calls rerender at end.
  // Eager mode: triggers updated it during the call.
  if (md !== rd) fail(`defer materialized != render after ${JSON.stringify(op)}: mat=${md} render=${rd}`);
  if (me !== re) fail(`eager materialized != render after ${JSON.stringify(op)}: mat=${me} render=${re}`);
}

console.log("ok: defer + eager produce identical render after each op");
console.log(`  final defer render = ${JSON.stringify(renderD(db))}`);
console.log(`  final eager render = ${JSON.stringify(renderE(db))}`);

// Both modes auto-render on manual INSERT into the backing table (sync-apply path).
// Transparent (default): counter=0 → trigger WHEN clause passes → trigger fires.
// Eager: trigger always fires (no WHEN suppression).
// This is the key transparent-mode property: no client responsibility for flushing.
db.prepare(
  `INSERT INTO __crsql_fugue_notes_body_defer (row_pk, itemId, idx, content, parentItemId, parentIdx, tombstoned)
   VALUES (1, 'manual', 0, 'X', '', -2, 0)`,
).run();
db.prepare(
  `INSERT INTO __crsql_fugue_notes_body_eager (row_pk, itemId, idx, content, parentItemId, parentIdx, tombstoned)
   VALUES (1, 'manual', 0, 'X', '', -2, 0)`,
).run();

const eagerAfterManual = matE(db);
const eagerRenderAfterManual = renderE(db);
if (eagerAfterManual !== eagerRenderAfterManual)
  fail(
    `eager materialized stale after manual insert: mat=${eagerAfterManual} render=${eagerRenderAfterManual}`,
  );
console.log("ok: eager auto-renders on manual INSERT (sync-apply path)");

const deferAfterManual = matD(db);
const deferRenderAfterManual = renderD(db);
if (deferAfterManual !== deferRenderAfterManual)
  fail(
    `transparent mode failed sync-apply auto-render: mat=${JSON.stringify(deferAfterManual)} render=${JSON.stringify(deferRenderAfterManual)}`,
  );
console.log("ok: transparent (default) auto-renders on manual INSERT (no client flush needed)");

console.log("\nPASS: defer + eager modes verified equivalent");
