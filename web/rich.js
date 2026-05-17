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
        listBuf = { type: "list", ordered, spread: false, children: [] };
      }
      listBuf.children.push({
        type: "listItem",
        spread: false,
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

class Peer {
  constructor({ db, label, hue, slot }) {
    Object.assign(this, { db, label, hue, slot });
    this.online = true;
    this.siteId = "";
    this.el = null;
    this.editor = null;
    this.preview = null;
    this.lastMarkdown = "";
    // Canonical engine-rendered markdown, kept fresh by refreshFromEngine.
    // Distinct from `lastMarkdown` (which mirrors the textarea) so the
    // history scrubber can snapshot truth even while the textarea is
    // showing a past state.
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
    // Focus → context-only event in the history log. Doesn't change CRDT
    // state but helps explain timing: "Peer A focused, then typed..."
    textarea.addEventListener("focus", () => {
      if (!scrubbing) captureEvent(this, "focus", "user clicked into editor");
    });
  }

  async _handleInput() {
    if (scrubbing) return; // scrubber holds the editor read-only
    const md = this.editor.value;
    if (md === this.lastMarkdown) return;
    const prevMd = this.lastMarkdown;
    this.lastMarkdown = md;
    const mdast = fromMarkdown(md);
    const tree = mdastToTree(mdast);
    await this.db.exec("SELECT crsql_doc_apply(?)", [JSON.stringify(tree)]);
    this._renderPreview(mdast);
    this._dumpState(tree);
    captureEvent(this, "input", describeDiff(prevMd, md));
  }

  async refreshFromEngine() {
    const treeJson = (await this.db.execA("SELECT crsql_doc_render()"))[0]?.[0] ?? "[]";
    const tree = JSON.parse(treeJson);
    const mdast = treeToMdast(tree);
    const md = toMarkdown(mdast);
    // Always track engine truth; it's used by the history scrubber.
    this.engineMarkdown = md;
    // While scrubbing the textarea + preview display a PAST snapshot.
    // Don't clobber them with the engine's current state — that's the
    // whole point of the scrubber. The engine keeps moving in the
    // background; the user returns to it by clicking "live".
    if (scrubbing) return;
    if (md !== this.editor.value && document.activeElement !== this.editor) {
      this.editor.value = md;
      this.lastMarkdown = md;
    }
    this._renderPreview(mdast);
    this._dumpState(tree);
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

  async pullChanges(excludeSiteHex) {
    return await this.db.execA(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
      [hexToBytes(excludeSiteHex)],
    );
  }
  async applyChanges(rows) {
    if (!rows.length) return;
    const prevMd = this.lastMarkdown;
    for (const r of rows) {
      await this.db.exec(
        `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r,
      );
    }
    await this.refreshFromEngine();
    if (this.lastMarkdown !== prevMd) {
      captureEvent(this, `sync (${rows.length})`, describeDiff(prevMd, this.lastMarkdown));
    }
  }

  destroy() { this.db.close().catch(() => {}); this.el?.remove(); }
}

function hexToBytes(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
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
  // Force-paint textarea + preview from current engine state. Bypass the
  // refreshFromEngine focus-check (the "live" button is an explicit user
  // intent — don't preserve a stale focus state).
  for (const p of world.peers) {
    const md = p.engineMarkdown ?? "";
    if (p.editor) { p.editor.value = md; p.lastMarkdown = md; }
    if (p.preview) {
      try { p.preview.innerHTML = toHtml(toHast(fromMarkdown(md))); }
      catch (_) {}
    }
  }
}

function clearHistory() {
  stopAutoPlay();
  HISTORY.length = 0;
  playback.current = null;
  if (historyTbody) historyTbody.innerHTML = "";

  // Exit scrubbing so the new log starts from live state and the editor
  // resumes engine-truth display. Otherwise the user could clear while
  // viewing a past row and the first real event after clear would be
  // captured against a stale `engineMarkdown`-vs-textarea mix.
  if (scrubbing) {
    setScrubbing(false);
    for (const p of world.peers) {
      const md = p.engineMarkdown ?? "";
      if (p.editor) { p.editor.value = md; p.lastMarkdown = md; }
      if (p.preview) {
        try { p.preview.innerHTML = toHtml(toHast(fromMarkdown(md))); } catch (_) {}
      }
    }
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
      try {
        const changes = await a.pullChanges(b.siteId);
        if (changes.length) await b.applyChanges(changes);
      } catch (e) { console.warn(`sync ${a.label}→${b.label} failed:`, e); }
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
