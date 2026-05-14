// Property-based fuzz: random sequences of edits across N peers with random
// online/offline transitions. Final invariant: once every peer is online and
// changes have been bidirectionally synced to a fixed point, all peers must
// converge on identical render output AND each peer's materialized
// `notes.body` column must match its `crsql_fugue_render(...)` value.
//
// Knobs (env):
//   SEED  — int seed for the LCG; default: Date.now()
//   ITER  — number of fuzz iterations; default: 200
//   OPS   — ops per iteration; default: 40 base + 0-30 random
//   PEERS — fixed peer count; default: 2-4 random
//   VERB  — set to 1 to log every iteration
//
// Run:
//   node text-crdt-fuzz.mjs                       # default 200 iters
//   ITER=2000 node text-crdt-fuzz.mjs             # extended run
//   SEED=12345 node text-crdt-fuzz.mjs            # reproduce a failure

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SEED_BASE = process.env.SEED ? Number(process.env.SEED) : Date.now();
const ITERATIONS = Number(process.env.ITER ?? 200);
const VERB = process.env.VERB === "1";
const FIXED_PEERS = process.env.PEERS ? Number(process.env.PEERS) : null;

// ── deterministic RNG (LCG) — same seed reproduces a failed iteration ────
function rng(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    // Park-Miller LCG, good enough for fuzz.
    s = (s * 48271) % 0x7fffffff;
    return s / 0x7fffffff;
  };
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

// ── per-peer engine wiring ────────────────────────────────────────────────
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
const render = (db) => db.prepare("SELECT crsql_fugue_render('notes','body',1)").pluck().get();
const bodyCol = (db) => db.prepare("SELECT body FROM notes WHERE id=1").pluck().get();
const insert = (db, pos, t) => db.prepare("SELECT crsql_fugue_insert('notes','body',1,?,?)").get(pos, t);
const del = (db, from, to) => db.prepare("SELECT crsql_fugue_delete('notes','body',1,?,?)").get(from, to);
// Cleanup-on-apply is not yet engine-side (see registration.rs #!~ marker).
// The fuzz test calls it explicitly after sync converges so we can verify
// the END STATE is canonical and consistent across peers. Once cleanup-on-
// apply lands, this call can be removed and the same assertions should hold.
const cleanup = (db) => db.prepare("SELECT crsql_fugue_cleanup('notes','body',1)").pluck().get();

function pull(from, excludeSiteId) {
  return from
    .prepare(`SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq FROM crsql_changes WHERE site_id IS NOT ?`)
    .all(excludeSiteId);
}
function apply(to, changes) {
  const stmt = to.prepare(`INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq) VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`);
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
  return changes.length;
}
function syncPair(a, b) {
  // Best-effort bidirectional sync between two peer objects.
  const ab = pull(a.db, b._site);
  if (ab.length) apply(b.db, ab);
  const ba = pull(b.db, a._site);
  if (ba.length) apply(a.db, ba);
  return ab.length + ba.length;
}

