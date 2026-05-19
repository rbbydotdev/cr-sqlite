// doc-wrapper · collaborative markdown demo
//
// Architecture: dumb shell. Library does parsing/serialization/HTML; we
// just translate between mdast (the standard markdown AST) and the
// engine's flat block-tree wire format.
//
//   textarea (raw markdown)
//        ↓ fromMarkdown   (unified · mdast-util-from-markdown)
//   mdast
//        ↓ mdastToTree    (this file — small adapter, ~40 LOC)
//   neutral tree JSON  [{kind, spans:[{text, marks}]}, ...]
//        ↓ crsql_doc_apply
//   engine (tree-CRDT + Peritext + Fugue) handles ops + sync
//        ↓ crsql_doc_render
//   neutral tree JSON
//        ↓ treeToMdast    (this file — inverse adapter)
//   mdast
//        ↓ toMarkdown     (mdast-util-to-markdown) → textarea
//        ↓ toHast + toHtml (mdast-util-to-hast + hast-util-to-html) → preview
//
// Frontend never says "Peritext", "block", "mark", or "tree" except as
// opaque shapes in the wire JSON. All markdown grammar/output handled
// by the unified ecosystem.

import {
  fromMarkdown,
  toMarkdown,
  toHast,
  toHtml,
} from "./vendor/unified.esm.js";
import { initWasm } from "./vendor/loader.js";
import { reconcileMarkdown, mapOffset } from "./reconcile-markdown.js";

const PEER_HUES = [200, 320, 90, 30, 260, 180, 350, 130];
let sqlite = null;
const world = { peers: [], nextSlot: 0 };

// ── history scrubber state ────────────────────────────────────────────
// Every input + sync event is captured here as a snapshot. UI lets the
// user click any row, step forward/back, or auto-play with a delay.
const HISTORY = [];          // { idx, ts, peer, hue, source, desc, snapshots: {label: md} }
const playback = {
  current: null,             // currently-displayed event idx (null = live)
  timer: null,
  speed: 500,
};
let scrubbing = false;       // true while showing a past snapshot

// ── mdast ↔ neutral-tree adapters ────────────────────────────────────

function mdastToTree(root) {
  const blocks = [];
  for (const node of root.children ?? []) blocks.push(...nodeToBlocks(node));
  return blocks;
}

function nodeToBlocks(n) {
  switch (n.type) {
    case "heading":
      return [{ kind: `heading-${Math.min(n.depth, 3)}`, spans: inlineSpans(n.children) }];
    case "paragraph":
      return [{ kind: "paragraph", spans: inlineSpans(n.children) }];
    case "list":
      return (n.children ?? []).flatMap((it) => listItemToBlocks(it, n.ordered));
    case "blockquote":
      return (n.children ?? []).flatMap((c) =>
        nodeToBlocks(c).map((b) => ({ ...b, kind: "quote" }))
      );
    case "code":
      return [{ kind: "code", spans: [{ text: n.value ?? "", marks: [] }] }];
    case "thematicBreak":
      return [{ kind: "hr", spans: [] }];
    case "html":
      return [{ kind: "paragraph", spans: [{ text: n.value ?? "", marks: [] }] }];
    default:
      return [];
  }
}

function listItemToBlocks(item, ordered) {
  const kind = ordered ? "list-item-ord" : "list-item";
  // Flatten: each text-bearing child becomes a sibling list-item block;
  // nested blocks (code, sublists) emit on their own.
  const out = [];
  for (const c of item.children ?? []) {
    if (c.type === "paragraph") {
      out.push({ kind, spans: inlineSpans(c.children) });
    } else {
      out.push(...nodeToBlocks(c));
    }
  }
  if (!out.length) out.push({ kind, spans: [] });
  return out;
}

function inlineSpans(children) {
  const spans = [];
  walkInline(children ?? [], [], spans);
  return mergeAdjacent(spans);
}

