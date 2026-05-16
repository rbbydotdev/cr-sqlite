// Property fuzz for the tree CRDT primitive.
//
// Random sequences of tree operations across N peers with random
// online/offline transitions. After bringing everyone online and syncing
// to a fixed point, invariant: every peer's __tree_state must be byte-
// identical and the tree must be valid (each node has ≤1 parent — already
// enforced by the PK on __tree_state — and no cycles reachable from the
// state graph).
//
// Knobs (env):
//   SEED  — int seed for the LCG; default: Date.now()
//   ITER  — fuzz iterations; default: 200
//   OPS   — base op count per iteration; default: 40 + rand 0-30
//   PEERS — fixed peer count; default: 2-4 random
//   VERB  — set to 1 to log every iteration's trace on failure
//
// Run:
//   node tree-crdt-fuzz.mjs                     # default 200 iters
//   ITER=2000 node tree-crdt-fuzz.mjs           # extended run
//   SEED=12345 node tree-crdt-fuzz.mjs          # reproduce a failure

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(__dirname, "../../core/dist/crsqlite");

const SEED_BASE = process.env.SEED ? Number(process.env.SEED) : Date.now();
const ITERATIONS = Number(process.env.ITER ?? 200);
const VERB = process.env.VERB === "1";
const FIXED_PEERS = process.env.PEERS ? Number(process.env.PEERS) : null;

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
  db.prepare("SELECT crsql_create_tree('t')").get();
  return db;
}

