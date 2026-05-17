//! `crsql_doc_apply(tree_json)` — receive a neutral block-tree JSON,
//! diff against current state, emit CRDT ops.
//!
//! Wire format (frontend → engine):
//!     [{"kind": "paragraph", "spans": [{"text": "Hello ", "marks": []},
//!                                       {"text": "world",  "marks": [{"name":"bold"}]}]},
//!      {"kind": "heading-1", "spans": [{"text": "Title", "marks": []}]}]
//!
//! Engine is markdown-unaware. Block kinds are opaque strings.
//!
//! Diff algorithm (two-phase greedy):
//!   Phase 1: pair new[i] ↔ current[j] when (kind, plaintext) match exactly
//!            — typical "no edit" steady state.
//!   Phase 2: pair remaining by kind only, in order — typical "text edit
//!            within a block" case. Subsequent fugue diff captures the change.
//!   Unpaired new   → insert new block (gen id, tree_move at fractional idx)
//!   Unpaired curr  → tree_move to trash sentinel
//!
//! After pairing, for each paired (ni, ci):
//!   * If kind differs: UPDATE blocks SET kind = ...
//!   * If plaintext differs: longest-common-prefix/suffix → one fugue_delete
//!     range + one fugue_insert call.
//!   * Mark diff: unmark all currently-active marks, then mark all new marks.
//!     Slightly wasteful but correct; Peritext LWW collapses the no-ops.

extern crate alloc;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{ROOT_HEX, TRASH_HEX};

pub fn doc_apply(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 1 {
        ctx.result_error("crsql_doc_apply requires 1 arg: (tree_json)");
        return;
    }
    let tree_json = arg_slice[0].text();
    let db = ctx.db_handle();
    if let Err(msg) = apply(db, tree_json) {
        ctx.result_error(&msg);
    }
}

// ── parsed types ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct NewSpan {
    text: String,
    marks: Vec<NewMark>,
}

#[derive(Debug, Clone)]
struct NewMark {
    name: String,
    value: Option<String>, // TEXT value or None (boolean mark)
}

#[derive(Debug, Clone)]
struct NewBlock {
    kind: String,
    spans: Vec<NewSpan>,
}

impl NewBlock {
    fn plaintext(&self) -> String {
        let mut s = String::new();
        for sp in &self.spans { s.push_str(&sp.text); }
        s
    }

    // Flatten spans into a list of (start, end, name, value) marks.
    fn marks_list(&self) -> Vec<FlatMark> {
        let mut out: Vec<FlatMark> = Vec::new();
        let mut pos = 0u32;
        for sp in &self.spans {
            let len = sp.text.chars().count() as u32;
            for m in &sp.marks {
                // Merge with adjacent same-name mark to avoid fragmentation.
                if let Some(last) = out.last_mut() {
                    if last.name == m.name && last.value == m.value && last.end == pos {
                        last.end = pos + len;
                        continue;
                    }
                }
                out.push(FlatMark {
                    name: m.name.clone(), value: m.value.clone(),
                    start: pos, end: pos + len,
                });
            }
            pos += len;
        }
        out
    }
}

#[derive(Debug, Clone)]
struct FlatMark {
    name: String,
    value: Option<String>,
    start: u32,
    end: u32,
}

#[derive(Debug)]
struct CurrentBlock {
    id_hex: String,    // for SQL: X'<hex>'
    kind: String,
    plaintext: String,
    meta_text: String, // decoded fractional-index string (ASCII)
}

// ── parsing input JSON via SQLite's json1 ────────────────────────────