// ── one fuzz iteration ────────────────────────────────────────────────────
function fuzzIteration(seed) {
  const rand = rng(seed);
  const nPeers = FIXED_PEERS ?? (2 + Math.floor(rand() * 3)); // 2-4 peers
  const nOps = 40 + Math.floor(rand() * 30);

  const peers = [];
  for (let i = 0; i < nPeers; i++) {
    peers.push({
      name: String.fromCharCode(65 + i),
      db: open(),
      online: true,
      _site: null,
    });
    peers[i]._site = siteId(peers[i].db);
  }

  const trace = [];
  const pickPeer = () => peers[Math.floor(rand() * nPeers)];

  for (let i = 0; i < nOps; i++) {
    const r = rand();
    const peer = pickPeer();
    const curLen = (render(peer.db) ?? "").length;

    if (r < 0.55) {
      // type 1-4 chars at a random position
      const pos = curLen === 0 ? 0 : Math.floor(rand() * (curLen + 1));
      const wordLen = 1 + Math.floor(rand() * 4);
      let text = "";
      for (let k = 0; k < wordLen; k++) text += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      try {
        insert(peer.db, pos, text);
        trace.push(`${peer.name} ins@${pos} "${text}"`);
      } catch (e) { trace.push(`${peer.name} ins@${pos} FAIL: ${e.message}`); }
    } else if (r < 0.75) {
      // delete a single char at random position
      if (curLen > 0) {
        const from = Math.floor(rand() * curLen);
        const to = Math.min(from + 1, curLen);
        try { del(peer.db, from, to); trace.push(`${peer.name} del[${from},${to}]`); }
        catch (e) { trace.push(`${peer.name} del[${from},${to}] FAIL: ${e.message}`); }
      }
    } else if (r < 0.88) {
      // toggle online for this peer
      peer.online = !peer.online;
      trace.push(`${peer.name} ${peer.online ? "ONLINE" : "OFFLINE"}`);
    } else {
      // sync between two random online peers
      const onlinePeers = peers.filter((p) => p.online);
      if (onlinePeers.length >= 2) {
        const a = onlinePeers[Math.floor(rand() * onlinePeers.length)];
        let b = onlinePeers[Math.floor(rand() * onlinePeers.length)];
        let guard = 0;
        while (b === a && guard++ < 10) b = onlinePeers[Math.floor(rand() * onlinePeers.length)];
        if (a !== b) {
          try { const n = syncPair(a, b); trace.push(`sync ${a.name}↔${b.name} (${n})`); }
          catch (e) { trace.push(`sync ${a.name}↔${b.name} FAIL: ${e.message}`); }
        }
      }
    }
  }

  // Force everyone online and sync to a fixed point. `apply` is idempotent
  // (replaying old changes is a no-op), so we detect stability by snapshotting
  // every peer's body before and after a full N×N sync round; stable when no
  // body changes for a full round.
  for (const p of peers) p.online = true;
  let total = 0;
  let stable = false;
  for (let pass = 0; pass < 20 && !stable; pass++) {
    const before = peers.map((p) => render(p.db));
    for (let i = 0; i < nPeers; i++) {
      for (let j = 0; j < nPeers; j++) {
        if (i === j) continue;
        try { total += syncPair(peers[i], peers[j]); }
        catch (e) { return { seed, ok: false, reason: `sync ${peers[i].name}↔${peers[j].name} threw: ${e.message}`, trace }; }
      }
    }
    const after = peers.map((p) => render(p.db));
    stable = before.every((v, k) => v === after[k]);
  }
  if (!stable) {
    return { seed, ok: false, reason: "sync did not stabilize in 20 passes (renders kept changing)", trace, renders: peers.map((p) => render(p.db)) };
  }

  // Drive cleanup on each peer so concurrent-split overlaps converge to
  // canonical state. Without this, the trigger's exact-idx CTE walks an
  // over-counted tree on transient pre-cleanup states. Run cleanup +
  // re-sync until stable so cleanup deltas propagate across peers.
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    for (const p of peers) {
      const before = render(p.db);
      cleanup(p.db);
      if (render(p.db) !== before) changed = true;
    }
    // Cleanup writes generate new crsql_changes — sync them around.
    for (let i = 0; i < nPeers; i++) {
      for (let j = 0; j < nPeers; j++) {
        if (i !== j) syncPair(peers[i], peers[j]);
      }
    }
    if (!changed) break;
  }

  // Convergence checks.
  const renders = peers.map((p) => render(p.db));
  const bodies = peers.map((p) => bodyCol(p.db));
  for (let i = 1; i < nPeers; i++) {
    if (renders[i] !== renders[0]) {
      return {
        seed,
        ok: false,
        reason: `render diverged: peer ${peers[0].name}=${JSON.stringify(renders[0])} vs peer ${peers[i].name}=${JSON.stringify(renders[i])}`,
        trace,
        renders,
        bodies,
      };
    }
  }
  for (let i = 0; i < nPeers; i++) {
    if (bodies[i] !== renders[i]) {
      // Surface orphan children — rows whose parent (itemId, parentIdx) has
      // no matching exact-idx row in backing. If present, the trigger's
      // exact-idx CTE will silently drop them. The splitter is supposed to
      // resolve these before render.
      const orphans = peers[i].db
        .prepare(
          `SELECT c.itemId, c.idx, c.content, c.parentItemId, c.parentIdx
             FROM __crsql_fugue_notes_body c
            WHERE c.row_pk = 1 AND c.idx != -1
              AND c.parentItemId != ''
              AND NOT EXISTS (
                SELECT 1 FROM __crsql_fugue_notes_body p
                 WHERE p.row_pk = 1 AND p.itemId = c.parentItemId AND p.idx = c.parentIdx
              )`,
        )
        .all();
      const allRows = peers[i].db
        .prepare(
          `SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned
             FROM __crsql_fugue_notes_body WHERE row_pk = 1
            ORDER BY itemId, idx`,
        )
        .all();
      return {
        seed,
        ok: false,
        reason: `notes.body diverged from render on peer ${peers[i].name}`,
        renderOnPeer: renders[i],
        bodyOnPeer: bodies[i],
        orphans,
        allRows,
        trace,
        renders,
        bodies,
      };
    }
  }

  return { seed, ok: true, finalLen: renders[0]?.length ?? 0, nPeers, nOps, totalSynced: total };
}