function walkInline(nodes, marks, out) {
  for (const n of nodes) {
    switch (n.type) {
      case "text":       out.push({ text: n.value ?? "", marks: marks.slice() }); break;
      case "strong":     walkInline(n.children, [...marks, { name: "bold" }],   out); break;
      case "emphasis":   walkInline(n.children, [...marks, { name: "italic" }], out); break;
      case "inlineCode": out.push({ text: n.value ?? "", marks: [...marks, { name: "code" }] }); break;
      case "link":       walkInline(n.children, [...marks, { name: "link", value: n.url ?? "" }], out); break;
      case "break":      out.push({ text: "\n", marks: marks.slice() }); break;
    }
  }
}

function mergeAdjacent(spans) {
  const out = [];
  for (const s of spans) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && marksEqual(last.marks, s.marks)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}
function marksEqual(a, b) {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  const norm = (m) => `${m.name}|${m.value ?? ""}`;
  const sa = (a ?? []).map(norm).sort();
  const sb = (b ?? []).map(norm).sort();
  return sa.every((v, i) => v === sb[i]);
}

// Inverse: neutral tree → mdast. Group consecutive list-item blocks into
// one `list` node so the serializer emits a single markdown list.
function treeToMdast(tree) {
  const children = [];
  let listBuf = null;
  for (const b of tree) {
    const isItem = b.kind === "list-item" || b.kind === "list-item-ord";
    if (isItem) {
      const ordered = b.kind === "list-item-ord";
      if (!listBuf || listBuf.ordered !== ordered) {
        if (listBuf) children.push(listBuf);
        // spread:true → toMarkdown renders blank lines between items,
        // which is the demo's canonical syntactic style. Doesn't affect
        // semEq (fingerprint ignores spread) so user-typed tight lists
        // are still preserved verbatim.
        listBuf = { type: "list", ordered, spread: true, children: [] };
      }
      listBuf.children.push({
        type: "listItem",
        spread: true,
        children: [{ type: "paragraph", children: spansToMdast(b.spans) }],
      });
    } else {
      if (listBuf) { children.push(listBuf); listBuf = null; }
      children.push(blockToMdast(b));
    }
  }
  if (listBuf) children.push(listBuf);
  return { type: "root", children };
}

function blockToMdast(b) {
  const inline = spansToMdast(b.spans);
  switch (b.kind) {
    case "heading-1": return { type: "heading", depth: 1, children: inline };
    case "heading-2": return { type: "heading", depth: 2, children: inline };
    case "heading-3": return { type: "heading", depth: 3, children: inline };
    case "quote":     return { type: "blockquote", children: [{ type: "paragraph", children: inline }] };
    case "code":      return { type: "code", lang: null, meta: null, value: (b.spans ?? []).map((s) => s.text).join("") };
    case "hr":        return { type: "thematicBreak" };
    default:          return { type: "paragraph", children: inline };
  }
}

function spansToMdast(spans) {
  return (spans ?? []).flatMap(spanToMdast);
}
function spanToMdast(s) {
  const marks = s.marks || {};
  if (marks.code) return [{ type: "inlineCode", value: s.text ?? "" }];
  let node = { type: "text", value: s.text ?? "" };
  if (marks.italic) node = { type: "emphasis", children: [node] };
  if (marks.bold)   node = { type: "strong",   children: [node] };
  if (marks.link)   node = { type: "link", url: typeof marks.link === "string" ? marks.link : "", children: [node] };
  return [node];
}

// ── Peer ─────────────────────────────────────────────────────────────
// One editor bound to one db. Treats its db like a plain document store:
// `crsql_doc_apply` to write, `crsql_doc_render` to read. Knows nothing
// about sync — the sync layer below moves opaque blobs between peers
// via `crsql_doc_pull` / `crsql_doc_push`.

class Peer {
  constructor({ db, label, hue, slot }) {
    Object.assign(this, { db, label, hue, slot });
    this.online = true;
    this.siteId = "";
    this.el = null;
    this.editor = null;
    this.preview = null;
    // The text the engine has applied. The reconciler runs only when
    // this matches the textarea, so it never diffs against an engine
    // that's a keystroke behind. Also the dedup baseline for input.
    this.lastApplied = "";
    // Canonical engine-rendered markdown, used for history snapshots
    // and as the paint source when returning to live from scrubbing.
    this.engineMarkdown = "";
    this._applyChain = Promise.resolve();
  }

