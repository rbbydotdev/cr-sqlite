// peritext · collaborative rich-text demo
//
// Each peer is an in-memory cr-sqlite database with the four-layer
// composition: blocks table + Peritext column + tree CRDT + (caller-chosen)
// fractional indices. UI surface mirrors the plain-text demo (peer cards,
// online toggle, sync loop) but content is structured: an ordered list of
// blocks, each with a kind (paragraph / heading / bullet / quote / code)
// and a Peritext-managed body. Inline marks (bold/italic/link) apply via a
// toolbar against the current selection.
//
// Sync: identical to the plain demo — pull/apply via crsql_changes every
// 600ms between online peers.

import { initWasm } from "./vendor/loader.js";

const PEER_HUES = [200, 320, 90, 30, 260, 180, 350, 130];
const ROOT = new Uint8Array([0x01]);
const TRASH = new Uint8Array([0xff]);
const KINDS = ["paragraph", "heading-1", "heading-2", "bullet", "quote", "code"];

let sqlite = null;
const world = { peers: [], nextSlot: 0 };

// ── utility: blob/hex/diff ───────────────────────────────────────────────
function hexToBytes(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
function shortSite(hex) { return hex && typeof hex === "string" ? hex.slice(0, 6) : "—"; }

// id := 8 random bytes prefixed with `site_hex` first 4 bytes for ownership hint
function makeBlockId(siteHex) {
  const out = new Uint8Array(16);
  const sb = hexToBytes(siteHex);
  if (sb) out.set(sb.slice(0, 4));
  crypto.getRandomValues(out.subarray(4));
  return out;
}

function diff(oldStr, newStr) {
  const lo = oldStr.length, ln = newStr.length;
  let p = 0;
  const min = Math.min(lo, ln);
  while (p < min && oldStr[p] === newStr[p]) p++;
  let so = lo - 1, sn = ln - 1;
  while (so >= p && sn >= p && oldStr[so] === newStr[sn]) { so--; sn--; }
  return { pos: p, removed: oldStr.slice(p, so + 1), inserted: newStr.slice(p, sn + 1) };
}

// ── Peritext JSON helpers ────────────────────────────────────────────────
function parseBody(json) {
  if (!json) return [{ text: "", marks: {} }];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [{ text: "", marks: {} }];
  } catch (_) {
    return [{ text: "", marks: {} }];
  }
}
function plainText(spans) {
  return spans.map((s) => s.text || "").join("");
}
function renderSpansToHTML(spans) {
  if (!spans.length || (spans.length === 1 && !spans[0].text)) {
    return '<span class="empty">(empty)</span>';
  }
  return spans.map((s) => {
    const t = escapeHtml(s.text || "");
    if (!s.marks || Object.keys(s.marks).length === 0) return t;
    let out = t;
    if (s.marks.bold) out = `<b>${out}</b>`;
    if (s.marks.italic) out = `<i>${out}</i>`;
    if (s.marks.link) {
      const url = typeof s.marks.link === "string" ? s.marks.link : "#";
      out = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${out}</a>`;
    }
    return out;
  }).join("");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── tree-CRDT helpers ────────────────────────────────────────────────────
// Fractional-index strings, lex-comparable. Caller picks per-op; for the
// demo we just generate "between" two existing slots cheaply.
function fracBetween(left, right) {
  // Both "a"-style ASCII; we just pick midpoint by appending. Crude but
  // correct enough for a demo (no fractional precision concerns).
  if (!left && !right) return "m";
  if (!left) return shiftDown(right);
  if (!right) return shiftUp(left);
  // pad shorter to longer, find first differing char midpoint
  const max = Math.max(left.length, right.length);
  const l = left.padEnd(max, " ");
  const r = right.padEnd(max, " ");
  for (let i = 0; i < max; i++) {
    if (l.charCodeAt(i) !== r.charCodeAt(i)) {
      const mid = Math.floor((l.charCodeAt(i) + r.charCodeAt(i)) / 2);
      if (mid > l.charCodeAt(i)) {
        return l.slice(0, i) + String.fromCharCode(mid);
      }
      // need to append after l[i]
      return l.slice(0, i + 1) + "m";
    }
  }
  return left + "m";
}
function shiftUp(s) {
  // "next after s"
  const last = s.charCodeAt(s.length - 1);
  if (last < 122) return s.slice(0, -1) + String.fromCharCode(last + 1);
  return s + "m";
}
function shiftDown(s) {
  const first = s.charCodeAt(0);
  if (first > 98) return String.fromCharCode(first - 1) + s.slice(1);
  return "a" + s;
}

// ── Peer ─────────────────────────────────────────────────────────────────
class Peer {
  constructor({ db, label, hue, slot }) {
    Object.assign(this, { db, label, hue, slot });
    this.siteId = "";
    this.online = true;
    this.lamportTs = 0;
    this.pendingOps = 0;
    this.opCount = 0;
    this.el = null;
    this.docEl = null;
    this._applyingRemote = false;
    this._blockInputChains = new Map(); // blockId → Promise chain
    this._activeBlockId = null;
    this._activeRange = null; // { start, end }
    this._localBlocks = new Map(); // blockId → { kind, plainText, bodyJson, depth, parent, frac }
  }

  static async create(slot) {
    const hue = PEER_HUES[slot % PEER_HUES.length];
    const label = String.fromCharCode(65 + slot);
    const db = await sqlite.open(":memory:");
    await db.exec(`CREATE TABLE blocks (id BLOB PRIMARY KEY NOT NULL, kind TEXT NOT NULL DEFAULT '', attrs TEXT, body TEXT)`);
    await db.exec(`SELECT crsql_as_crr('blocks')`);
    await db.exec(`SELECT crsql_as_peritext('blocks', 'body')`);
    await db.exec(`SELECT crsql_create_tree('doc')`);
    // sentinels (root + trash) — shared id convention across peers so concurrent
    // INSERTs of the same id resolve cleanly via cr-sqlite per-cell LWW.
    await db.exec(`INSERT INTO blocks (id, kind) VALUES (?, 'document')`, [ROOT]);
    await db.exec(`INSERT INTO blocks (id, kind) VALUES (?, 'trash')`, [TRASH]);

    const peer = new Peer({ db, label, hue, slot });
    peer.siteId = (await db.execA(`SELECT lower(hex(crsql_site_id()))`))[0][0];
    return peer;
  }

  bumpTs() { return ++this.lamportTs; }
  async refreshLamport() {
    // catch up to max ts seen in marks table after sync
    const r = await this.db.execA(`SELECT COALESCE(MAX(lamport_ts), 0) FROM __crsql_peritext_blocks_body_marks`);
    this.lamportTs = Math.max(this.lamportTs, Number(r[0]?.[0] ?? 0));
    const r2 = await this.db.execA(`SELECT COALESCE(MAX(lamport_ts), 0) FROM doc__tree_ops`);
    this.lamportTs = Math.max(this.lamportTs, Number(r2[0]?.[0] ?? 0));
  }

  actor() {
    const bytes = hexToBytes(this.siteId);
    return bytes ?? new Uint8Array([this.slot]);
  }

  // ─── block operations ─────────────────────────────────────────────
  async addBlockAfter(prevId) {
    const id = makeBlockId(this.siteId);
    const blocks = await this._readBlocksFlat();
    let frac;
    if (!prevId) {
      // append at end of root children
      const rootChildren = blocks.filter((b) => bufEq(b.parent, ROOT));
      const last = rootChildren[rootChildren.length - 1];
      frac = fracBetween(last?.frac ?? "", "");
    } else {
      const i = blocks.findIndex((b) => bufEq(b.id, prevId));
      const cur = blocks[i];
      const next = blocks.slice(i + 1).find((b) => bufEq(b.parent, cur.parent));
      frac = fracBetween(cur?.frac ?? "", next?.frac ?? "");
    }
    await this.db.exec(`INSERT INTO blocks (id, kind) VALUES (?, 'paragraph')`, [id]);
    await this.db.exec(
      `SELECT crsql_tree_move('doc', ?, ?, ?, ?, ?)`,
      [id, ROOT, new TextEncoder().encode(frac), this.bumpTs(), this.actor()],
    );
    if (!this.online) this.pendingOps += 2;
    this.opCount += 2;
    await this._rebuildDOM();
    this._focusBlock(id, 0);
  }

  async deleteBlock(id) {
    if (bufEq(id, ROOT) || bufEq(id, TRASH)) return;
    await this.db.exec(
      `SELECT crsql_tree_move('doc', ?, ?, '', ?, ?)`,
      [id, TRASH, this.bumpTs(), this.actor()],
    );
    if (!this.online) this.pendingOps++;
    this.opCount++;
    await this._rebuildDOM();
  }

  async changeKind(id, kind) {
    await this.db.exec(`UPDATE blocks SET kind = ? WHERE id = ?`, [kind, id]);
    if (!this.online) this.pendingOps++;
    this.opCount++;
    await this._rebuildDOM();
  }

  // ─── text editing within a block ─────────────────────────────────
  async _onBlockInput(blockId, newPlainText) {
    if (this._applyingRemote) return;
    const local = this._localBlocks.get(bufKey(blockId));
    const oldPlain = local?.plainText ?? "";
    if (newPlainText === oldPlain) return;
    const d = diff(oldPlain, newPlainText);
    // Optimistic — track locally so subsequent input events diff correctly
    if (local) local.plainText = newPlainText;
    try {
      if (d.removed.length) {
        await this.db.exec(
          `SELECT crsql_fugue_delete('blocks', 'body', ?, ?, ?)`,
          [blockId, d.pos, d.pos + d.removed.length],
        );
        this.opCount++;
        if (!this.online) this.pendingOps++;
      }
      if (d.inserted.length) {
        await this.db.exec(
          `SELECT crsql_fugue_insert('blocks', 'body', ?, ?, ?)`,
          [blockId, d.pos, d.inserted],
        );
        this.opCount++;
        if (!this.online) this.pendingOps++;
      }
    } catch (e) {
      console.warn(`peer ${this.label} block edit failed:`, e);
    }
    await this._refreshBlockFromDb(blockId);
    this._renderHeader();
  }

  // ─── marks ────────────────────────────────────────────────────────
  async applyMark(name, value) {
    if (!this._activeBlockId || !this._activeRange) return;
    const { start, end } = this._activeRange;
    if (start >= end) return;
    // for link, end_side = AFTER so it doesn't grow on append
    const startSide = 0; // before
    const endSide = name === "link" ? 1 : 0;
    try {
      await this.db.exec(
        `SELECT crsql_peritext_mark('blocks', 'body', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          this._activeBlockId, start, end, name, value,
          startSide, endSide,
          this.bumpTs(), this.actor(),
        ],
      );
      this.opCount++;
      if (!this.online) this.pendingOps++;
    } catch (e) {
      console.warn(`peer ${this.label} mark failed:`, e);
    }
    await this._refreshBlockFromDb(this._activeBlockId);
  }

  // ─── DOM rebuild ──────────────────────────────────────────────────
  async _readBlocksFlat() {
    const rows = await this.db.execA(`
      WITH RECURSIVE walk(node, parent, depth, ord_path, frac) AS (
          SELECT s.node_id, s.parent_id, 0, CAST(s.meta AS BLOB), CAST(s.meta AS TEXT)
          FROM   doc__tree_state s WHERE s.parent_id = ?
        UNION ALL
          SELECT s.node_id, s.parent_id, w.depth + 1,
                 CAST(w.ord_path || X'00' || s.meta AS BLOB),
                 CAST(s.meta AS TEXT)
          FROM   doc__tree_state s, walk w
          WHERE  s.parent_id = w.node
      )
      SELECT w.node, w.parent, w.depth, w.frac, b.kind, b.body
      FROM   walk w JOIN blocks b ON b.id = w.node
      WHERE  b.id != ?
      ORDER  BY w.ord_path
    `, [ROOT, TRASH]);
    return rows.map((r) => ({
      id: r[0], parent: r[1], depth: r[2], frac: r[3],
      kind: r[4], bodyJson: r[5] ?? "[]",
    }));
  }

  async _rebuildDOM() {
    if (!this.docEl) return;
    const blocks = await this._readBlocksFlat();
    const seen = new Set();
    let prev = null;

    for (const b of blocks) {
      const key = bufKey(b.id);
      seen.add(key);
      const spans = parseBody(b.bodyJson);
      const plain = plainText(spans);
      this._localBlocks.set(key, { kind: b.kind, plainText: plain, bodyJson: b.bodyJson, depth: b.depth, parent: b.parent, frac: b.frac });

      let row = this.docEl.querySelector(`.block[data-id="${key}"]`);
      if (!row) {
        row = this._makeBlockEl(b.id, key);
        if (prev?.nextSibling) this.docEl.insertBefore(row, prev.nextSibling);
        else this.docEl.appendChild(row);
      }
      this._updateBlockEl(row, b, spans, plain);
      prev = row;
    }

    // remove DOM rows no longer in doc
    for (const el of [...this.docEl.querySelectorAll(".block")]) {
      if (!seen.has(el.dataset.id)) el.remove();
    }
    this._renderRowsTable(blocks);
  }

  _makeBlockEl(id, key) {
    const row = document.createElement("div");
    row.className = "block";
    row.dataset.id = key;
    row.innerHTML = `
      <select class="block-kind">
        ${KINDS.map((k) => `<option value="${k}">${k}</option>`).join("")}
      </select>
      <div class="block-content" contenteditable="plaintext-only" spellcheck="false"></div>
      <button class="block-trash" title="delete block">×</button>
    `;
    const sel = row.querySelector(".block-kind");
    sel.addEventListener("change", () => this.changeKind(id, sel.value));

    const content = row.querySelector(".block-content");
    content.addEventListener("input", () => {
      this._activeBlockId = id;
      const chain = (this._blockInputChains.get(key) ?? Promise.resolve())
        .then(() => this._onBlockInput(id, content.textContent ?? ""))
        .catch((e) => console.warn(`block input failed:`, e));
      this._blockInputChains.set(key, chain);
    });
    content.addEventListener("focus", () => { this._activeBlockId = id; });
    content.addEventListener("keyup", () => this._captureSelection(content));
    content.addEventListener("mouseup", () => this._captureSelection(content));
    content.addEventListener("keydown", (e) => this._handleHotkey(e, id));

    row.querySelector(".block-trash").addEventListener("click", () => this.deleteBlock(id));
    return row;
  }

  _updateBlockEl(row, b, spans, plain) {
    row.dataset.kind = b.kind;
    const sel = row.querySelector(".block-kind");
    if (sel.value !== b.kind) sel.value = b.kind;

    const content = row.querySelector(".block-content");
    const html = renderSpansToHTML(spans);
    // Only patch innerHTML if user isn't typing here right now — preserves
    // caret. We detect "user is typing" by whether this element is focused.
    if (document.activeElement !== content) {
      content.innerHTML = html;
    } else {
      // Compare textContent — if textContent matches the local plain we just
      // wrote, mark rendering changed but text didn't. Skip innerHTML update
      // (preserves caret) and let _refreshBlockFromDb handle the next pass.
      const currentText = content.textContent ?? "";
      if (currentText === plain) {
        // text-equal; re-render marks only if HTML differs significantly.
        // For simplicity, only re-render if the user has no selection here.
        const s = window.getSelection();
        if (!s || s.rangeCount === 0 || !content.contains(s.anchorNode)) {
          content.innerHTML = html;
        }
        // else: leave inner HTML alone; will refresh on next blur/refocus
      } else {
        content.innerHTML = html;
      }
    }
  }

  async _refreshBlockFromDb(blockId) {
    const r = await this.db.execA(`SELECT kind, body FROM blocks WHERE id = ?`, [blockId]);
    if (!r.length) {
      // block deleted/moved-to-trash by remote — full rebuild
      await this._rebuildDOM();
      return;
    }
    const [kind, bodyJson] = r[0];
    const spans = parseBody(bodyJson ?? "[]");
    const plain = plainText(spans);
    const key = bufKey(blockId);
    const local = this._localBlocks.get(key) ?? {};
    local.kind = kind;
    local.bodyJson = bodyJson ?? "[]";
    local.plainText = plain;
    this._localBlocks.set(key, local);

    const row = this.docEl?.querySelector(`.block[data-id="${key}"]`);
    if (row) this._updateBlockEl(row, { kind, bodyJson, id: blockId }, spans, plain);
  }

  _focusBlock(id, pos) {
    const key = bufKey(id);
    const row = this.docEl?.querySelector(`.block[data-id="${key}"]`);
    if (!row) return;
    const content = row.querySelector(".block-content");
    content?.focus();
    if (content && content.firstChild) {
      const range = document.createRange();
      const node = content.firstChild;
      const offset = Math.min(pos, node.nodeValue?.length ?? 0);
      try {
        range.setStart(node, offset);
        range.setEnd(node, offset);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}
    }
  }

  _captureSelection(content) {
    const s = window.getSelection();
    if (!s || s.rangeCount === 0) return;
    const r = s.getRangeAt(0);
    if (!content.contains(r.startContainer) || !content.contains(r.endContainer)) return;
    const start = textOffsetIn(content, r.startContainer, r.startOffset);
    const end = textOffsetIn(content, r.endContainer, r.endOffset);
    this._activeRange = { start: Math.min(start, end), end: Math.max(start, end) };
  }

  _handleHotkey(e, id) {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === "b") { e.preventDefault(); this._captureSelection(e.target); this.applyMark("bold", null); }
    else if (e.key === "i") { e.preventDefault(); this._captureSelection(e.target); this.applyMark("italic", null); }
    else if (e.key === "k") {
      e.preventDefault();
      this._captureSelection(e.target);
      const url = prompt("link URL?", "https://");
      if (url) this.applyMark("link", url);
    } else if (e.key === "Enter" && !e.shiftKey) {
      // Enter at end of block → new paragraph below
      e.preventDefault();
      this.addBlockAfter(id);
    }
  }

  // ─── headers + tables ─────────────────────────────────────────────
  setOnline(online) {
    if (this.online === online) return;
    this.online = online;
    if (online) this.pendingOps = 0;
    this._renderHeader();
  }

  _renderHeader() {
    if (!this.el) return;
    this.el.classList.toggle("offline", !this.online);
    const cb = this.el.querySelector(".online-cb");
    if (cb && cb.checked !== this.online) cb.checked = this.online;
    const label = this.el.querySelector(".online-label");
    if (label) label.textContent = this.online ? "online" : "offline";
    const pending = this.el.querySelector(".pending");
    if (pending) {
      const show = !this.online && this.pendingOps > 0;
      pending.hidden = !show;
      pending.textContent = `${this.pendingOps} pending`;
    }
  }

  _renderRowsTable(blocks) {
    const summary = this.el?.querySelector(".rows-summary");
    if (summary) summary.textContent = `(${blocks.length})`;
    const tbody = this.el?.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = blocks.map((b) => `
      <tr>
        <td class="c-item">${bufKey(b.id).slice(0, 8)}…</td>
        <td class="c-idx">${b.depth}</td>
        <td class="c-content">${escapeHtml(b.kind)}</td>
        <td class="c-parent" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(b.bodyJson ?? "")}</td>
      </tr>
    `).join("") || `<tr class="row-empty"><td colspan="4">— no blocks yet —</td></tr>`;
  }

  // ─── sync ────────────────────────────────────────────────────────
  async pullChanges(excludeSiteHex) {
    return await this.db.execA(
      `SELECT "table","pk","cid","val","col_version","db_version",site_id,cl,seq
       FROM crsql_changes WHERE site_id IS NOT ?`,
      [hexToBytes(excludeSiteHex)],
    );
  }
  async applyChanges(rows) {
    if (!rows.length) return;
    this._applyingRemote = true;
    try {
      for (const r of rows) {
        await this.db.exec(
          `INSERT INTO crsql_changes ("table","pk","cid","val","col_version","db_version",site_id,cl,seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          r,
        );
      }
    } finally { this._applyingRemote = false; }
    await this.refreshLamport();
    await this._rebuildDOM();
  }

  destroy() {
    this.db.close().catch(() => {});
    this.el?.remove();
  }
}

function bufKey(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function bufEq(a, b) {
  const ua = a instanceof Uint8Array ? a : new Uint8Array(a);
  const ub = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (ua.length !== ub.length) return false;
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

function textOffsetIn(root, node, offset) {
  // Compute char offset of `node`+offset within `root` (treats all text nodes
  // in document order). Stops short and returns the offset if it finds node.
  let count = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n = walker.nextNode();
  while (n) {
    if (n === node) return count + offset;
    count += (n.nodeValue ?? "").length;
    n = walker.nextNode();
  }
  return count;
}

// ── DOM bootstrap ────────────────────────────────────────────────────────
const template = document.getElementById("peer-template");
const peersHost = document.getElementById("peers");

async function buildPeerEl(peer) {
  const frag = template.content.cloneNode(true);
  const article = frag.querySelector(".peer");
  article.style.setProperty("--hue", String(peer.hue));
  article.dataset.peer = peer.label;
  article.querySelector(".peer-name").textContent = `editor ${peer.label}`;
  article.querySelector(".peer-site").textContent = `site:${shortSite(peer.siteId)}`;
  peer.el = article;
  peer.docEl = article.querySelector('[data-role="doc"]');

  const cb = article.querySelector(".online-cb");
  cb.addEventListener("change", () => peer.setOnline(cb.checked));
  article.querySelector(".btn-close").addEventListener("click", () => removePeer(peer));
  article.querySelector('[data-role="add-block"]').addEventListener("click", () => peer.addBlockAfter(null));

  for (const btn of article.querySelectorAll(".marks-toolbar button")) {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.mark;
      let value = null;
      if (name === "link") {
        value = prompt("link URL?", "https://");
        if (!value) return;
      }
      await peer.applyMark(name, value);
    });
  }

  // initial paragraph block so the editor isn't empty
  await peer.addBlockAfter(null);
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

// ── sync loop ────────────────────────────────────────────────────────────
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

// ── boot ────────────────────────────────────────────────────────────────
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