fn parse_tree(db: *mut sqlite3, tree_json: &str) -> Result<Vec<NewBlock>, String> {
    // Top-level: iterate blocks
    let stmt = db
        .prepare_v2(
            "SELECT \
                json_extract(b.value, '$.kind'), \
                b.value \
             FROM json_each(?) AS b \
             ORDER BY b.key",
        )
        .map_err(|_| String::from("prepare parse_tree blocks"))?;
    stmt.bind_text(1, tree_json, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind tree_json"))?;

    let mut blocks: Vec<NewBlock> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step parse_tree blocks"))? {
            ResultCode::ROW => {
                let kind = String::from(stmt.column_text(0).unwrap_or(""));
                let block_json = String::from(stmt.column_text(1).unwrap_or(""));
                let spans = parse_spans(db, &block_json)?;
                blocks.push(NewBlock { kind, spans });
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("parse_tree: unexpected step")),
        }
    }
    Ok(blocks)
}

fn parse_spans(db: *mut sqlite3, block_json: &str) -> Result<Vec<NewSpan>, String> {
    let stmt = db
        .prepare_v2(
            "SELECT \
                json_extract(s.value, '$.text'), \
                s.value \
             FROM json_each(?, '$.spans') AS s \
             ORDER BY s.key",
        )
        .map_err(|_| String::from("prepare parse_spans"))?;
    stmt.bind_text(1, block_json, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind block_json"))?;

    let mut spans: Vec<NewSpan> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step parse_spans"))? {
            ResultCode::ROW => {
                let text = String::from(stmt.column_text(0).unwrap_or(""));
                let span_json = String::from(stmt.column_text(1).unwrap_or(""));
                let marks = parse_marks(db, &span_json)?;
                spans.push(NewSpan { text, marks });
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("parse_spans: unexpected step")),
        }
    }
    Ok(spans)
}

fn parse_marks(db: *mut sqlite3, span_json: &str) -> Result<Vec<NewMark>, String> {
    // marks elements can be strings ("bold") or objects ({"name":"link","value":"…"}).
    // json_extract on a string-typed element returns the string itself,
    // and `value->>'$.name'` on an object returns its name. We use a CASE
    // to handle both shapes so the frontend can be lazy.
    let stmt = db
        .prepare_v2(
            "SELECT \
                CASE WHEN json_type(m.value) = 'text' \
                    THEN m.value \
                    ELSE json_extract(m.value, '$.name') \
                END AS name, \
                CASE WHEN json_type(m.value) = 'text' \
                    THEN NULL \
                    ELSE json_extract(m.value, '$.value') \
                END AS value \
             FROM json_each(?, '$.marks') AS m \
             ORDER BY m.key",
        )
        .map_err(|_| String::from("prepare parse_marks"))?;
    stmt.bind_text(1, span_json, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind span_json"))?;

    let mut marks: Vec<NewMark> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step parse_marks"))? {
            ResultCode::ROW => {
                let name = match stmt.column_text(0) {
                    Ok(s) => String::from(s),
                    Err(_) => continue,
                };
                let value = match stmt.column_type(1) {
                    Ok(sqlite::ColumnType::Null) => None,
                    _ => stmt.column_text(1).ok().map(String::from),
                };
                marks.push(NewMark { name, value });
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("parse_marks: unexpected step")),
        }
    }
    Ok(marks)
}

// ── current state read ──────────────────────────────────────────────

fn read_current(db: *mut sqlite3) -> Result<Vec<CurrentBlock>, String> {
    // Walk tree-CRDT children of root, ordered by fractional-index BLOB.
    let stmt = db
        .prepare_v2(
            "WITH RECURSIVE walk(node, depth, ord_path, frac) AS ( \
                SELECT s.node_id, 0, CAST(s.meta AS BLOB), CAST(s.meta AS BLOB) \
                FROM   doc__tree_state s \
                WHERE  s.parent_id = X'01' \
            ) \
            SELECT lower(hex(w.node)) AS id_hex, b.kind, CAST(w.frac AS TEXT) AS frac_text \
            FROM   walk w \
            JOIN   blocks b ON b.id = w.node \
            WHERE  b.id != X'ff' \
            ORDER  BY w.ord_path",
        )
        .map_err(|_| String::from("prepare read_current blocks"))?;

    let mut out: Vec<CurrentBlock> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step read_current"))? {
            ResultCode::ROW => {
                let id_hex = String::from(stmt.column_text(0).unwrap_or(""));
                let kind = String::from(stmt.column_text(1).unwrap_or(""));
                let meta_text = String::from(stmt.column_text(2).unwrap_or(""));
                let plaintext = read_block_plaintext(db, &id_hex)?;
                out.push(CurrentBlock { id_hex, kind, plaintext, meta_text });
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("read_current: unexpected step")),
        }
    }
    Ok(out)
}

