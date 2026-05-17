// doc-wrapper · collaborative markdown demo
//
// Architecture: dumb shell. Frontend knows MARKDOWN (via marked.js) and
// nothing else. Engine handles CRDT — it speaks neutral block-tree JSON.
//
//   textarea (raw markdown)
//        ↓ marked.lex
//   tokens (marked.js shape)
//        ↓ tokensToTree
//   neutral tree JSON  [{kind, spans:[{text, marks}]}, ...]
//        ↓ crsql_doc_apply
//   engine (tree-CRDT + Peritext + Fugue) handles ops + sync
//        ↓ crsql_doc_render
//   neutral tree JSON
//        ↓ treeToMarkdown
//   markdown text → textarea (when not focused)
//
// Frontend never says "Peritext", "block", "mark", "tree". Only knows
// markdown ↔ neutral-tree.

// marked owns parsing AND HTML rendering. We use lexer for the structured
// path into the engine and parse for the display path. Zero custom HTML/
// markdown logic in this file other than the tree ↔ tokens adapters.
import { lexer as marked_lexer, parse as marked_parse } from "./vendor/marked.esm.js";
import { initWasm } from "./vendor/loader.js";

const PEER_HUES = [200, 320, 90, 30, 260, 180, 350, 130];
let sqlite = null;
const world = { peers: [], nextSlot: 0 };

// ── markdown ↔ neutral-tree adapter ──────────────────────────────────

function tokensToTree(tokens) {
  // Walk top-level marked tokens; flatten into block list with kind/spans.
  const blocks = [];
  for (const t of tokens) {
    if (t.type === "space") continue;
    blocks.push(...tokenToBlocks(t));
  }
  return blocks;
}

function tokenToBlocks(t) {
  switch (t.type) {
    case "heading": {
      const kind =
        t.depth === 1 ? "heading-1" :
        t.depth === 2 ? "heading-2" :
        "heading-3";
      return [{ kind, spans: inlineSpans(t.tokens ?? [{ type: "text", text: t.text }]) }];
    }
    case "paragraph":
      return [{ kind: "paragraph", spans: inlineSpans(t.tokens ?? [{ type: "text", text: t.text }]) }];
    case "blockquote":
      // Flatten blockquote children — model each contained line/paragraph
      // as a separate `quote` block. Nested structure is out of scope.
      return (t.tokens ?? []).flatMap((c) =>
        tokenToBlocks(c).map((b) => ({ ...b, kind: "quote" })),
      );
    case "list":
      return (t.items ?? []).flatMap((it) => itemToBlocks(it, t.ordered));
    case "code":
      return [{ kind: "code", spans: [{ text: t.text ?? "", marks: [] }] }];
    case "hr":
      return [{ kind: "hr", spans: [] }];
    case "html":
    case "text":
      return [{ kind: "paragraph", spans: inlineSpans(t.tokens ?? [{ type: "text", text: t.text }]) }];
    default:
      return [{ kind: "paragraph", spans: [{ text: t.raw ?? "", marks: [] }] }];
  }
}

function itemToBlocks(item, ordered) {
  const kind = ordered ? "list-item-ord" : "list-item";
  // marked nests further blocks inside list items. Flatten: emit one
  // list-item block for the item text, then any nested blocks as siblings.
  const tokens = item.tokens ?? [];
  const out = [];
  let leading = [];
  for (const ct of tokens) {
    if (ct.type === "text" || ct.type === "paragraph") {
      leading.push(...inlineSpans(ct.tokens ?? [{ type: "text", text: ct.text }]));
    } else {
      if (leading.length) {
        out.push({ kind, spans: leading });
        leading = [];
      }
      out.push(...tokenToBlocks(ct));
    }
  }
  if (leading.length || out.length === 0) {
    out.push({ kind, spans: leading });
  }
  return out;
}

// Inline tokens → spans with marks. marked's inline types: text, strong,
// em, codespan, link, image, br. We support text/strong/em/codespan/link.
function inlineSpans(tokens) {
  const spans = [];
  walkInline(tokens, [], spans);
  return mergeAdjacent(spans);
}

function walkInline(tokens, marks, out) {
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        out.push({ text: t.text ?? "", marks: marks.slice() });
        break;
      case "strong":
        walkInline(t.tokens ?? [{ type: "text", text: t.text }], [...marks, { name: "bold" }], out);
        break;
      case "em":
        walkInline(t.tokens ?? [{ type: "text", text: t.text }], [...marks, { name: "italic" }], out);
        break;
      case "codespan":
        out.push({ text: t.text ?? "", marks: [...marks, { name: "code" }] });
        break;
      case "link":
        walkInline(
          t.tokens ?? [{ type: "text", text: t.text }],
          [...marks, { name: "link", value: t.href ?? "" }],
          out,
        );
        break;
      case "br":
        out.push({ text: "\n", marks: marks.slice() });
        break;
      default:
        if (t.raw) out.push({ text: t.raw, marks: marks.slice() });
    }
  }
}

function mergeAdjacent(spans) {
  const out = [];
  for (const s of spans) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && marksEqual(last.marks, s.marks)) {
      last.text += s.text;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}
function marksEqual(a, b) {
  if (a.length !== b.length) return false;
  const norm = (m) => `${m.name}|${m.value ?? ""}`;
  const as = a.map(norm).sort();
  const bs = b.map(norm).sort();
  return as.every((v, i) => v === bs[i]);
}

// Neutral tree → markdown source.
function treeToMarkdown(blocks) {
  const lines = [];
  for (const b of blocks) {
    const text = spansToMarkdown(b.spans ?? []);
    switch (b.kind) {
      case "heading-1": lines.push(`# ${text}`); break;
      case "heading-2": lines.push(`## ${text}`); break;
      case "heading-3": lines.push(`### ${text}`); break;
      case "list-item": lines.push(`- ${text}`); break;
      case "list-item-ord": lines.push(`1. ${text}`); break;
      case "quote": lines.push(`> ${text}`); break;
      case "code": lines.push("```\n" + text + "\n```"); break;
      case "hr": lines.push("---"); break;
      default: lines.push(text);
    }
  }
  return lines.join("\n\n");
}

// Convert engine's spans (marks-as-object) → markdown text with **/`/etc.
function spansToMarkdown(spans) {
  let out = "";
  for (const s of spans) {
    let txt = s.text ?? "";
    const marks = s.marks || {};
    // wrap order: code outermost (no recursion), then link, then strong, then em
    if (marks.code) txt = "`" + txt + "`";
    else {
      if (marks.italic) txt = `*${txt}*`;
      if (marks.bold) txt = `**${txt}**`;
      if (marks.link) txt = `[${txt}](${typeof marks.link === "string" ? marks.link : ""})`;
    }
    out += txt;
  }
  return out;
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
    const tree = tokensToTree(marked_lexer(md));
    await this.db.exec("SELECT crsql_doc_apply(?)", [JSON.stringify(tree)]);
    this._renderPreview(md);
    this._dumpState(tree);
  }

  // Pull engine state into the textarea (only when user isn't typing).
  async refreshFromEngine() {
    const treeJson = (await this.db.execA("SELECT crsql_doc_render()"))[0]?.[0] ?? "[]";
    const tree = JSON.parse(treeJson);
    const md = treeToMarkdown(tree);
    if (md !== this.editor.value && document.activeElement !== this.editor) {
      this.editor.value = md;
      this.lastMarkdown = md;
    }
    this._renderPreview(md);
    this._dumpState(tree);
  }

  _renderPreview(md) {
    if (this.preview) this.preview.innerHTML = marked_parse(md);
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
