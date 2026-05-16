// Property fuzz for the Peritext primitive.
//
// Random sequences of typed edits + mark/unmark ops across N peers with
// random offline/online transitions. After bringing everyone online and
// syncing to a fixed point, invariant: all peers' body JSON must be
// byte-identical. Bounded doc size and mark name set so failures are
// shrinkable by hand from the trace.
//
// Knobs (env):
//   SEED  — int seed; default Date.now()
//   ITER  — fuzz iterations; default 200
//   PEERS — fixed peer count; default 2-3 random
//   VERB  — set to 1 to log every iteration

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SIDE_BEFORE = 0;
const SIDE_AFTER = 1;
const MARK_NAMES = ["bold", "italic", "link"];
const ALPHABET = "abcdefg";

const SEED_BASE = process.env.SEED ? Number(process.env.SEED) : Date.now();
const ITERATIONS = Number(process.env.ITER ?? 200);
const FIXED_PEERS = process.env.PEERS ? Number(process.env.PEERS) : null;
const VERB = process.env.VERB === "1";

function rng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (s * 48271) % 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function open() {
  const db = new Database(":memory:");
  db.loadExtension(EXT);
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)");
  db.prepare("SELECT crsql_as_crr('notes')").get();
  db.prepare("SELECT crsql_as_peritext('notes', 'body')").get();
  db.exec("INSERT INTO notes (id, body) VALUES (1, '')");
  return db;
}

function pull(from, exclude) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`
    )
    .all(exclude);
}
function apply(to, changes) {
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`
  );
  to.transaction((rs) => rs.forEach((r) => stmt.run(r)))(changes);
  return changes.length;
}
function syncPair(a, b) {
  const ab = pull(a.db, b._site);
  if (ab.length) apply(b.db, ab);
  const ba = pull(b.db, a._site);
  if (ba.length) apply(a.db, ba);
  return ab.length + ba.length;
}

const visibleLen = (db) => {
  // Render directly via the fugue UDF for a stable plain-text length —
  // doc length is what mark UDFs work against (Peritext renders JSON so
  // we can't string-length the body column).
  return (db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get() ?? "").length;
};

