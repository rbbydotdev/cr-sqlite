extern crate alloc;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// One backing-table row used by the tree walk.
struct Row {
    item_id: String,
    idx: i32,
    content: String,
    parent_item_id: String,
    parent_idx: i32,
    tombstoned: bool,
}

/// Force-recompute the parent column for a single row_pk from the Fugue backing rows.
/// Called by fugue_insert/delete/cleanup at end-of-function (after their writes have
/// been bracketed by active-counter so per-row triggers were suppressed) and by
/// crsql_fugue_flush for explicit refresh paths.
pub(crate) fn rerender_parent_column(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
) -> Result<(), String> {
    let rendered = compute_render(db, table, column, row_pk)?;
    let sql = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = ? WHERE rowid = ?",
        parent = escape_ident(table),
        col = escape_ident(column),
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare rerender"))?;
    stmt.bind_text(1, &rendered, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind rendered"))?;
    stmt.bind_int64(2, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    stmt.step().map_err(|_| String::from("rerender step"))?;
    Ok(())
}

/// SQL function `crsql_fugue_flush(table, col, row_pk)`: force a parent-column refresh
/// from the current backing-table state. Useful after applying sync changes via
/// `crsql_changes` (which bypass our `crsql_fugue_*` function entry points) on a
/// defer-mode column.
///
/// In eager-mode columns, calling flush is harmless but redundant — the AFTER INSERT/UPDATE
/// triggers have already kept the parent column fresh.
pub fn fugue_flush(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_fugue_flush requires 3 args: (table, column, row_pk)");
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = arg_slice[2].int64();
    let db = ctx.db_handle();

    if let Err(msg) = rerender_parent_column(db, table, column, row_pk) {
        ctx.result_error(&msg);
    }
}

/// SQL function `crsql_fugue_render(table, col, row_pk) → TEXT`.
///
/// Returns the current rendered text for a Fugue-backed column by walking the
/// backing table directly. Reads are O(text_length + rows × siblings) per render.
///
/// The materialized parent column is kept fresh by per-row triggers in transparent
/// mode (and the clock-untrack trigger prevents the body column from being shipped
/// as a CRR cell, so there is no longer a render-cascade), so most callers can use
/// `SELECT body FROM ...` directly. This function exists for tests, debugging, and
/// any caller that wants a guaranteed-fresh read without depending on triggers.
pub fn fugue_render(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_fugue_render requires 3 args: (table, column, row_pk)");
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = arg_slice[2].int64();
    let db = ctx.db_handle();

    match compute_render(db, table, column, row_pk) {
        Ok(s) => ctx.result_text_transient(&s),
        Err(msg) => ctx.result_error(&msg),
    }
}

/// Shared engine: load all backing rows for `row_pk`, then walk the Fugue tree
/// from the root sentinel emitting characters in order. Handles children
/// attached at any sub-idx of a parent's run — necessary because Case-1 in-place
/// run extension preserves the row's terminal idx only, while children created
/// before the extension still reference their original (mid-run) parent idx.
fn compute_render(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
) -> Result<String, String> {
    let _ = column;
    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);

    let sql = format!(
        "SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned \
         FROM \"{backing}\" WHERE row_pk = ?",
        backing = backing_esc
    );

    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare render"))?;
    stmt.bind_int64(1, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;

    let mut rows: Vec<Row> = Vec::new();
    loop {
        let rc = stmt
            .step()
            .map_err(|_| String::from("step render"))?;
        if rc != ResultCode::ROW {
            break;
        }
        let content = if stmt
            .column_type(2)
            .map_err(|_| String::from("column_type content"))?
            == sqlite::ColumnType::Null
        {
            String::new()
        } else {
            String::from(
                stmt.column_text(2)
                    .map_err(|_| String::from("column_text content"))?,
            )
        };
        rows.push(Row {
            item_id: String::from(
                stmt.column_text(0)
                    .map_err(|_| String::from("column_text itemId"))?,
            ),
            idx: stmt.column_int(1),
            content,
            parent_item_id: String::from(
                stmt.column_text(3)
                    .map_err(|_| String::from("column_text parentItemId"))?,
            ),
            parent_idx: stmt.column_int(4),
            tombstoned: stmt.column_int(5) != 0,
        });
    }

    // Sort once for deterministic sibling order. Walk-time we'll just scan and
    // pick the children of the current (parent_item_id, parent_idx) cursor.
    rows.sort_by(|a, b| {
        a.parent_item_id
            .cmp(&b.parent_item_id)
            .then(a.parent_idx.cmp(&b.parent_idx))
            .then(a.item_id.cmp(&b.item_id))
            .then(a.idx.cmp(&b.idx))
    });

    let mut out = String::new();
    walk(&rows, "", -2, &mut out);
    Ok(out)
}

fn walk(rows: &[Row], parent_item_id: &str, parent_idx: i32, out: &mut String) {
    // Linear scan filter. n is small in practice; the sort above means children
    // of a given parent appear contiguously, but we don't rely on that here.
    for child in rows.iter().filter(|r| {
        r.parent_item_id == parent_item_id && r.parent_idx == parent_idx
    }) {
        if child.idx == -1 {
            // Sentinel: emits no content but its own children (rows with
            // parentItemId=sentinel.item_id, parentIdx=-1) MUST still render.
            // Prepend operations use this as their attachment point.
            walk(rows, &child.item_id, -1, out);
            continue;
        }
        // idx is the index of the LAST char of this run; first char is at
        // (idx - char_count + 1). Recurse for grandchildren attached at each
        // sub-idx — even when this node is tombstoned, because a tombstoned
        // node can still have non-tombstoned descendants (matches the original
        // SQL CTE semantics where `WHERE tombstoned=0` filters emission only,
        // not the recursive descent).
        let chars: Vec<char> = child.content.chars().collect();
        let len = chars.len() as i32;
        if len == 0 {
            // Pre-row sentinel or empty content — still let any children at
            // virtual sub-positions surface (unlikely in practice).
            continue;
        }
        let sub_start = child.idx - (len - 1);
        for (i, ch) in chars.iter().enumerate() {
            if !child.tombstoned {
                out.push(*ch);
            }
            let sub_idx = sub_start + i as i32;
            walk(rows, &child.item_id, sub_idx, out);
        }
    }
}