  static async create(slot) {
    const hue = PEER_HUES[slot % PEER_HUES.length];
    const label = String.fromCharCode(65 + slot);
    const db = await sqlite.open(":memory:");
    await db.exec("SELECT crsql_doc_init()");
    const peer = new Peer({ db, label, hue, slot });
    peer.siteId = (await db.execA("SELECT lower(hex(crsql_site_id()))"))[0][0];
    return peer;
  }

  bindEditor(textarea, preview) {
    this.editor = textarea;
    this.preview = preview;
    textarea.addEventListener("input", () => {
      this._applyChain = this._applyChain
        .then(() => this._handleInput())
        .catch((e) => console.warn(`peer ${this.label} input failed:`, e));
    });
    textarea.addEventListener("focus", () => {
      if (!scrubbing) captureEvent(this, "focus", "user clicked into editor");
    });
  }

  async _handleInput() {
    if (scrubbing) return;
    const md = this.editor.value;
    if (md === this.lastApplied) return;
    const prevMd = this.lastApplied;
    const mdast = fromMarkdown(md);
    const tree = mdastToTree(mdast);
    await this.db.exec("SELECT crsql_doc_apply(?)", [JSON.stringify(tree)]);
    this.lastApplied = md;
    this._renderPreview(mdast);
    this._dumpState(tree);
    captureEvent(this, "input", describeDiff(prevMd, md));
  }

  async refreshFromEngine() {
    const treeJson = (await this.db.execA("SELECT crsql_doc_render()"))[0]?.[0] ?? "[]";
    const tree = JSON.parse(treeJson);
    const engineMdast = treeToMdast(tree);
    this.engineMarkdown = toMarkdown(engineMdast, { bullet: "-" });
    this._renderPreview(engineMdast);
    this._dumpState(tree);
    if (scrubbing) return;
    // Skip when the engine hasn't yet applied what's in the textarea —
    // otherwise the reconciler would treat the user's in-flight typing
    // as a remote diff to undo. Next _handleInput catches up.
    if (this.editor.value !== this.lastApplied) return;
    const { text, preserved } = reconcileMarkdown(this.editor.value, engineMdast);
    // Reconciled output IS what the engine reflects — track it so the
    // guard above doesn't permanently lock out a receiving peer who
    // never advances lastApplied via _handleInput.
    if (text === this.editor.value) {
      this.lastApplied = text;
      return;
    }
    const wasFocused = document.activeElement === this.editor;
    const selStart = wasFocused ? this.editor.selectionStart : null;
    const selEnd   = wasFocused ? this.editor.selectionEnd   : null;
    this.editor.value = text;
    this.lastApplied = text;
    if (wasFocused && selStart != null) {
      const ns = mapOffset(preserved, selStart, text.length);
      const ne = mapOffset(preserved, selEnd ?? selStart, text.length);
      try { this.editor.setSelectionRange(ns, ne); } catch (_) {}
      this.editor.focus();
    }
  }

  _renderPreview(mdast) {
    if (!this.preview) return;
    this.preview.innerHTML = toHtml(toHast(mdast));
  }

  _dumpState(tree) {
    const dump = this.el?.querySelector('[data-role="state-dump"]');
    if (dump) dump.textContent = JSON.stringify(tree, null, 2);
    const sum = this.el?.querySelector(".rows-summary");
    if (sum) sum.textContent = `(${tree.length})`;
  }

  setOnline(online) {
    if (this.online === online) return;
    this.online = online;
    this._renderHeader();
    captureEvent(this, online ? "online" : "offline", online ? "reconnect" : "going offline");
  }
  _renderHeader() {
    if (!this.el) return;
    this.el.classList.toggle("offline", !this.online);
    const cb = this.el.querySelector(".online-cb");
    if (cb && cb.checked !== this.online) cb.checked = this.online;
    const lbl = this.el.querySelector(".online-label");
    if (lbl) lbl.textContent = this.online ? "online" : "offline";
  }

  destroy() { this.db.close().catch(() => {}); this.el?.remove(); }
}

// ── sync glue ────────────────────────────────────────────────────────
// Shuttle opaque change blobs from one peer's db to another's. The
// engine's `crsql_doc_pull` / `crsql_doc_push` UDFs hide the underlying
// `crsql_changes` schema entirely — this layer just moves the blob.