fn read_block_plaintext(db: *mut sqlite3, id_hex: &str) -> Result<String, String> {
    // The Peritext-rendered body is JSON [{"text":...,"marks":...}, ...].
    // Flatten to plain text via json_each + json_extract.
    let sql = format!(
        "SELECT COALESCE(group_concat(json_extract(s.value, '$.text'), ''), '') \
         FROM json_each((SELECT body FROM blocks WHERE id = X'{}')) AS s",
        id_hex
    );
    let stmt = db.prepare_v2(&sql).map_err(|_| String::from("prepare read plaintext"))?;
    match stmt.step().map_err(|_| String::from("step read plaintext"))? {
        ResultCode::ROW => Ok(String::from(stmt.column_text(0).unwrap_or(""))),
        _ => Ok(String::new()),
    }
}

// ── pairing ─────────────────────────────────────────────────────────

struct Pairing {
    new_to_current: Vec<Option<usize>>,
    current_used:   Vec<bool>,
}

fn pair_blocks(new: &[NewBlock], current: &[CurrentBlock]) -> Pairing {
    let mut new_to_current: Vec<Option<usize>> = (0..new.len()).map(|_| None).collect();
    let mut current_used:   Vec<bool>          = (0..current.len()).map(|_| false).collect();

    // Phase 1: exact kind+plaintext match (steady-state passthrough)
    for (ni, nb) in new.iter().enumerate() {
        let nb_text = nb.plaintext();
        for (ci, cb) in current.iter().enumerate() {
            if current_used[ci] { continue; }
            if nb.kind == cb.kind && nb_text == cb.plaintext {
                new_to_current[ni] = Some(ci);
                current_used[ci] = true;
                break;
            }
        }
    }

    // Phase 2: kind-only match in left-to-right order (typical typing edit)
    for ni in 0..new.len() {
        if new_to_current[ni].is_some() { continue; }
        for ci in 0..current.len() {
            if current_used[ci] { continue; }
            if new[ni].kind == current[ci].kind {
                new_to_current[ni] = Some(ci);
                current_used[ci] = true;
                break;
            }
        }
    }

    Pairing { new_to_current, current_used }
}

// ── fractional indices ──────────────────────────────────────────────
// Tiny ASCII fractional-index helper. Returns a string lex-comparable
// between `before` and `after`. We don't try to be optimal — for a demo,
// "append a midpoint char" is fine.
fn frac_between(before: Option<&str>, after: Option<&str>) -> String {
    match (before, after) {
        (None, None) => String::from("m"),
        (Some(b), None) => format!("{}m", b),
        (None, Some(a)) => {
            // pick something < a; default "a" works if a > "a"
            let first = a.as_bytes().first().copied().unwrap_or(b'm');
            if first > b'a' { String::from("a") } else { format!("a{}", a) }
        }
        (Some(b), Some(a)) => {
            // Pick char midway between b's first differing byte and a's.
            // Cheap heuristic: concat b + 'm'.
            if b < a { format!("{}m", b) } else { format!("{}m", b) }
        }
    }
}

// ── op emission ─────────────────────────────────────────────────────

