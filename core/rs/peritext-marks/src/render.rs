//! Render the Peritext document for a given row_pk into portable-text JSON.
//!
//! Pipeline:
//!   1. Load all mark ops for this row_pk.
//!   2. Load additive mark-name list from `__crsql_peritext_meta`.
//!   3. Walk Fugue visibles in render order (`walker::walk`).
//!   4. For each char, process the "before" anchor (apply starts/ends),
//!      compute current marks, group adjacent chars with identical mark
//!      sets into spans, then process the "after" anchor.
//!   5. Emit spans as portable-text JSON:
//!        [{"text": "...", "marks": {name: value | [values]}}, ...]
//!
//! LWW vs additive resolution: at projection time, if `mark_name` is
//! declared additive in metadata, enumerate all currently-active addMark
//! ops; otherwise take the single highest-opId op (LWW). Paper §3.2.1/§3.2.2.

extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use crsql_text_crdt_fugue::{escape_ident, row_pk as fugue_row_pk};
use sqlite::{args, context, sqlite3, ColumnType, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{
    marks_table_name, validate_ident, ANCHOR_END, ANCHOR_START, META_TABLE, SIDE_AFTER,
    SIDE_BEFORE,
};
use crate::walker;

/// `crsql_peritext_render(table, col, row_pk) → TEXT (portable-text JSON)`
pub fn peritext_render(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_peritext_render requires 3 args: (table, col, row_pk)");
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    if let Err(msg) = validate_ident(table, "table") {
        ctx.result_error(&msg);
        return;
    }
    if let Err(msg) = validate_ident(column, "column") {
        ctx.result_error(&msg);
        return;
    }
    let row_pk = match fugue_row_pk::from_value(arg_slice[2]) {
        Ok(pk) => pk,
        Err(msg) => {
            ctx.result_error(&msg);
            return;
        }
    };

    let db = ctx.db_handle();
    match compute_render(db, table, column, &row_pk) {
        Ok(json) => ctx.result_text_transient(&json),
        Err(msg) => ctx.result_error(&msg),
    }
}

// ── Internal types ────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct OpId {
    lamport_ts: i64,
    actor: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq)]
enum ValueRepr {
    Null,
    Bool, // NULL mark_value → emit `true` to indicate "mark applied without value"
    Text(String),
    Int(i64),
    Float(F64Bits), // wrap for derive(PartialEq) — equality is bit-equal
}

/// f64 wrapper with bit-exact equality. Used for ValueRepr::Float so
/// PartialEq comparisons in span-change detection don't trip over NaN.
#[derive(Clone, Debug)]
struct F64Bits(f64);

impl PartialEq for F64Bits {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_bits() == other.0.to_bits()
    }
}

#[derive(Clone, Debug)]
struct MarkOp {
    op_id: OpId,
    start_item: String,
    start_idx: i32,
    start_side: i64,
    end_item: String,
    end_idx: i32,
    end_side: i64,
    mark_name: String,
    value: ValueRepr,
    is_add: bool,
}

// ── Compute ───────────────────────────────────────────────────────────

