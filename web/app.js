// fugue · collaborative text demo
// Each peer is an in-memory cr-sqlite database with a Fugue text-CRDT column.
// The textarea is bound bi-directionally: user typing → fugue ops on the local
// DB; sync-applied changes from peers → textarea (cursor-preserving rerender).
//
// "Online" peers participate in the global sync loop; "offline" peers don't
// push or pull. Edits made while offline queue locally and flush on reconnect.

import { initWasm } from "./vendor/loader.js";

const PEER_HUES = [200, 320, 90, 30, 260, 180, 350, 130];
let sqlite = null;

const world = {
  peers: /** @type {Peer[]} */ ([]),
  nextSlot: 0,
};

// ── string diff: textarea value → (pos, removed, inserted) ────────────────
// Computes the minimal single-range edit between two strings by finding the
// longest common prefix and suffix. Handles insert, delete, and replace.
function diff(oldStr, newStr) {
  const lo = oldStr.length;
  const ln = newStr.length;
  let p = 0;
  const min = Math.min(lo, ln);
  while (p < min && oldStr[p] === newStr[p]) p++;
  let so = lo - 1;
  let sn = ln - 1;
  while (so >= p && sn >= p && oldStr[so] === newStr[sn]) { so--; sn--; }
  return {
    pos: p,
    removed: oldStr.slice(p, so + 1),
    inserted: newStr.slice(p, sn + 1),
  };
}

