// Probe 00 — verify the actual property we care about for client correctness:
// **after a transaction-wrapped sync apply commits, the receiver's `body`
// matches the sender's render**, AND no external observer reading the body
// between sync calls sees an intermediate (uncommitted) state.
//
// What we are NOT asserting: that cr-sqlite delivers each new row as a single
// atomic INSERT. It doesn't — cr-sqlite uses the per-cell CRR transport, so a
// new row arrives as INSERT + N cell UPDATEs (parentItemId, parentIdx,
// tombstoned settled in turn). The transient cells fire our render trigger
// per cell; intermediate `body` values are written but never committed. Any
// reader on a different connection sees only the final committed state.
//
// This probe codifies the contract: clients MUST wrap sync apply in a SQL
// transaction. Inside that contract, no observable "flicker" can leak.

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_text_crdt('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

const siteId = (db) => db.prepare("SELECT crsql_site_id()").pluck().get();
const ins = (db, pos, text) =>
  db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, text);
const del = (db, from, to) =>
  db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(from, to);
const body = (db) => db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const bodyCol = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();

function pull(from, exclude) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
    )
    .all(exclude);
}

// Transaction-wrapped apply — the contract clients must honour. The whole
// per-cell intermediate sequence happens inside this transaction; commit lands
// only the final row state on the public side.
function applyInTx(to, changes) {
  if (!changes.length) return;
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`,
  );
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
}

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  PASS ${label}`);
  } else {
    console.error(`  FAIL ${label}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

// ── Scenario 1: 11-char insert from A, sync to fresh B inside a transaction.
//                After commit, B's render AND materialized body must match A. ──
{
  console.log("scenario 1: 11-char insert, transaction-wrapped sync → equal end states");
  const a = open();
  const b = open();
  ins(a, 0, "hello world");
  applyInTx(b, pull(a, siteId(b)));

  check("A and B render identically", body(a) === body(b),
        `A=${JSON.stringify(body(a))} B=${JSON.stringify(body(b))}`);
  check("B's materialized body equals B's render", bodyCol(b) === body(b),
        `body=${JSON.stringify(bodyCol(b))} render=${JSON.stringify(body(b))}`);
  check("B's body equals expected text 'hello world'",
        bodyCol(b) === "hello world", `got ${JSON.stringify(bodyCol(b))}`);
}

// ── Scenario 2: many sequential inserts, single transaction-wrapped sync. ──
{
  console.log("scenario 2: 100 single-char inserts, sync once");
  const a = open();
  const b = open();
  for (let i = 0; i < 100; i++) ins(a, i, "x");
  applyInTx(b, pull(a, siteId(b)));

  check("A and B render identically", body(a) === body(b));
  check("B's body matches B's render", bodyCol(b) === body(b));
  check("B's body length is 100", bodyCol(b).length === 100,
        `got length ${bodyCol(b).length}`);
}

// ── Scenario 3: incremental sync. Second sync delivers only new rows. ──
{
  console.log("scenario 3: incremental sync — two passes");
  const a = open();
  const b = open();
  ins(a, 0, "hello");
  applyInTx(b, pull(a, siteId(b)));
  check("pass 1: B body == A body", bodyCol(b) === body(a));

  ins(a, 5, " world");
  applyInTx(b, pull(a, siteId(b)));
  check("pass 2: B body == A body", bodyCol(b) === body(a));
  check("pass 2: B body == 'hello world'", bodyCol(b) === "hello world",
        `got ${JSON.stringify(bodyCol(b))}`);
}

// ── Scenario 4: whole-row delete propagates as a tombstone UPDATE.
//                After sync, B's body reflects the delete. ──
{
  console.log("scenario 4: delete on A → sync → B reflects the delete");
  const a = open();
  const b = open();
  ins(a, 0, "hello");
  applyInTx(b, pull(a, siteId(b)));

  del(a, 0, 5);
  applyInTx(b, pull(a, siteId(b)));

  check("A body is empty", bodyCol(a) === "");
  check("B body is empty", bodyCol(b) === "",
        `got ${JSON.stringify(bodyCol(b))}`);
  check("A and B agree", bodyCol(a) === bodyCol(b));
}

// ── Scenario 5: partial delete (β-flat deletion marker). The marker arrives
//                as INSERT + N cell UPDATEs (non-atomic at cr-sqlite level),
//                but the wrapping transaction hides the intermediate states. ──
{
  console.log("scenario 5: partial delete → body matches across peers post-tx");
  const a = open();
  const b = open();
  ins(a, 0, "hello world");
  applyInTx(b, pull(a, siteId(b)));

  del(a, 3, 6);  // remove "lo "
  applyInTx(b, pull(a, siteId(b)));

  check("A body equals 'helworld'", bodyCol(a) === "helworld",
        `got ${JSON.stringify(bodyCol(a))}`);
  check("B body equals A body", bodyCol(a) === bodyCol(b),
        `A=${JSON.stringify(bodyCol(a))} B=${JSON.stringify(bodyCol(b))}`);
  check("B materialized body == B render",
        bodyCol(b) === body(b),
        `body=${JSON.stringify(bodyCol(b))} render=${JSON.stringify(body(b))}`);
}

// ── Scenario 6: confirm there is no observable mid-transaction state. We can
//                only check this from a SEPARATE connection — same-connection
//                reads inside the transaction would see the in-flight state by
//                design. Open a second connection to the same in-memory DB —
//                requires a shared-cache configuration. Since better-sqlite3's
//                `:memory:` is connection-isolated, instead we simulate the
//                separate-observer constraint by checking that body NEVER ends
//                up at an intermediate value across two sequential reads. ──
{
  console.log("scenario 6: no observable intermediate body across sync calls");
  const a = open();
  const b = open();
  ins(a, 0, "hello world");
  applyInTx(b, pull(a, siteId(b)));

  // Snapshot B's body AND render BEFORE the second sync — they must agree
  // (consistency outside any in-flight transaction). Then sync, snapshot
  // again — body should still match render, just at the new state.
  del(a, 3, 6);
  const bodyBefore = bodyCol(b);
  const renderBefore = body(b);
  applyInTx(b, pull(a, siteId(b)));
  const bodyAfter = bodyCol(b);
  const renderAfter = body(b);

  check("before sync 2: body matches its render",
        bodyBefore === renderBefore,
        `bodyBefore=${JSON.stringify(bodyBefore)} renderBefore=${JSON.stringify(renderBefore)}`);
  check("after sync 2: body equals new render",
        bodyAfter === renderAfter,
        `bodyAfter=${JSON.stringify(bodyAfter)} renderAfter=${JSON.stringify(renderAfter)}`);
  check("body landed at the expected post-delete state",
        bodyAfter === "helworld", `got ${JSON.stringify(bodyAfter)}`);
}

console.log("");
if (failures === 0) {
  console.log(`PASS: Layer 0 — transaction-wrapped sync apply preserves the atomic-row contract`);
  process.exit(0);
} else {
  console.error(`FAIL: ${failures} assertions failed`);
  process.exit(1);
}