function fuzzIteration(seed) {
  const rand = rng(seed);
  const nPeers = FIXED_PEERS ?? 2 + Math.floor(rand() * 2); // 2 or 3
  const nOps = 30 + Math.floor(rand() * 30);

  const peers = [];
  for (let i = 0; i < nPeers; i++) {
    const name = String.fromCharCode(65 + i);
    const db = open();
    peers.push({
      name,
      db,
      online: true,
      ts: 0,
      actor: Buffer.from(name),
      _site: db.prepare("SELECT crsql_site_id()").pluck().get(),
    });
  }

  const trace = [];

  for (let i = 0; i < nOps; i++) {
    const r = rand();
    const peer = peers[Math.floor(rand() * nPeers)];
    const len = visibleLen(peer.db);

    if (r < 0.4) {
      // type 1-3 chars
      const pos = len === 0 ? 0 : Math.floor(rand() * (len + 1));
      const wordLen = 1 + Math.floor(rand() * 3);
      let text = "";
      for (let k = 0; k < wordLen; k++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      try {
        peer.db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, text);
        trace.push(`${peer.name} ins@${pos} "${text}"`);
      } catch (e) {
        trace.push(`${peer.name} ins FAIL: ${e.message}`);
      }
    } else if (r < 0.55) {
      // delete a small range
      if (len > 0) {
        const from = Math.floor(rand() * len);
        const to = Math.min(from + 1 + Math.floor(rand() * 2), len);
        try {
          peer.db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(from, to);
          trace.push(`${peer.name} del[${from},${to}]`);
        } catch (e) {
          trace.push(`${peer.name} del FAIL: ${e.message}`);
        }
      }
    } else if (r < 0.78) {
      // add a mark
      if (len > 0) {
        const start = Math.floor(rand() * len);
        const end = start + 1 + Math.floor(rand() * (len - start));
        const name = MARK_NAMES[Math.floor(rand() * MARK_NAMES.length)];
        const value = name === "link" ? "https://e/" + Math.floor(rand() * 100) : null;
        const ss = SIDE_BEFORE;
        const es = name === "link" ? SIDE_AFTER : SIDE_BEFORE;
        peer.ts += 1;
        try {
          peer.db
            .prepare("SELECT crsql_peritext_mark('notes','body',1,?,?,?,?,?,?,?,?)")
            .run(
              BigInt(start),
              BigInt(end),
              name,
              value,
              BigInt(ss),
              BigInt(es),
              BigInt(peer.ts),
              peer.actor
            );
          trace.push(`${peer.name} mark ${name} [${start},${end}] @${peer.ts}`);
        } catch (e) {
          trace.push(`${peer.name} mark FAIL: ${e.message}`);
        }
      }
    } else if (r < 0.86) {
      // unmark
      if (len > 0) {
        const start = Math.floor(rand() * len);
        const end = start + 1 + Math.floor(rand() * (len - start));
        const name = MARK_NAMES[Math.floor(rand() * MARK_NAMES.length)];
        const ss = SIDE_BEFORE;
        const es = name === "link" ? SIDE_AFTER : SIDE_BEFORE;
        peer.ts += 1;
        try {
          peer.db
            .prepare("SELECT crsql_peritext_unmark('notes','body',1,?,?,?,?,?,?,?)")
            .run(
              BigInt(start),
              BigInt(end),
              name,
              BigInt(ss),
              BigInt(es),
              BigInt(peer.ts),
              peer.actor
            );
          trace.push(`${peer.name} unmark ${name} [${start},${end}] @${peer.ts}`);
        } catch (e) {
          trace.push(`${peer.name} unmark FAIL: ${e.message}`);
        }
      }
    } else if (r < 0.92) {
      // toggle online
      peer.online = !peer.online;
      trace.push(`${peer.name} ${peer.online ? "ON" : "OFF"}`);
    } else {
      // pair sync
      const online = peers.filter((p) => p.online);
      if (online.length >= 2) {
        const a = online[Math.floor(rand() * online.length)];
        let b = online[Math.floor(rand() * online.length)];
        let guard = 0;
        while (b === a && guard++ < 10) b = online[Math.floor(rand() * online.length)];
        if (a !== b) {
          try {
            syncPair(a, b);
            // advance ts to track sync
            const maxA = Number(
              a.db.prepare("SELECT COALESCE(MAX(lamport_ts), 0) FROM __crsql_peritext_notes_body_marks").pluck().get()
            );
            const maxB = Number(
              b.db.prepare("SELECT COALESCE(MAX(lamport_ts), 0) FROM __crsql_peritext_notes_body_marks").pluck().get()
            );
            a.ts = Math.max(a.ts, maxA, maxB);
            b.ts = Math.max(b.ts, maxA, maxB);
            trace.push(`sync ${a.name}↔${b.name}`);
          } catch (e) {
            trace.push(`sync FAIL: ${e.message}`);
          }
        }
      }
    }
  }

  // Force all online + sync to fixed point
  for (const p of peers) p.online = true;
  let stable = false;
  for (let pass = 0; pass < 20 && !stable; pass++) {
    const before = peers.map((p) => p.db.prepare("SELECT body FROM notes WHERE id=1").pluck().get());
    for (let i = 0; i < nPeers; i++) {
      for (let j = 0; j < nPeers; j++) {
        if (i === j) continue;
        try {
          syncPair(peers[i], peers[j]);
        } catch (e) {
          return {
            seed,
            ok: false,
            reason: `final sync ${peers[i].name}↔${peers[j].name}: ${e.message}`,
            trace,
          };
        }
      }
    }
    const after = peers.map((p) => p.db.prepare("SELECT body FROM notes WHERE id=1").pluck().get());
    stable = before.every((v, k) => v === after[k]);
  }
  if (!stable) {
    return {
      seed,
      ok: false,
      reason: "sync did not stabilize",
      trace,
      bodies: peers.map((p) => p.db.prepare("SELECT body FROM notes WHERE id=1").pluck().get()),
    };
  }

  const ref = peers[0].db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
  for (let i = 1; i < nPeers; i++) {
    const got = peers[i].db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
    if (got !== ref) {
      return {
        seed,
        ok: false,
        reason: `body diverged: ${peers[0].name} vs ${peers[i].name}`,
        trace,
        ref,
        got,
      };
    }
  }

  for (const p of peers) p.db.close();
  return { seed, ok: true };
}

let failures = 0;
let firstFailure = null;
const start = Date.now();

for (let i = 0; i < ITERATIONS; i++) {
  const seed = SEED_BASE + i * 16777619;
  const res = fuzzIteration(seed);
  if (!res.ok) {
    failures++;
    if (!firstFailure) firstFailure = res;
    if (VERB || failures <= 3) {
      console.error(`FAIL iter ${i} seed=${seed}: ${res.reason}`);
      console.error("  trace:", (res.trace ?? []).slice(-20).join(" | "));
      if (res.ref) console.error("  ref:", res.ref);
      if (res.got) console.error("  got:", res.got);
    }
  } else if (VERB) {
    console.log(`iter ${i} seed=${seed} ok`);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  `\n${ITERATIONS - failures}/${ITERATIONS} passed in ${elapsed}s (seed base=${SEED_BASE})`
);
if (failures > 0) {
  console.error(`first failing seed: ${firstFailure.seed}`);
  process.exit(1);
}
