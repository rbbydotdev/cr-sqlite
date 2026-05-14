// Smoke: two in-process cr-sqlite DBs, divergent writes, exchange changes, verify convergence.
// Run with `pnpm smoke` (or `node smoke/sync-two-nodes.mjs`) from tests/.
// Requires the native loadable built at ../core/dist/crsqlite.dylib (.so on linux, .dll on win).

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

function setupSchema(db) {
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, title TEXT, body TEXT);`);
  db.prepare("SELECT crsql_as_crr('notes')").get();
}

function siteId(db) {
  return db.prepare("SELECT quote(crsql_site_id())").pluck().get();
}

function pullSince(db, since, excludeSite) {
  return db
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes
       WHERE db_version > ?
         AND site_id IS NOT ?`,
    )
    .all(since, excludeSite);
}

function apply(db, changes) {
  const stmt = db.prepare(
    `INSERT INTO crsql_changes
       ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
       VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  const tx = db.transaction((rows) => rows.forEach((r) => stmt.run(r)));
  tx(changes);
}

function dump(db, label) {
  const rows = db.prepare("SELECT * FROM notes ORDER BY id").all();
  console.log(`${label}:`, rows);
  return rows;
}

const db1 = open();
const db2 = open();
setupSchema(db1);
setupSchema(db2);

console.log("db1 site:", siteId(db1));
console.log("db2 site:", siteId(db2));

db1.exec(`INSERT INTO notes (id, title, body) VALUES (1, 'from db1', 'hello')`);
db2.exec(`INSERT INTO notes (id, title, body) VALUES (2, 'from db2', 'world')`);

const c1to2 = pullSince(db1, 0, siteId(db2).replace(/^X'/, "x'"));
const c2to1 = pullSince(db2, 0, siteId(db1).replace(/^X'/, "x'"));
console.log(`pulled ${c1to2.length} from db1, ${c2to1.length} from db2`);

apply(db2, c1to2);
apply(db1, c2to1);

const r1 = dump(db1, "db1 after sync");
const r2 = dump(db2, "db2 after sync");

const s1 = JSON.stringify(r1);
const s2 = JSON.stringify(r2);
if (s1 !== s2) {
  console.error("FAIL: databases did not converge");
  process.exit(1);
}
if (r1.length !== 2) {
  console.error(`FAIL: expected 2 rows after sync, got ${r1.length}`);
  process.exit(1);
}
console.log("PASS: two-node CRR sync converged");