async function syncPair(from, to) {
  const blob = (await from.db.execA("SELECT crsql_doc_pull(?)", [to.siteId]))[0]?.[0];
  if (!blob || blob === "[]") return;
  const prevEngine = to.engineMarkdown;
  await to.db.exec("SELECT crsql_doc_push(?)", [blob]);
  await to.refreshFromEngine();
  if (to.engineMarkdown !== prevEngine) {
    captureEvent(to, "sync", describeDiff(prevEngine, to.engineMarkdown));
  }
}

// ── history capture + scrubber ───────────────────────────────────────

function captureEvent(peer, source, desc) {
  // Snapshot ENGINE state (per-peer canonical render), not textarea
  // values — otherwise during scrubbing the "live" peer would record a
  // mix of (scrubbed-past textarea) + (current-engine textarea) per peer.
  // Engine state is single-sourced and monotonic per peer.
  //
  // We DO capture during scrubbing — background sync keeps producing
  // events; the history table should keep growing so clicking 'live'
  // lands you at the latest event.
  const snapshots = {};
  for (const p of world.peers) snapshots[p.label] = p.engineMarkdown ?? "";
  const ev = {
    idx: HISTORY.length,
    ts: Date.now(),
    peer: peer?.label ?? "—",
    hue: peer?.hue ?? null,
    source,
    desc,
    snapshots,
  };
  HISTORY.push(ev);
  renderHistoryRow(ev);
}

// Compute a short human-readable diff description.
function describeDiff(oldStr, newStr) {
  const o = oldStr ?? "", n = newStr ?? "";
  if (o === n) return "(no change)";
  // longest common prefix + suffix → single edit range
  const lo = o.length, ln = n.length;
  let p = 0;
  const min = Math.min(lo, ln);
  while (p < min && o[p] === n[p]) p++;
  let so = lo - 1, sn = ln - 1;
  while (so >= p && sn >= p && o[so] === n[sn]) { so--; sn--; }
  const removed = o.slice(p, so + 1);
  const inserted = n.slice(p, sn + 1);
  const fmt = (s) => JSON.stringify(s.length > 24 ? s.slice(0, 24) + "…" : s);
  if (removed && inserted) return `replace @${p} ${fmt(removed)} → ${fmt(inserted)}`;
  if (removed) return `del @${p} ${fmt(removed)}`;
  if (inserted) return `ins @${p} ${fmt(inserted)}`;
  return "(no change)";
}

function fmtTime(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

let historyTbody = null;
function renderHistoryRow(ev) {
  if (!historyTbody) historyTbody = document.querySelector("#history tbody");
  const tr = document.createElement("tr");
  tr.dataset.idx = String(ev.idx);
  const hueStyle = ev.hue != null ? `background:hsl(${ev.hue},45%,32%)` : "";
  tr.innerHTML = `
    <td class="c-idx">${ev.idx + 1}</td>
    <td class="c-when">${fmtTime(ev.ts)}</td>
    <td class="c-peer"><span class="peer-chip" style="${hueStyle}">${ev.peer}</span></td>
    <td class="c-source">${ev.source}</td>
    <td class="c-desc">${escHtml(ev.desc)}</td>
  `;
  tr.addEventListener("click", () => jumpTo(ev.idx));
  historyTbody.appendChild(tr);
  // Auto-scroll latest into view if we're at the bottom already
  const frame = document.querySelector("#history .history-frame");
  if (frame) {
    const atBottom = frame.scrollHeight - frame.scrollTop - frame.clientHeight < 50;
    if (atBottom) frame.scrollTop = frame.scrollHeight;
  }
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
  }[c]));
}

function setScrubbing(on) {
  scrubbing = on;
  document.body.classList.toggle("scrubbing", on);
  for (const p of world.peers) {
    if (p.editor) p.editor.readOnly = on;
  }
  // Blur whatever's focused on entry/exit. Without this, a focused
  // textarea keeps document.activeElement set, and our "don't clobber
  // while typing" guard in refreshFromEngine refuses to repaint it
  // when goLive runs.
  if (typeof document !== "undefined" && document.activeElement?.blur) {
    document.activeElement.blur();
  }
}

