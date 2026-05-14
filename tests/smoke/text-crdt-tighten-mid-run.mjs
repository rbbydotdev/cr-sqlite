// Verifies mid-run insert: inserting at a position strictly inside a run
// now splits the run and lands the new content at the correct rendered offset.

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

const setup = (db) => {
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
};
const body = (db) => db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const ins = (db, pos, t) => db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);

function expect(label, db, want) {
  const got = body(db);
  if (got !== want) {
    console.error(`FAIL ${label}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    process.exit(1);
  }
  console.log(`ok ${label}: ${JSON.stringify(got)}`);
}

// Each sub-test in its own DB to keep tree state isolated.
{
  const db = open();
  setup(db);
  ins(db, 0, "hello");
  ins(db, 3, "X");
  expect("ins at 3 of 'hello'", db, "helXlo");
}

{
  const db = open();
  setup(db);
  ins(db, 0, "hello");
  ins(db, 1, "X");
  expect("ins at 1 of 'hello'", db, "hXello");
}

{
  const db = open();
  setup(db);
  ins(db, 0, "hello");
  ins(db, 4, "X");
  expect("ins at 4 of 'hello'", db, "hellXo");
}

{
  const db = open();
  setup(db);
  ins(db, 0, "abcdefghij");
  ins(db, 5, "_MIDDLE_");
  expect("ins at 5 of 10-char run", db, "abcde_MIDDLE_fghij");
}

// Multi-mid-run sequence
{
  const db = open();
  setup(db);
  ins(db, 0, "hello world");
  ins(db, 5, ",");        // → "hello, world"
  expect("comma after 'hello'", db, "hello, world");
  ins(db, 12, "!");       // → "hello, world!"
  expect("append exclam", db, "hello, world!");
  ins(db, 1, "EE");       // → "hEEello, world!"
  expect("ins at 1", db, "hEEello, world!");
}

console.log("\nPASS: mid-run insert tightened");