function pull(from, excludeSite) {
  return from
    .prepare(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`
    )
    .all(excludeSite);
}

function apply(to, changes) {
  const stmt = to.prepare(
    `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
     VALUES (@table,@pk,@cid,@val,@col_version,@db_version,@site_id,@cl,@seq)`
  );
  const tx = to.transaction((rs) => rs.forEach((r) => stmt.run(r)));
  tx(changes);
  return changes.length;
}

function syncPair(a, b) {
  const ab = pull(a.db, b._site);
  if (ab.length) apply(b.db, ab);
  const ba = pull(b.db, a._site);
  if (ba.length) apply(a.db, ba);
  return ab.length + ba.length;
}

function dumpState(db) {
  return db
    .prepare(
      "SELECT node_id, parent_id, hex(meta) AS meta FROM t__tree_state ORDER BY node_id"
    )
    .all();
}

// Verify no cycles in `__tree_state`. Each node, walk up via parent_id;
// if we visit a node twice or take more than N steps (N = node count),
// flag it as a cycle. Returns null on success, descriptive string on
// failure.
function checkAcyclic(state) {
  const parent = new Map(state.map((r) => [String(r.node_id), r.parent_id]));
  for (const r of state) {
    const seen = new Set();
    let cur = r.node_id;
    let steps = 0;
    while (cur !== null && cur !== undefined) {
      const key = String(cur);
      if (seen.has(key)) return `cycle reachable from ${r.node_id}: visited ${key} twice`;
      seen.add(key);
      if (++steps > state.length + 1) return `chain from ${r.node_id} exceeds N+1 steps — likely cycle`;
      cur = parent.get(key);
    }
  }
  return null;
}

const move = (db, child, parent, meta, ts, actor) =>
  db
    .prepare("SELECT crsql_tree_move('t', ?, ?, ?, ?, ?)")
    .run(child, parent, meta, ts, actor);

function fuzzIteration(seed) {
  const rand = rng(seed);
  const nPeers = FIXED_PEERS ?? 2 + Math.floor(rand() * 3); // 2-4
  const nOps = 40 + Math.floor(rand() * 30);

  const peers = [];
  for (let i = 0; i < nPeers; i++) {
    const name = String.fromCharCode(65 + i);
    const db = open();
    peers.push({
      name,
      db,
      online: true,
      ts: 0, // peer-local Lamport clock
      actor: Buffer.from(name),
      _site: db.prepare("SELECT crsql_site_id()").pluck().get(),
    });
  }

  // Node ID pool: 0..NODE_COUNT-1. Selecting parent at random includes
  // NULL (root). Selecting child for a move is also from this pool —
  // first move to a given child id implicitly creates the node.
  const NODE_COUNT = 8;
  const pickChild = () => Math.floor(rand() * NODE_COUNT);
  const pickParent = () => {
    const r = rand();
    if (r < 0.2) return null; // 20% root
    return Math.floor(rand() * NODE_COUNT);
  };

  const trace = [];

  for (let i = 0; i < nOps; i++) {
    const r = rand();
    const peer = peers[Math.floor(rand() * nPeers)];

    if (r < 0.75) {
      // generate a move op
      const child = pickChild();
      const parent = pickParent();
      const meta = null;
      peer.ts += 1;
      const ts = peer.ts;
      try {
        move(peer.db, child, parent, meta, ts, peer.actor);
        trace.push(`${peer.name} mv ${child}→${parent ?? "·"} @${ts}`);
      } catch (e) {
        trace.push(`${peer.name} mv FAIL: ${e.message}`);
      }
    } else if (r < 0.88) {
      peer.online = !peer.online;
      trace.push(`${peer.name} ${peer.online ? "ON" : "OFF"}`);
    } else {
      const onlinePeers = peers.filter((p) => p.online);
      if (onlinePeers.length >= 2) {
        const a = onlinePeers[Math.floor(rand() * onlinePeers.length)];
        let b = onlinePeers[Math.floor(rand() * onlinePeers.length)];
        let guard = 0;
        while (b === a && guard++ < 10) b = onlinePeers[Math.floor(rand() * onlinePeers.length)];
        if (a !== b) {
          try {
            const n = syncPair(a, b);
            // Sync should advance each peer's Lamport clock to at least
            // the max it saw (so subsequent local ops aren't dominated).
            const maxA = a.db.prepare("SELECT COALESCE(MAX(lamport_ts), 0) FROM t__tree_ops").pluck().get();
            const maxB = b.db.prepare("SELECT COALESCE(MAX(lamport_ts), 0) FROM t__tree_ops").pluck().get();
            a.ts = Math.max(a.ts, maxA, maxB);
            b.ts = Math.max(b.ts, maxA, maxB);
            trace.push(`sync ${a.name}↔${b.name} (${n})`);
          } catch (e) {
            trace.push(`sync FAIL: ${e.message}`);
          }
        }
      }
    }
  }

  // Force everyone online and sync to a fixed point.
  for (const p of peers) p.online = true;
  let stable = false;
  for (let pass = 0; pass < 20 && !stable; pass++) {
    const before = peers.map((p) => JSON.stringify(dumpState(p.db)));
    for (let i = 0; i < nPeers; i++) {
      for (let j = 0; j < nPeers; j++) {
        if (i === j) continue;
        try {
          syncPair(peers[i], peers[j]);
        } catch (e) {
          return {
            seed,
            ok: false,
            reason: `final sync ${peers[i].name}↔${peers[j].name} threw: ${e.message}`,
            trace,
          };
        }
      }
    }
    const after = peers.map((p) => JSON.stringify(dumpState(p.db)));
    stable = before.every((v, k) => v === after[k]);
  }
  if (!stable) {
    return {
      seed,
      ok: false,
      reason: "sync did not stabilize in 20 passes",
      trace,
      states: peers.map((p) => dumpState(p.db)),
    };
  }

  // Convergence: every peer's state must match peer 0's.
  const ref = dumpState(peers[0].db);
  const refStr = JSON.stringify(ref);
  for (let i = 1; i < nPeers; i++) {
    const s = dumpState(peers[i].db);
    if (JSON.stringify(s) !== refStr) {
      return {
        seed,
        ok: false,
        reason: `state diverged: ${peers[0].name} vs ${peers[i].name}`,
        trace,
        states: peers.map((p) => dumpState(p.db)),
      };
    }
  }

  // Tree invariants: PK on __tree_state already enforces ≤1 parent.
  // Check acyclic.
  const cycle = checkAcyclic(ref);
  if (cycle) {
    return { seed, ok: false, reason: `acyclic check failed: ${cycle}`, trace, state: ref };
  }

  for (const p of peers) p.db.close();
  return { seed, ok: true };
}

// ── main loop ────────────────────────────────────────────────────────────
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
      console.error("  trace:", res.trace?.slice(-30).join(" | "));
      if (res.states) {
        for (let k = 0; k < res.states.length; k++) {
          console.error(`  peer${k}:`, JSON.stringify(res.states[k]));
        }
      }
    }
  } else if (VERB) {
    console.log(`iter ${i} seed=${seed} ok`);
  }
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(
  `\n${ITERATIONS - failures}/${ITERATIONS} passed in ${elapsed}s ` +
    `(seed base=${SEED_BASE})`
);
if (failures > 0) {
  console.error(`first failing seed: ${firstFailure.seed}`);
  process.exit(1);
}