function highlightRow(idx) {
  if (!historyTbody) return;
  for (const tr of historyTbody.querySelectorAll("tr")) {
    const i = Number(tr.dataset.idx);
    tr.classList.toggle("current", i === idx);
    tr.classList.toggle("played", idx != null && i < idx);
  }
  if (idx != null) {
    const tr = historyTbody.querySelector(`tr[data-idx="${idx}"]`);
    tr?.scrollIntoView({ block: "nearest" });
  }
}

function jumpTo(idx) {
  if (idx < 0 || idx >= HISTORY.length) return;
  setScrubbing(true);
  const ev = HISTORY[idx];
  for (const p of world.peers) {
    const md = ev.snapshots[p.label] ?? "";
    if (p.editor) p.editor.value = md;
    // Render preview from the snapshot too, so it reflects the
    // scrubbed state (otherwise the textarea jumps but preview stays
    // pinned to live, which looks like a bug).
    if (p.preview) {
      try { p.preview.innerHTML = toHtml(toHast(fromMarkdown(md))); }
      catch (_) { /* malformed snapshot — ignore */ }
    }
  }
  playback.current = idx;
  highlightRow(idx);
}

function stepPrev() {
  const cur = playback.current ?? HISTORY.length;
  jumpTo(Math.max(0, cur - 1));
}
function stepNext() {
  const cur = playback.current ?? -1;
  if (cur + 1 < HISTORY.length) jumpTo(cur + 1);
  else goLive();
}

function startAutoPlay() {
  if (playback.timer) return;
  if (HISTORY.length === 0) {
    console.log("[history] nothing to play yet — type in an editor first");
    return;
  }
  const speed = Number(document.querySelector('input[name="speed"]:checked')?.value ?? 500);
  playback.speed = speed;
  document.getElementById("hist-play").classList.add("active");
  document.getElementById("hist-play").textContent = "⏸";
  // If at the end (or live), restart from 0.
  if (playback.current == null || playback.current >= HISTORY.length - 1) {
    jumpTo(0);
  }
  playback.timer = setInterval(() => {
    const cur = playback.current ?? -1;
    if (cur + 1 >= HISTORY.length) { stopAutoPlay(); return; }
    jumpTo(cur + 1);
  }, speed);
}
function stopAutoPlay() {
  if (playback.timer) clearInterval(playback.timer);
  playback.timer = null;
  const btn = document.getElementById("hist-play");
  if (btn) { btn.classList.remove("active"); btn.textContent = "▶"; }
}

async function goLive() {
  stopAutoPlay();
  setScrubbing(false);
  playback.current = null;
  highlightRow(null);
  // Force-paint from current engine state. Setting lastApplied keeps
  // the next _handleInput's diff sane and the refreshFromEngine guard
  // re-armed.
  for (const p of world.peers) repaintFromEngine(p);
}

function repaintFromEngine(p) {
  const md = p.engineMarkdown ?? "";
  if (p.editor) { p.editor.value = md; p.lastApplied = md; }
  if (p.preview) {
    try { p.preview.innerHTML = toHtml(toHast(fromMarkdown(md))); } catch (_) {}
  }
}

function clearHistory() {
  stopAutoPlay();
  HISTORY.length = 0;
  playback.current = null;
  if (historyTbody) historyTbody.innerHTML = "";

  // Exit scrubbing so the new log starts from live state. Without this
  // the first real event after clear could be captured against a stale
  // engineMarkdown-vs-textarea mix.
  if (scrubbing) {
    setScrubbing(false);
    for (const p of world.peers) repaintFromEngine(p);
  }

  // Seed the fresh log with one baseline row per peer capturing their
  // current online state + engine markdown. Without this, the next real
  // event is unanchored — you can't tell from the cleared log whether
  // B was offline going into the next sync, or what the doc started as.
  for (const p of world.peers) {
    captureEvent(
      p,
      p.online ? "baseline" : "baseline·offline",
      `peer ${p.label}: ${p.online ? "online" : "offline"} · md=${
        (p.engineMarkdown ?? "").length
      } chars`,
    );
  }
}