fn apply(db: *mut sqlite3, tree_json: &str) -> Result<(), String> {
    let new_blocks = parse_tree(db, tree_json)?;
    let current = read_current(db)?;
    let pairing = pair_blocks(&new_blocks, &current);

    // Build a list of fractional indices for new_blocks' positions. Stored
    // as decoded ASCII strings; hex-encoded at SQL-bind time. For paired
    // blocks: reuse the current frac. For unpaired: derive one between
    // already-decided left + right neighbors.
    let mut fracs: Vec<String> = Vec::with_capacity(new_blocks.len());
    for ni in 0..new_blocks.len() {
        if let Some(ci) = pairing.new_to_current[ni] {
            fracs.push(current[ci].meta_text.clone());
        } else {
            let left = (0..ni)
                .rev()
                .find_map(|j| Some(fracs.get(j)?.as_str()));
            let right = ((ni + 1)..new_blocks.len()).find_map(|j| {
                pairing.new_to_current[j].map(|ci| current[ci].meta_text.as_str())
            });
            fracs.push(frac_between(left, right));
        }
    }

    let actor_hex = read_site_id_hex(db)?;
    let mut ts = read_max_ts(db)? + 1;

    // 1. Apply paired blocks (content + kind + marks)
    for (ni, nb) in new_blocks.iter().enumerate() {
        if let Some(ci) = pairing.new_to_current[ni] {
            let cb = &current[ci];
            if nb.kind != cb.kind {
                let sql = format!(
                    "UPDATE blocks SET kind = '{}' WHERE id = X'{}'",
                    crate::util::esc_lit(&nb.kind), cb.id_hex
                );
                db.exec_safe(&sql).map_err(|_| format!("update kind for {}", cb.id_hex))?;
            }
            apply_content_diff(db, &cb.id_hex, &cb.plaintext, &nb.plaintext())?;
            apply_marks(db, &cb.id_hex, &nb.marks_list(), &mut ts, &actor_hex)?;
        }
    }

    // 2. Create unpaired new blocks
    for (ni, nb) in new_blocks.iter().enumerate() {
        if pairing.new_to_current[ni].is_some() { continue; }
        let new_id_hex = gen_block_id_hex(db)?;
        let kind = crate::util::esc_lit(&nb.kind);
        let create = format!(
            "INSERT INTO blocks (id, kind) VALUES (X'{}', '{}')",
            new_id_hex, kind
        );
        db.exec_safe(&create).map_err(|_| format!("insert new block {}", new_id_hex))?;
        // tree_move into root — meta hex-encoded from the decoded frac
        place_block(db, &new_id_hex, ROOT_HEX, &hex_of_str(&fracs[ni]), ts, &actor_hex)?;
        ts += 1;
        let plain = nb.plaintext();
        if !plain.is_empty() {
            let plain_lit = crate::util::esc_lit(&plain);
            let ins = format!(
                "SELECT crsql_fugue_insert('blocks', 'body', X'{}', 0, '{}')",
                new_id_hex, plain_lit
            );
            db.exec_safe(&ins).map_err(|_| format!("fugue_insert into new block {}", new_id_hex))?;
        }
        apply_marks(db, &new_id_hex, &nb.marks_list(), &mut ts, &actor_hex)?;
    }

    // 3. Trash unpaired current blocks
    for (ci, used) in pairing.current_used.iter().enumerate() {
        if *used { continue; }
        // tree_move to trash with arbitrary frac
        place_block(db, &current[ci].id_hex, TRASH_HEX, "7a", ts, &actor_hex)?;
        ts += 1;
    }

    Ok(())
}