fn compute_render(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: &[u8],
) -> Result<String, String> {
    let ops = load_marks(db, table, column, row_pk)?;
    let additive = load_additive_names(db, table, column)?;
    let visibles = walker::walk(db, table, column, row_pk)?;

    // Pre-compute anchor lookup keyed by (itemId, idx) → ops grouped by
    // (start/end, side). Sentinel anchors (ANCHOR_START / ANCHOR_END)
    // use idx = -1.
    type AnchorKey<'a> = (&'a str, i32);
    let mut starts_before: BTreeMap<AnchorKey, Vec<&MarkOp>> = BTreeMap::new();
    let mut starts_after: BTreeMap<AnchorKey, Vec<&MarkOp>> = BTreeMap::new();
    let mut ends_before: BTreeMap<AnchorKey, Vec<&MarkOp>> = BTreeMap::new();
    let mut ends_after: BTreeMap<AnchorKey, Vec<&MarkOp>> = BTreeMap::new();
    for op in &ops {
        let table = if op.start_side == SIDE_BEFORE {
            &mut starts_before
        } else {
            &mut starts_after
        };
        table
            .entry((op.start_item.as_str(), op.start_idx))
            .or_default()
            .push(op);

        let table = if op.end_side == SIDE_BEFORE {
            &mut ends_before
        } else {
            &mut ends_after
        };
        table
            .entry((op.end_item.as_str(), op.end_idx))
            .or_default()
            .push(op);
    }

    // Active state: mark_name → BTreeMap<OpId, &MarkOp> (BTreeMap orders
    // ascending by OpId; we take .last() for the LWW winner).
    let mut active: BTreeMap<String, BTreeMap<OpId, &MarkOp>> = BTreeMap::new();

    // Process the implicit "after-ANCHOR_START" anchor: marks pinned to
    // the very beginning of the document take effect here.
    apply_anchor_events(
        &mut active,
        starts_after.get(&(ANCHOR_START, -1)).map(|v| v.as_slice()),
        ends_after.get(&(ANCHOR_START, -1)).map(|v| v.as_slice()),
    );

    let mut spans: Vec<(String, Vec<MarkProjection>)> = Vec::new();
    let mut current_marks = project_active(&active, &additive);
    let mut buf = String::new();

    for v in &visibles {
        let key = (v.item_id.as_str(), v.idx);
        // "before-v" anchor events
        apply_anchor_events(
            &mut active,
            starts_before.get(&key).map(|v| v.as_slice()),
            ends_before.get(&key).map(|v| v.as_slice()),
        );

        let new_marks = project_active(&active, &additive);
        if !marks_eq(&new_marks, &current_marks) {
            if !buf.is_empty() {
                spans.push((core::mem::take(&mut buf), current_marks.clone()));
            }
            current_marks = new_marks;
        }
        buf.push(v.ch);

        // "after-v" anchor events
        apply_anchor_events(
            &mut active,
            starts_after.get(&key).map(|v| v.as_slice()),
            ends_after.get(&key).map(|v| v.as_slice()),
        );
    }

    // Process the implicit "before-ANCHOR_END" anchor (end of doc).
    apply_anchor_events(
        &mut active,
        starts_before.get(&(ANCHOR_END, -1)).map(|v| v.as_slice()),
        ends_before.get(&(ANCHOR_END, -1)).map(|v| v.as_slice()),
    );

    if !buf.is_empty() {
        spans.push((buf, current_marks));
    }

    Ok(spans_to_json(&spans))
}

