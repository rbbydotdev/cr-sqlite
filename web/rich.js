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
  }

  async _handleInput() {
    const md = this.editor.value;
    if (md === this.lastMarkdown) return;
    this.lastMarkdown = md;
    const mdast = fromMarkdown(md);
    const tree = mdastToTree(mdast);
    await this.db.exec("SELECT crsql_doc_apply(?)", [JSON.stringify(tree)]);
    this._renderPreview(mdast);
    this._dumpState(tree);
  }

  async refreshFromEngine() {
    const treeJson = (await this.db.execA("SELECT crsql_doc_render()"))[0]?.[0] ?? "[]";
    const tree = JSON.parse(treeJson);
    const mdast = treeToMdast(tree);
    const md = toMarkdown(mdast);
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
    for (const r of rows) {
      await this.db.exec(
        `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r,
      );
    }
    await this.refreshFromEngine();
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
  await addPeer();
  await addPeer();
}
document.getElementById("add-peer").addEventListener("click", () => addPeer());
window.__world = world;

boot().catch((e) => {
  console.error("boot failed:", e);
  document.body.innerHTML = `<div style="padding:48px;text-align:center;color:#ff7c7c;font-family:JetBrains Mono,monospace"><strong>engine fault:</strong> ${e?.message ?? "unknown"}</div>`;
});