fn apply_content_diff(
    db: *mut sqlite3,
    id_hex: &str,
    old: &str,
    new: &str,
) -> Result<(), String> {
    if old == new { return Ok(()); }
    // longest common prefix + suffix → single edit range
    let o: Vec<char> = old.chars().collect();
    let n: Vec<char> = new.chars().collect();
    let min = core::cmp::min(o.len(), n.len());
    let mut p = 0usize;
    while p < min && o[p] == n[p] { p += 1; }
    let mut so = o.len();
    let mut sn = n.len();
    while so > p && sn > p && o[so - 1] == n[sn - 1] { so -= 1; sn -= 1; }
    let removed_chars = so.saturating_sub(p);
    let inserted: String = n[p..sn].iter().collect();

    if removed_chars > 0 {
        let sql = format!(
            "SELECT crsql_fugue_delete('blocks', 'body', X'{}', {}, {})",
            id_hex, p, p + removed_chars
        );
        db.exec_safe(&sql).map_err(|_| format!("fugue_delete on {}", id_hex))?;
    }
    if !inserted.is_empty() {
        let lit = crate::util::esc_lit(&inserted);
        let sql = format!(
            "SELECT crsql_fugue_insert('blocks', 'body', X'{}', {}, '{}')",
            id_hex, p, lit
        );
        db.exec_safe(&sql).map_err(|_| format!("fugue_insert on {}", id_hex))?;
    }
    Ok(())
}

// Set-diff mark strategy: read currently-resolved marks from the
// peritext render output, compute (new ∖ current) and (current ∖ new),
// emit only the deltas. Each mark instance has identity
// (name, start, end, value). This:
//   * eliminates redundant remark churn (no-op when nothing changed)
//   * preserves additive-mark instances across re-apply (Peritext §3.2.2)
//   * matches paper-§3.2.1 sequential-conflict intent: Alice's selective
//     unmark stays selective; Bob's full-region rebold doesn't clobber it
fn apply_marks(
    db: *mut sqlite3,
    id_hex: &str,
    new_marks: &[FlatMark],
    ts: &mut i64,
    actor_hex: &str,
) -> Result<(), String> {
    let current = read_current_marks_resolved(db, id_hex)?;

    // emit unmarks for marks present in current but not in new
    for cm in &current {
        if !new_marks.iter().any(|nm| flat_eq(nm, cm)) {
            let sql = format!(
                "SELECT crsql_peritext_unmark('blocks', 'body', X'{}', {}, {}, '{}', 0, 0, {}, X'{}')",
                id_hex, cm.start, cm.end,
                crate::util::esc_lit(&cm.name),
                *ts, actor_hex
            );
            db.exec_safe(&sql).map_err(|_| format!("unmark {} on {}", cm.name, id_hex))?;
            *ts += 1;
        }
    }

    // emit marks for new marks not already present in current
    for nm in new_marks {
        if nm.end <= nm.start { continue; }
        if current.iter().any(|cm| flat_eq(nm, cm)) { continue; }
        let val_clause = match &nm.value {
            None => String::from("NULL"),
            Some(v) => format!("'{}'", crate::util::esc_lit(v)),
        };
        let end_side = if nm.name == "link" || nm.name == "code" { 1 } else { 0 };
        let sql = format!(
            "SELECT crsql_peritext_mark('blocks', 'body', X'{}', {}, {}, '{}', {}, 0, {}, {}, X'{}')",
            id_hex, nm.start, nm.end,
            crate::util::esc_lit(&nm.name),
            val_clause, end_side, *ts, actor_hex
        );
        db.exec_safe(&sql).map_err(|_| format!("mark {} on {}", nm.name, id_hex))?;
        *ts += 1;
    }
    Ok(())
}

fn flat_eq(a: &FlatMark, b: &FlatMark) -> bool {
    a.name == b.name && a.start == b.start && a.end == b.end && a.value == b.value
}