function hexToBytes(hex) {
  if (!hex) return null;
  const clean = hex.replace(/^0x/i, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

function shortSite(hex) {
  return hex && typeof hex === "string" ? hex.slice(0, 6) : "—";
}

// Map an itemId back to its authoring peer's hue (itemId = "{site_hex}_{rand}").
function hueForItemId(itemId) {
  if (typeof itemId !== "string") return null;
  const us = itemId.indexOf("_");
  const sitePrefix = (us > 0 ? itemId.slice(0, us) : itemId).toLowerCase();
  const key = sitePrefix.slice(0, 8);
  for (const p of world.peers) {
    if (p.siteId && p.siteId.toLowerCase().startsWith(key)) return p.hue;
  }
  return null;
}

// ── Peer ──────────────────────────────────────────────────────────────────
class Peer {
  /** @param {{db: any, label: string, hue: number, slot: number}} init */
  constructor({ db, label, hue, slot }) {
    this.db = db;
    this.label = label;
    this.hue = hue;
    this.slot = slot;
    this.siteId = "";
    this.online = true;
    this.opCount = 0;
    this.pendingOps = 0;
    this.lastBody = "";
    this.lastRows = new Map();
    this.el = null;
    this.textarea = null;
    this._applyingRemote = false;
    this._inputChain = Promise.resolve();
  }

  static async create(slot) {
    const hue = PEER_HUES[slot % PEER_HUES.length];
    const label = String.fromCharCode(65 + slot); // A, B, C...
    const db = await sqlite.open(":memory:");
    await db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT)`);
    await db.exec(`SELECT crsql_as_crr('notes')`);
    await db.exec(`SELECT crsql_as_text_crdt('notes', 'body')`);
    await db.exec(`INSERT INTO notes (id, body) VALUES (1, '')`);
    const peer = new Peer({ db, label, hue, slot });
    peer.siteId = (await db.execA(`SELECT lower(hex(crsql_site_id()))`))[0][0];
    return peer;
  }

  bindEditor(textarea) {
    this.textarea = textarea;
    textarea.addEventListener("input", () => {
      // Serialize input handling so concurrent keystrokes can't race the awaits.
      this._inputChain = this._inputChain.then(() => this._handleInput()).catch((e) => {
        console.warn(`peer ${this.label} input failed:`, e);
      });
    });
  }

  async _handleInput() {
    if (this._applyingRemote) return;
    const ta = this.textarea;
    if (!ta) return;
    const newValue = ta.value;
    const oldValue = this.lastBody;
    if (newValue === oldValue) return;

    const d = diff(oldValue, newValue);
    // Optimistic — keep textarea + lastBody consistent before awaits.
    this.lastBody = newValue;

    try {
      if (d.removed.length) {
        await this.db.exec(
          `SELECT crsql_fugue_delete('notes', 'body', 1, ?, ?)`,
          [d.pos, d.pos + d.removed.length],
        );
        this.opCount++;
        if (!this.online) this.pendingOps++;
      }
      if (d.inserted.length) {
        await this.db.exec(
          `SELECT crsql_fugue_insert('notes', 'body', 1, ?, ?)`,
          [d.pos, d.inserted],
        );
        this.opCount++;
        if (!this.online) this.pendingOps++;
      }
    } catch (e) {
      console.warn(`peer ${this.label} edit failed:`, e);
      await this._reconcileFromDb();
      return;
    }

    // If a sync arrived between awaits the DB may be ahead of the textarea —
    // pull it back into the editor.
    await this._reconcileFromDb();
    this._renderHeader();
  }

  async _reconcileFromDb() {
    // Read the engine's materialised `body` column directly. The β-flat
    // render walker (core/rs/text-crdt-fugue/src/render.rs) keeps this
    // column correct for every backing-row change via the AFTER INSERT/
    // UPDATE/DELETE triggers — no client-side tree walk needed.
    const rows = await this.db.execA(`SELECT body FROM notes WHERE id=1`);
    const body = rows[0]?.[0] ?? "";
    if (this.textarea && body !== this.textarea.value) {
      this._applyingRemote = true;
      try {
        const ta = this.textarea;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = body;
        // Clamp cursor — naive but stable enough for a demo
        const ns = Math.min(start, body.length);
        const ne = Math.min(end, body.length);
        ta.setSelectionRange(ns, ne);
      } finally {
        this._applyingRemote = false;
      }
    }
    this.lastBody = body;
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
    await this._reconcileFromDb();
  }

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

  destroy() {
    this.db.close().catch(() => {});
    this.el?.remove();
  }
}

// ── DOM construction ─────────────────────────────────────────────────────
const template = /** @type {HTMLTemplateElement} */ (document.getElementById("peer-template"));
const peersHost = document.getElementById("peers");

function buildPeerEl(peer) {
  const frag = template.content.cloneNode(true);
  const article = frag.querySelector(".peer");
  article.style.setProperty("--hue", String(peer.hue));
  article.dataset.peer = peer.label;
  article.querySelector(".peer-name").textContent = `editor ${peer.label}`;
  article.querySelector(".peer-site").textContent = `site:${shortSite(peer.siteId)}`;

  peer.bindEditor(article.querySelector(".editor"));

  const cb = article.querySelector(".online-cb");
  cb.addEventListener("change", () => peer.setOnline(cb.checked));

  article.querySelector(".btn-close").addEventListener("click", () => removePeer(peer));
  return article;
}

async function addPeer() {
  const slot = world.nextSlot++;
  const peer = await Peer.create(slot);
  peer.el = buildPeerEl(peer);
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

// ── render loop: rows table + counters ────────────────────────────────────
let rafQueued = false;
function scheduleRender() {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(async () => {
    rafQueued = false;
    for (const peer of world.peers) await renderRows(peer);
  });
}

async function renderRows(peer) {
  if (!peer.el) return;

  let rows = [];
  try {
    rows = await peer.db.execA(
      `SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned
       FROM __crsql_fugue_notes_body WHERE row_pk = 1
       ORDER BY (parentItemId='' AND parentIdx=-2) DESC, itemId, idx`,
    );
  } catch (_) {}

  const summary = peer.el.querySelector(".rows-summary");
  if (summary) summary.textContent = `(${rows.length})`;

  const tbody = peer.el.querySelector("tbody");

  if (rows.length === 0) {
    if (!tbody.querySelector(".row-empty")) {
      tbody.innerHTML = `<tr class="row-empty"><td colspan="5">— no rows yet — type to begin —</td></tr>`;
    }
    peer.lastRows = new Map();
    return;
  } else {
    const empty = tbody.querySelector(".row-empty");
    if (empty) empty.remove();
  }

  const newKeys = new Set();
  for (const r of rows) {
    const key = `${r[0]}|${r[1]}`;
    newKeys.add(key);
    let tr = tbody.querySelector(`tr[data-key="${cssEscape(key)}"]`);
    if (!tr) {
      tr = document.createElement("tr");
      tr.dataset.key = key;
      tr.innerHTML = `<td class="c-item"></td><td class="c-idx"></td><td class="c-content"></td><td class="c-parent"></td><td class="c-flag"></td>`;
      tbody.appendChild(tr);
    }
    const [itemId, idx, content, parentItemId, parentIdx, tombstoned] = r;
    const isTomb = tombstoned === 1 || tombstoned === 1n;
    tr.classList.toggle("tombstoned", !!isTomb);

    const authorHue = hueForItemId(itemId);
    const itemCell = tr.children[0];
    itemCell.textContent = String(itemId).slice(0, 12) + "…";
    itemCell.style.color = authorHue != null ? `hsl(${authorHue}, 60%, 75%)` : "";

    tr.children[1].textContent = String(idx);
    tr.children[2].textContent = content == null ? "∅" : JSON.stringify(content).slice(0, 40);
    tr.children[3].textContent = parentItemId
      ? String(parentItemId).slice(0, 10) + "…:" + parentIdx
      : "root";
    tr.children[4].textContent = isTomb ? "✕" : "";
  }
  // remove rows no longer present
  for (const key of peer.lastRows.keys()) {
    if (!newKeys.has(key)) {
      const tr = tbody.querySelector(`tr[data-key="${cssEscape(key)}"]`);
      tr?.remove();
    }
  }
  const lastRowsNew = new Map();
  for (const r of rows) lastRowsNew.set(`${r[0]}|${r[1]}`, r);
  peer.lastRows = lastRowsNew;
}

function cssEscape(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}

// ── sync loop: every 600ms, sync between online peers only ───────────────
async function syncTick() {
  const online = world.peers.filter((p) => p.online);
  if (online.length < 2) return;
  for (const a of online) {
    for (const b of online) {
      if (a === b) continue;
      try {
        const changes = await a.pullChanges(b.siteId);
        if (changes.length) await b.applyChanges(changes);
      } catch (e) {
        console.warn(`sync ${a.label}→${b.label} failed:`, e);
      }
    }
  }
}

setInterval(syncTick, 600);
setInterval(scheduleRender, 250);

// ── boot ──────────────────────────────────────────────────────────────────
async function boot() {
  sqlite = await initWasm((file) => `./vendor/${file}`);
  await addPeer();
  await addPeer();
}

document.getElementById("add-peer").addEventListener("click", () => addPeer());

// Inspection hooks for the smoke test — handy for debugging sync.
window.__world = world;
window.__inspect = async (label) => {
  const p = world.peers.find((x) => x.label === label);
  if (!p) return null;
  const renderedBody = (await p.db.execA(`SELECT crsql_fugue_render('notes','body',1)`))[0]?.[0];
  const materialBody = (await p.db.execA(`SELECT body FROM notes WHERE id=1`))[0]?.[0];
  const fugueRows = await p.db.execA(`SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned FROM __crsql_fugue_notes_body WHERE row_pk=1`);
  const changes = await p.db.execA(`SELECT lower(hex(site_id)), "table", cid, col_version, db_version FROM crsql_changes ORDER BY db_version`);
  return { site: p.siteId, renderedBody, materialBody, fugueRows, changes };
};

boot().catch((e) => {
  console.error("boot failed:", e);
  document.body.innerHTML = `<div style="padding:48px;text-align:center;color:#ff7c7c;font-family:JetBrains Mono,monospace"><strong>engine fault:</strong> ${e?.message ?? "unknown"}</div>`;
});