async function copyHistory() {
  // Strip snapshots from each event for readability; include a separate
  // `snapshots` block at the top. Format is hand-rolled to be easy to
  // skim in a chat copy-paste rather than minified JSON.
  const meta = {
    peers: world.peers.map((p) => ({ label: p.label, site: p.siteId, hue: p.hue })),
    eventCount: HISTORY.length,
    capturedAt: new Date().toISOString(),
  };
  const events = HISTORY.map((e) => ({
    idx: e.idx,
    t: new Date(e.ts).toISOString().slice(11, 23),
    peer: e.peer,
    source: e.source,
    desc: e.desc,
    snapshots: e.snapshots,
  }));
  const blob = JSON.stringify({ meta, events }, null, 2);
  try {
    await navigator.clipboard.writeText(blob);
    const btn = document.getElementById("hist-copy");
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "copied ✓";
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  } catch (e) {
    console.warn("clipboard write failed:", e);
    // Fallback: dump to console
    console.log("[history copy fallback]\n" + blob);
  }
}

function wireHistoryControls() {
  document.getElementById("hist-reset").addEventListener("click", () => jumpTo(0));
  document.getElementById("hist-prev").addEventListener("click", stepPrev);
  document.getElementById("hist-next").addEventListener("click", stepNext);
  document.getElementById("hist-play").addEventListener("click", () => {
    if (playback.timer) stopAutoPlay(); else startAutoPlay();
  });
  document.getElementById("hist-live").addEventListener("click", goLive);
  document.getElementById("hist-copy").addEventListener("click", copyHistory);
  document.getElementById("hist-clear").addEventListener("click", clearHistory);
  // Live speed change: if currently auto-playing, re-arm the timer at the
  // new speed without disturbing the current scrub position.
  for (const r of document.querySelectorAll('input[name="speed"]')) {
    r.addEventListener("change", () => {
      if (playback.timer) { stopAutoPlay(); startAutoPlay(); }
    });
  }
}

// ── DOM bootstrap + sync ─────────────────────────────────────────────

const template = document.getElementById("peer-template");
const peersHost = document.getElementById("peers");

async function buildPeerEl(peer) {
  const frag = template.content.cloneNode(true);
  const article = frag.querySelector(".peer");
  article.style.setProperty("--hue", String(peer.hue));
  article.dataset.peer = peer.label;
  article.querySelector(".peer-name").textContent = `editor ${peer.label}`;
  article.querySelector(".peer-site").textContent = `site:${peer.siteId.slice(0, 6)}`;
  peer.el = article;
  peer.bindEditor(
    article.querySelector('[data-role="editor"]'),
    article.querySelector('[data-role="preview"]'),
  );
  const cb = article.querySelector(".online-cb");
  cb.addEventListener("change", () => peer.setOnline(cb.checked));
  article.querySelector(".btn-close").addEventListener("click", () => removePeer(peer));
  return article;
}
async function addPeer() {
  const slot = world.nextSlot++;
  const peer = await Peer.create(slot);
  await buildPeerEl(peer);
  peersHost.appendChild(peer.el);
  world.peers.push(peer);
  peer._renderHeader();
  return peer;
}
function removePeer(peer) {
  const i = world.peers.indexOf(peer);
  if (i < 0) return;
  world.peers.splice(i, 1);
  peer.destroy();
}

async function syncTick() {
  const online = world.peers.filter((p) => p.online);
  if (online.length < 2) return;
  for (const a of online) {
    for (const b of online) {
      if (a === b) continue;
      try { await syncPair(a, b); }
      catch (e) { console.warn(`sync ${a.label}→${b.label} failed:`, e); }
    }
  }
}
setInterval(syncTick, 600);

async function boot() {
  sqlite = await initWasm((file) => `./vendor/${file}`);
  wireHistoryControls();
  await addPeer();
  await addPeer();
}
document.getElementById("add-peer").addEventListener("click", () => addPeer());
window.__world = world;

boot().catch((e) => {
  console.error("boot failed:", e);
  document.body.innerHTML = `<div style="padding:48px;text-align:center;color:#ff7c7c;font-family:JetBrains Mono,monospace"><strong>engine fault:</strong> ${e?.message ?? "unknown"}</div>`;
});