// ── main loop ─────────────────────────────────────────────────────────────
let passes = 0;
const fails = [];
const startedAt = Date.now();

for (let i = 0; i < ITERATIONS; i++) {
  const seed = (SEED_BASE + i * 7919) >>> 0;
  let res;
  try { res = fuzzIteration(seed); }
  catch (e) { res = { seed, ok: false, reason: `crash: ${e.message}`, stack: e.stack }; }
  if (res.ok) {
    passes++;
    if (VERB || i % 25 === 0) console.log(`#${i} seed=${seed} ok len=${res.finalLen} peers=${res.nPeers}`);
  } else {
    fails.push(res);
    console.error(`#${i} seed=${seed} FAIL: ${res.reason}`);
    if (res.trace) {
      console.error("  trace (last 30 ops):");
      for (const line of res.trace.slice(-30)) console.error("    " + line);
    }
    if (res.renders) {
      console.error("  renders:");
      res.renders.forEach((r, k) => console.error(`    ${String.fromCharCode(65+k)}: ${JSON.stringify(r)}`));
    }
    if (res.bodies) {
      console.error("  bodies:");
      res.bodies.forEach((b, k) => console.error(`    ${String.fromCharCode(65+k)}: ${JSON.stringify(b)}`));
    }
    if (res.orphans) {
      console.error(`  orphan rows on failing peer (${res.orphans.length}):`);
      for (const o of res.orphans.slice(0, 8)) console.error("    ", JSON.stringify(o));
    }
    if (res.allRows) {
      console.error(`  all backing rows on failing peer (${res.allRows.length}):`);
      for (const r of res.allRows.slice(0, 50)) console.error("    ", JSON.stringify(r));
    }
    if (res.stack) console.error(res.stack);
    if (fails.length >= 3) {
      console.error(`\n…stopping after ${fails.length} failures shown`);
      break;
    }
  }
}

const elapsedMs = Date.now() - startedAt;
console.log(`\n${passes}/${ITERATIONS} pass · ${fails.length} fail · ${elapsedMs}ms`);
if (fails.length > 0) {
  console.log("first failed seed:", fails[0].seed, "— reproduce with `SEED=" + fails[0].seed + " ITER=1 node " + path.basename(import.meta.url) + "`");
  process.exit(1);
}
console.log("PASS: fuzz convergence holds");
