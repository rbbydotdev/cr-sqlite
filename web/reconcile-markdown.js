// Source-text-preserving markdown reconciliation.
//
// Given the user's current markdown source and a new mdast representing
// the desired state, produce updated source that preserves the user's
// syntactic choices (list marker, fence char, heading style, whitespace)
// for every block that didn't actually change.
//
// Markdown-aware, sync-unaware: applies equally to CRDT merges, LWW
// writes, file reloads, server pushes. Pure function.
//
// Returns { text, preserved }. `preserved` is the list of byte-range
// pairs (in user source → in new text) for blocks copied verbatim, so a
// caller can map a cursor offset through the reconciliation.
//
// Block granularity descends into lists: each list item is its own
// alignment unit. So a user-typed `- one\n\n- two` matched against an
// engine that adds a third item preserves items 1 and 2 verbatim
// (blank lines and all) and only synthesizes the new third item.
// Blank lines between blocks are NOT alignment units — they live in
// the gap text between adjacent block positions and ride along when
// both surrounding blocks are matched.

import { fromMarkdown, toMarkdown } from "./vendor/unified.esm.js";

export function reconcileMarkdown(userText, newMdast) {
  const userMdast = fromMarkdown(userText);
  const u = flatten(userMdast.children ?? []);
  const n = flatten(newMdast.children ?? []);
  const align = pairReplaces(lcsAlign(u, n));

  const parts = [];
  const preserved = [];
  let cursor = 0;
  let prevMatchUserIdx = -1;
  let lastWasMatch = false;
  const push = (s) => { parts.push(s); cursor += s.length; };

  // Gap text preceding a user-positioned step (match or replace). Uses
  // user's verbatim source between adjacent units so blank lines stay
  // intact; falls back to "\n\n" when blocks were dropped/inserted in
  // between.
  const pushGapBefore = (userIdx, slotStart) => {
    if (parts.length === 0) {
      if (userIdx === 0) push(userText.slice(0, slotStart));
    } else if (lastWasMatch && userIdx === prevMatchUserIdx + 1) {
      push(userText.slice(posEnd(u[prevMatchUserIdx].node), slotStart));
    } else {
      push("\n\n");
    }
  };

  for (const step of align) {
    if (step.replace) {
      // engine's content rendered at the user's slot — preserves the
      // user's gap text around this position even though the block
      // itself changed (e.g. remote edit to its text)
      const unit = u[step.u];
      const bStart = posStart(unit.node);
      pushGapBefore(step.u, bStart);
      push(renderUnit(n[step.n]));
      prevMatchUserIdx = step.u;
      lastWasMatch = true;
    } else if (step.u != null && step.n != null) {
      // exact match: copy user's source verbatim
      const unit = u[step.u];
      const bStart = posStart(unit.node);
      const bEnd   = posEnd(unit.node);
      pushGapBefore(step.u, bStart);
      const blockText = userText.slice(bStart, bEnd);
      preserved.push({
        oldStart: bStart, oldEnd: bEnd,
        newStart: cursor, newEnd: cursor + blockText.length,
      });
      push(blockText);
      prevMatchUserIdx = step.u;
      lastWasMatch = true;
    } else if (step.n != null) {
      // pure engine-only insert
      if (parts.length > 0) push("\n\n");
      push(renderUnit(n[step.n]));
      lastWasMatch = false;
    }
    // user-only: drop
  }

  if (lastWasMatch && prevMatchUserIdx === u.length - 1) {
    push(userText.slice(posEnd(u[prevMatchUserIdx].node)));
  }

  return { text: parts.join(""), preserved };
}

// Post-process LCS output: pair an unmatched user block with an
// unmatched engine block in the same "edit region" as an in-place
// replace. This preserves the user's gap text around the edited block
// instead of treating it as a drop + insert (which collapses the gap
// to synthesized "\n\n").
function pairReplaces(align) {
  const out = [];
  let pendingUser = [];
  let pendingEngine = [];
  const flush = () => {
    const pairs = Math.min(pendingUser.length, pendingEngine.length);
    for (let k = 0; k < pairs; k++) {
      out.push({ u: pendingUser[k].u, n: pendingEngine[k].n, replace: true });
    }
    for (let k = pairs; k < pendingUser.length; k++) out.push(pendingUser[k]);
    for (let k = pairs; k < pendingEngine.length; k++) out.push(pendingEngine[k]);
    pendingUser = [];
    pendingEngine = [];
  };
  for (const step of align) {
    if (step.u != null && step.n != null) {
      flush();
      out.push(step);
    } else if (step.u != null) {
      pendingUser.push(step);
    } else {
      pendingEngine.push(step);
    }
  }
  flush();
  return out;
}