fn apply_anchor_events<'a>(
    active: &mut BTreeMap<String, BTreeMap<OpId, &'a MarkOp>>,
    starts: Option<&[&'a MarkOp]>,
    ends: Option<&[&'a MarkOp]>,
) {
    if let Some(s) = starts {
        for op in s {
            active
                .entry(op.mark_name.clone())
                .or_default()
                .insert(op.op_id.clone(), *op);
        }
    }
    if let Some(e) = ends {
        for op in e {
            if let Some(inner) = active.get_mut(&op.mark_name) {
                inner.remove(&op.op_id);
                // Don't shrink: keep the entry (possibly empty) so we
                // distinguish "name was active and is now inactive" from
                // "name never seen".
            }
        }
    }
}

// ── Projection — active ops → emitted marks ─────────────────────────

/// One mark entry as it will appear in the output JSON for a span.
/// For LWW marks: one entry per name, value = the winner's mark_value.
/// For additive marks: one entry per name with value = JSON array of
///   all addMark values currently active.
#[derive(Clone, Debug, PartialEq)]
struct MarkProjection {
    name: String,
    /// `None` → emit JSON `true`; `Some(values)` → emit `values[0]` for
    /// LWW, or a JSON array of all values for additive marks. Always
    /// non-empty when `Some`.
    payload: MarkPayload,
}

#[derive(Clone, Debug, PartialEq)]
enum MarkPayload {
    Single(ValueRepr),
    Multiple(Vec<ValueRepr>),
}

fn marks_eq(a: &[MarkProjection], b: &[MarkProjection]) -> bool {
    a == b
}

fn project_active(
    active: &BTreeMap<String, BTreeMap<OpId, &MarkOp>>,
    additive: &[String],
) -> Vec<MarkProjection> {
    let mut out: Vec<MarkProjection> = Vec::new();
    for (name, ops) in active {
        if ops.is_empty() {
            continue;
        }
        let is_additive = additive.iter().any(|s| s == name);
        if is_additive {
            // Enumerate all is_add ops currently active.
            let values: Vec<ValueRepr> = ops
                .values()
                .filter(|op| op.is_add)
                .map(|op| op.value.clone())
                .collect();
            if !values.is_empty() {
                out.push(MarkProjection {
                    name: name.clone(),
                    payload: MarkPayload::Multiple(values),
                });
            }
        } else {
            // LWW: take the top OpId (BTreeMap iterates ascending, .last() is max).
            if let Some((_, top)) = ops.iter().next_back() {
                if top.is_add {
                    out.push(MarkProjection {
                        name: name.clone(),
                        payload: MarkPayload::Single(top.value.clone()),
                    });
                }
            }
        }
    }
    out
}

// ── Database loads ────────────────────────────────────────────────────

fn load_marks(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: &[u8],
) -> Result<Vec<MarkOp>, String> {
    let marks = marks_table_name(table, column);
    let marks_esc = escape_ident(&marks);

    let sql = format!(
        "SELECT lamport_ts, actor, start_item, start_idx, start_side, \
                end_item, end_idx, end_side, mark_name, mark_value, is_add \
         FROM \"{t}\" WHERE row_pk = ?",
        t = marks_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| format!("prepare load_marks for {}", marks))?;
    fugue_row_pk::bind(&stmt, 1, row_pk).map_err(|_| String::from("bind row_pk"))?;

    let mut ops: Vec<MarkOp> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step load_marks"))? {
            ResultCode::ROW => {
                // Mid-apply tolerance: cr-sqlite ships changes per-cell, so the
                // marks row exists with partial columns during sync-apply. Skip
                // rows where any critical anchor column is still NULL — they'll
                // contribute correctly on a later trigger fire once the row is
                // fully populated.
                let start_item = match stmt.column_text(2) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let end_item = match stmt.column_text(5) {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let mark_name = match stmt.column_text(8) {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                let ts = stmt.column_int64(0);
                let actor = match stmt.column_blob(1) {
                    Ok(b) => Vec::from(b),
                    Err(_) => continue,
                };
                let start_idx = stmt.column_int(3);
                let start_side = stmt.column_int64(4);
                let end_idx = stmt.column_int(6);
                let end_side = stmt.column_int64(7);
                let value = column_to_value_repr(&stmt, 9)?;
                let is_add = stmt.column_int64(10) != 0;

                ops.push(MarkOp {
                    op_id: OpId {
                        lamport_ts: ts,
                        actor,
                    },
                    start_item: String::from(start_item),
                    start_idx,
                    start_side,
                    end_item: String::from(end_item),
                    end_idx,
                    end_side,
                    mark_name: String::from(mark_name),
                    value,
                    is_add,
                });
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("load_marks: unexpected step")),
        }
    }
    Ok(ops)
}

fn column_to_value_repr(
    stmt: &sqlite::ManagedStmt,
    col: i32,
) -> Result<ValueRepr, String> {
    let t = stmt
        .column_type(col)
        .map_err(|_| String::from("column_type"))?;
    Ok(match t {
        ColumnType::Null => ValueRepr::Bool, // NULL value → "mark applied, no payload"
        ColumnType::Integer => ValueRepr::Int(stmt.column_int64(col)),
        ColumnType::Float => ValueRepr::Float(F64Bits(stmt.column_double(col))),
        ColumnType::Text => ValueRepr::Text(String::from(
            stmt.column_text(col).map_err(|_| String::from("text"))?,
        )),
        ColumnType::Blob => ValueRepr::Bool, // BLOB payloads not supported in JSON output (V1)
    })
}

fn load_additive_names(
    db: *mut sqlite3,
    table: &str,
    column: &str,
) -> Result<Vec<String>, String> {
    // Check the meta table exists; if not (caller used crsql_as_text_crdt
    // directly without crsql_as_peritext), assume no additive marks.
    let exists_sql = format!(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='{}'",
        META_TABLE
    );
    let exists_stmt = db
        .prepare_v2(&exists_sql)
        .map_err(|_| String::from("prepare meta exists check"))?;
    let exists = match exists_stmt.step() {
        Ok(ResultCode::ROW) => exists_stmt.column_int(0) > 0,
        _ => false,
    };
    if !exists {
        return Ok(Vec::new());
    }

    let sql = format!(
        "SELECT additive_json FROM \"{t}\" WHERE parent_table = ? AND parent_column = ?",
        t = META_TABLE
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare load_additive_names"))?;
    stmt.bind_text(1, table, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind table"))?;
    stmt.bind_text(2, column, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind column"))?;

    let raw = match stmt
        .step()
        .map_err(|_| String::from("step load_additive_names"))?
    {
        ResultCode::ROW => String::from(
            stmt.column_text(0)
                .map_err(|_| String::from("read additive_json"))?,
        ),
        _ => String::new(),
    };

    Ok(parse_additive_names(&raw))
}

/// Forgiving parse: accepts a JSON-array-of-strings shape OR a plain
/// comma-separated list. Both `'["comment","suggestion"]'` and
/// `'comment,suggestion'` produce `["comment", "suggestion"]`. Empty or
/// blank returns empty.
fn parse_additive_names(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let inner = trimmed.trim_start_matches('[').trim_end_matches(']');
    inner
        .split(',')
        .map(|s| {
            let s = s.trim().trim_matches('"').trim_matches('\'');
            String::from(s)
        })
        .filter(|s| !s.is_empty())
        .collect()
}

// ── JSON output ──────────────────────────────────────────────────────

fn spans_to_json(spans: &[(String, Vec<MarkProjection>)]) -> String {
    let mut out = String::with_capacity(64 + spans.len() * 32);
    out.push('[');
    for (i, (text, marks)) in spans.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"text\":");
        json_string(&mut out, text);
        out.push_str(",\"marks\":");
        json_marks(&mut out, marks);
        out.push('}');
    }
    out.push(']');
    out
}

fn json_marks(out: &mut String, marks: &[MarkProjection]) {
    out.push('{');
    for (i, m) in marks.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        json_string(out, &m.name);
        out.push(':');
        match &m.payload {
            MarkPayload::Single(v) => json_value(out, v),
            MarkPayload::Multiple(vs) => {
                out.push('[');
                for (j, v) in vs.iter().enumerate() {
                    if j > 0 {
                        out.push(',');
                    }
                    json_value(out, v);
                }
                out.push(']');
            }
        }
    }
    out.push('}');
}

fn json_value(out: &mut String, v: &ValueRepr) {
    match v {
        ValueRepr::Null => out.push_str("null"),
        ValueRepr::Bool => out.push_str("true"),
        ValueRepr::Text(s) => json_string(out, s),
        ValueRepr::Int(n) => out.push_str(&format!("{}", n)),
        ValueRepr::Float(f) => {
            // SQLite uses %.17g for REAL; for our portable-text output the
            // exact representation isn't critical, just deterministic.
            out.push_str(&format!("{}", f.0));
        }
    }
}

fn json_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