// Read the block's currently-active marks at resolved character positions
// by walking the peritext_render output. Each unique (name, value) run
// in the JSON spans becomes one FlatMark covering its char range.
fn read_current_marks_resolved(
    db: *mut sqlite3,
    id_hex: &str,
) -> Result<Vec<FlatMark>, String> {
    use alloc::collections::BTreeMap;

    // SQL walks the render output (JSON array of spans), yielding one row
    // per span with its text length and a marks-JSON blob we then parse.
    let sql = format!(
        "SELECT \
            length(json_extract(s.value, '$.text')) AS textlen, \
            json_extract(s.value, '$.marks') AS marks_json \
         FROM json_each((SELECT body FROM blocks WHERE id = X'{}')) AS s \
         ORDER BY s.key",
        id_hex
    );
    let stmt = db.prepare_v2(&sql)
        .map_err(|_| String::from("prepare read_current_marks"))?;

    // Walk spans accumulating mark runs. `open[(name,value)] = start_pos`
    // tracks marks currently open across consecutive spans. When a mark
    // is absent in a span, close the run and emit a FlatMark.
    let mut open: BTreeMap<(String, Option<String>), u32> = BTreeMap::new();
    let mut out: Vec<FlatMark> = Vec::new();
    let mut pos: u32 = 0;

    loop {
        match stmt.step().map_err(|_| String::from("step marks walk"))? {
            ResultCode::ROW => {
                let textlen = stmt.column_int64(0) as u32;
                let marks_json = stmt.column_text(1).unwrap_or("");
                let mut span_marks: BTreeMap<(String, Option<String>), ()> = BTreeMap::new();
                if !marks_json.is_empty() && marks_json != "null" {
                    parse_span_marks(db, marks_json, &mut span_marks)?;
                }

                // Close runs not in this span
                let to_close: Vec<(String, Option<String>)> = open.keys()
                    .filter(|k| !span_marks.contains_key(k))
                    .cloned()
                    .collect();
                for key in to_close {
                    let start = open.remove(&key).unwrap();
                    out.push(FlatMark { name: key.0, value: key.1, start, end: pos });
                }
                // Open new runs
                for k in span_marks.keys() {
                    if !open.contains_key(k) { open.insert(k.clone(), pos); }
                }
                pos += textlen;
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("read_current_marks: unexpected step")),
        }
    }
    // Close any still-open runs at end of doc
    for (key, start) in open.into_iter() {
        out.push(FlatMark { name: key.0, value: key.1, start, end: pos });
    }
    Ok(out)
}

// Parse a single span's marks JSON. Shape: {markName: value | [values...]}
// where boolean marks are `true`, parameterized are strings/numbers, and
// additive marks (comments) are arrays of values. Each (name, value)
// entry becomes a key.
fn parse_span_marks(
    db: *mut sqlite3,
    marks_json: &str,
    out: &mut alloc::collections::BTreeMap<(String, Option<String>), ()>,
) -> Result<(), String> {
    // json_each over an object yields (key, value) pairs. value may be
    // a primitive (boolean/string/number) for LWW, or an array for additive.
    let stmt = db.prepare_v2(
        "SELECT key, type, value FROM json_each(?)",
    ).map_err(|_| String::from("prepare span marks parse"))?;
    stmt.bind_text(1, marks_json, sqlite::Destructor::TRANSIENT)
        .map_err(|_| String::from("bind span marks"))?;

    loop {
        match stmt.step().map_err(|_| String::from("step span marks parse"))? {
            ResultCode::ROW => {
                let name = String::from(stmt.column_text(0).unwrap_or(""));
                let kind = String::from(stmt.column_text(1).unwrap_or(""));
                if kind == "array" {
                    // additive: enumerate the array values, each is a
                    // distinct mark instance.
                    let arr_json = stmt.column_text(2).unwrap_or("");
                    let sub = db.prepare_v2(
                        "SELECT type, value FROM json_each(?)",
                    ).map_err(|_| String::from("prepare additive array"))?;
                    sub.bind_text(1, arr_json, sqlite::Destructor::TRANSIENT)
                        .map_err(|_| String::from("bind additive array"))?;
                    loop {
                        match sub.step().map_err(|_| String::from("step additive"))? {
                            ResultCode::ROW => {
                                let v = sub.column_text(1).ok().map(String::from);
                                out.insert((name.clone(), v), ());
                            }
                            _ => break,
                        }
                    }
                } else if kind == "true" || kind == "integer" || kind == "real" {
                    // boolean mark: stored as value=true → no payload
                    out.insert((name, None), ());
                } else if kind == "text" {
                    let v = stmt.column_text(2).ok().map(String::from);
                    out.insert((name, v), ());
                }
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("parse_span_marks: unexpected step")),
        }
    }
    Ok(())
}