// Map an offset in the old user text to the closest offset in the new
// text. Returns the linear-translated offset if the old position lay in
// a preserved span; otherwise snaps to the nearest preserved boundary,
// preferring the end of the previous preserved span.
export function mapOffset(preserved, oldOffset, newLen) {
  if (!preserved.length) return Math.min(oldOffset, newLen);
  let lastEnd = 0;
  for (const p of preserved) {
    if (oldOffset >= p.oldStart && oldOffset <= p.oldEnd) {
      return p.newStart + (oldOffset - p.oldStart);
    }
    if (oldOffset < p.oldStart) return lastEnd;
    lastEnd = p.newEnd;
  }
  return Math.min(lastEnd, newLen);
}

// ── flattening ────────────────────────────────────────────────────────
// Lists are expanded so each item becomes its own alignment unit. A
// 3-item list contributes 3 units, not 1. This way, when the engine
// adds an item to a list the user typed, the other items stay
// preserved verbatim instead of the whole list being re-rendered.

function flatten(children) {
  const out = [];
  for (const node of children) {
    if (node.type === "list") {
      for (const item of node.children ?? []) {
        out.push({ kind: "li", ordered: !!node.ordered, node: item });
      }
    } else {
      out.push({ kind: "b", node });
    }
  }
  return out;
}

function posStart(node) { return node.position?.start?.offset ?? 0; }
function posEnd(node)   { return node.position?.end?.offset ?? 0; }

// Synthesize markdown for an engine-only unit. List items are wrapped
// back into a single-item list before serialization so toMarkdown emits
// them with a bullet marker.
function renderUnit(unit) {
  let node = unit.node;
  if (unit.kind === "li") {
    node = { type: "list", ordered: unit.ordered, spread: false, children: [node] };
  }
  return toMarkdown({ type: "root", children: [node] }, { bullet: "-" })
    .replace(/\n+$/, "");
}

// ── LCS alignment over semEq ──────────────────────────────────────────

function lcsAlign(uArr, nArr) {
  const lu = uArr.length, ln = nArr.length;
  const dp = Array.from({ length: lu + 1 }, () => new Int32Array(ln + 1));
  const fu = uArr.map(unitFingerprint);
  const fn = nArr.map(unitFingerprint);
  const eq = (i, j) => fpEq(fu[i], fn[j]);

  for (let i = 0; i < lu; i++) {
    for (let j = 0; j < ln; j++) {
      dp[i + 1][j + 1] = eq(i, j)
        ? dp[i][j] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = lu, j = ln;
  while (i > 0 && j > 0) {
    if (eq(i - 1, j - 1)) { out.push({ u: i - 1, n: j - 1 }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { out.push({ u: i - 1, n: null }); i--; }
    else { out.push({ u: null, n: j - 1 }); j--; }
  }
  while (i > 0) { out.push({ u: i - 1, n: null }); i--; }
  while (j > 0) { out.push({ u: null, n: j - 1 }); j--; }
  return out.reverse();
}

// ── Semantic equality ─────────────────────────────────────────────────

function fpEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// A unit's fingerprint includes its kind (block vs list-item) and, for
// list items, its parent list's orderedness. So an ordered list-item
// can't match an unordered one, and a list-item can't match a paragraph
// even if their text content matches.
function unitFingerprint(unit) {
  if (unit.kind === "li") {
    return { u: "li", o: unit.ordered, fp: fingerprint(unit.node) };
  }
  return { u: "b", fp: fingerprint(unit.node) };
}

function fingerprint(node) {
  if (!node) return null;
  const k = () => (node.children ?? []).map(fingerprint);
  switch (node.type) {
    case "paragraph":     return { t: "p",  k: k() };
    case "heading":       return { t: "h",  d: node.depth, k: k() };
    case "list":          return { t: "l",  o: !!node.ordered, k: k() };
    case "listItem":      return { t: "li", k: normalizeItemKids(k()) };
    case "blockquote":    return { t: "bq", k: k() };
    case "code":          return { t: "code", lang: node.lang ?? null, v: node.value ?? "" };
    case "thematicBreak": return { t: "hr" };
    case "html":          return { t: "html", v: node.value ?? "" };
    case "text":          return { t: "txt", v: normWs(node.value ?? "") };
    case "inlineCode":    return { t: "ic", v: node.value ?? "" };
    case "strong":        return { t: "b",  k: k() };
    case "emphasis":      return { t: "i",  k: k() };
    case "delete":        return { t: "s",  k: k() };
    case "link":          return { t: "a",  u: node.url ?? "", k: k() };
    case "image":         return { t: "img", u: node.url ?? "", a: node.alt ?? "" };
    case "break":         return { t: "br" };
    default:              return { t: node.type, k: k() };
  }
}

function normWs(s) { return s.replace(/\s+/g, " ").trim(); }

// `mdast-util-from-markdown` parses `- ` (empty item) as `listItem[]`,
// while `treeToMdast` always wraps spans in a paragraph, emitting
// `listItem[paragraph[]]`. Treat the two shapes as equivalent so an
// in-progress empty list-item matches the engine's rendered shape.
function normalizeItemKids(kids) {
  if (kids.length === 1 && JSON.stringify(kids[0]) === '{"t":"p","k":[]}') {
    return [];
  }
  return kids;
}