fn place_block(
    db: *mut sqlite3,
    id_hex: &str,
    parent_hex: &str,
    frac_hex: &str,
    ts: i64,
    actor_hex: &str,
) -> Result<(), String> {
    let sql = format!(
        "SELECT crsql_tree_move('doc', X'{}', X'{}', X'{}', {}, X'{}')",
        id_hex, parent_hex, frac_hex, ts, actor_hex
    );
    db.exec_safe(&sql).map_err(|_| format!("tree_move {}", id_hex))?;
    Ok(())
}

// ── DB helpers ──────────────────────────────────────────────────────

fn read_site_id_hex(db: *mut sqlite3) -> Result<String, String> {
    let stmt = db
        .prepare_v2("SELECT lower(hex(crsql_site_id()))")
        .map_err(|_| String::from("prepare site_id"))?;
    match stmt.step().map_err(|_| String::from("step site_id"))? {
        ResultCode::ROW => Ok(String::from(stmt.column_text(0).unwrap_or(""))),
        _ => Err(String::from("site_id: no row")),
    }
}

fn read_max_ts(db: *mut sqlite3) -> Result<i64, String> {
    let stmt = db
        .prepare_v2(
            "SELECT COALESCE(MAX(t), 0) FROM (\
                SELECT MAX(lamport_ts) AS t FROM doc__tree_ops \
                UNION ALL \
                SELECT MAX(lamport_ts) AS t FROM __crsql_peritext_blocks_body_marks\
             )",
        )
        .map_err(|_| String::from("prepare max_ts"))?;
    match stmt.step().map_err(|_| String::from("step max_ts"))? {
        ResultCode::ROW => Ok(stmt.column_int64(0)),
        _ => Ok(0),
    }
}

fn read_plain_len(db: *mut sqlite3, id_hex: &str) -> Result<i64, String> {
    let sql = format!(
        "SELECT length(crsql_fugue_render('blocks', 'body', X'{}'))",
        id_hex
    );
    let stmt = db.prepare_v2(&sql).map_err(|_| String::from("prepare plain_len"))?;
    match stmt.step().map_err(|_| String::from("step plain_len"))? {
        ResultCode::ROW => Ok(stmt.column_int64(0)),
        _ => Ok(0),
    }
}

fn read_active_mark_names(db: *mut sqlite3, id_hex: &str) -> Result<Vec<String>, String> {
    let sql = format!(
        "SELECT DISTINCT mark_name FROM __crsql_peritext_blocks_body_marks \
         WHERE row_pk = X'{}' AND is_add = 1",
        id_hex
    );
    let stmt = db.prepare_v2(&sql).map_err(|_| String::from("prepare active mark names"))?;
    let mut names: Vec<String> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step active mark names"))? {
            ResultCode::ROW => {
                if let Ok(name) = stmt.column_text(0) {
                    names.push(String::from(name));
                }
            }
            ResultCode::DONE => break,
            _ => break,
        }
    }
    Ok(names)
}

fn gen_block_id_hex(db: *mut sqlite3) -> Result<String, String> {
    // 16 random bytes via SQLite's randomblob().
    let stmt = db
        .prepare_v2("SELECT lower(hex(randomblob(16)))")
        .map_err(|_| String::from("prepare randomblob"))?;
    match stmt.step().map_err(|_| String::from("step randomblob"))? {
        ResultCode::ROW => Ok(String::from(stmt.column_text(0).unwrap_or(""))),
        _ => Err(String::from("randomblob: no row")),
    }
}

fn hex_of_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        out.push(hex_nibble(b >> 4));
        out.push(hex_nibble(b & 0x0f));
    }
    out
}
fn hex_nibble(n: u8) -> char {
    match n { 0..=9 => (b'0' + n) as char, _ => (b'a' + n - 10) as char }
}
