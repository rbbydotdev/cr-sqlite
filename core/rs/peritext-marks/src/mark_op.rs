//! `crsql_peritext_mark` and `crsql_peritext_unmark` — append addMark /
//! removeMark ops to the marks table. The render trigger handles the
//! materialization; this UDF just resolves the integer positions into
//! stable (itemId, side) anchors and inserts the row.

extern crate alloc;
use alloc::format;
use alloc::string::String;
use crsql_text_crdt_fugue::{escape_ident, row_pk as fugue_row_pk};
use sqlite::{args, context, sqlite3, ColumnType, Connection, Context, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{
    marks_table_name, validate_ident, ANCHOR_END, ANCHOR_START, SIDE_AFTER, SIDE_BEFORE,
};
use crate::walker;

/// `crsql_peritext_mark(table, col, row_pk, start_pos, end_pos, mark_name, mark_value, start_side, end_side, ts, actor)`
pub fn peritext_mark(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    insert_mark_op(ctx, argc, argv, true);
}

/// `crsql_peritext_unmark(table, col, row_pk, start_pos, end_pos, mark_name, start_side, end_side, ts, actor)`
/// `mark_value` is omitted — removeMark carries no value.
pub fn peritext_unmark(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    insert_mark_op(ctx, argc, argv, false);
}

fn insert_mark_op(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
    is_add: bool,
) {
    let expected = if is_add { 11 } else { 10 };
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != expected {
        let label = if is_add { "mark" } else { "unmark" };
        let val_arg = if is_add { ", mark_value" } else { "" };
        ctx.result_error(&format!(
            "crsql_peritext_{} requires {} args: \
             (table, col, row_pk, start_pos, end_pos, mark_name{}, start_side, end_side, ts, actor)",
            label, expected, val_arg
        ));
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

    let start_pos = require_int(ctx, arg_slice[3], "start_pos");
    let end_pos = require_int(ctx, arg_slice[4], "end_pos");
    let (start_pos, end_pos) = match (start_pos, end_pos) {
        (Some(a), Some(b)) => (a, b),
        _ => return,
    };
    if start_pos < 0 || end_pos < 0 || end_pos < start_pos {
        ctx.result_error(&format!(
            "invalid range: start_pos={}, end_pos={}",
            start_pos, end_pos
        ));
        return;
    }
    if start_pos == end_pos {
        // empty range — nothing to mark, but not an error; silently no-op
        return;
    }

    let mark_name = arg_slice[5].text();
    if mark_name.is_empty() {
        ctx.result_error("mark_name must be non-empty");
        return;
    }

    // Args after mark_name: optional mark_value (only when is_add), then
    // start_side, end_side, ts, actor.
    let (value_arg, idx_start_side) = if is_add { (Some(arg_slice[6]), 7) } else { (None, 6) };
    let start_side = require_side(ctx, arg_slice[idx_start_side], "start_side");
    let end_side = require_side(ctx, arg_slice[idx_start_side + 1], "end_side");
    let (start_side, end_side) = match (start_side, end_side) {
        (Some(a), Some(b)) => (a, b),
        _ => return,
    };

    let ts = require_int(ctx, arg_slice[idx_start_side + 2], "lamport_ts");
    let ts = match ts {
        Some(n) => n,
        None => return,
    };
    let actor_arg = arg_slice[idx_start_side + 3];
    if actor_arg.value_type() == ColumnType::Null {
        ctx.result_error("actor must not be NULL");
        return;
    }

    let db = ctx.db_handle();
    let visibles = match walker::walk(db, table, column, &row_pk) {
        Ok(v) => v,
        Err(msg) => {
            ctx.result_error(&msg);
            return;
        }
    };

    // Resolve positions to anchors (item, idx, side).
    // pos=0 → (ANCHOR_START, -1, after) — caller's side ignored at boundary
    // pos=len → (ANCHOR_END, -1, before) — caller's side ignored at boundary
    // 0 < pos < len → (visibles[pos].item_id, visibles[pos].idx, caller's side)
    let len = visibles.len() as i64;
    let (start_item, start_idx, start_side_resolved) = if start_pos == 0 {
        (String::from(ANCHOR_START), -1i32, SIDE_AFTER)
    } else if start_pos >= len {
        ctx.result_error(&format!(
            "start_pos {} out of range (doc length {})",
            start_pos, len
        ));
        return;
    } else {
        let v = &visibles[start_pos as usize];
        (v.item_id.clone(), v.idx, start_side)
    };

    let (end_item, end_idx, end_side_resolved) = if end_pos >= len {
        (String::from(ANCHOR_END), -1i32, SIDE_BEFORE)
    } else if end_pos == 0 {
        return;
    } else {
        let v = &visibles[end_pos as usize];
        (v.item_id.clone(), v.idx, end_side)
    };

    let marks = marks_table_name(table, column);
    let marks_esc = escape_ident(&marks);

    let sql = format!(
        "INSERT INTO \"{t}\" (lamport_ts, actor, row_pk, \
                              start_item, start_idx, start_side, \
                              end_item, end_idx, end_side, \
                              mark_name, mark_value, is_add) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        t = marks_esc
    );
    let stmt = match db.prepare_v2(&sql) {
        Ok(s) => s,
        Err(_) => {
            ctx.result_error(&format!("prepare insert into {}", marks));
            return;
        }
    };

    if let Err(msg) = bind_all(
        &stmt,
        ts,
        actor_arg,
        &row_pk,
        &start_item,
        start_idx,
        start_side_resolved,
        &end_item,
        end_idx,
        end_side_resolved,
        mark_name,
        value_arg,
        is_add,
    ) {
        ctx.result_error(&msg);
        return;
    }

    match stmt.step() {
        Ok(ResultCode::DONE) => {}
        Ok(other) => ctx.result_error(&format!("insert into {}: {:?}", marks, other)),
        Err(rc) => ctx.result_error(&format!("insert into {} failed: {:?}", marks, rc)),
    }
}

fn bind_all(
    stmt: &sqlite::ManagedStmt,
    ts: i64,
    actor: *mut sqlite::value,
    row_pk: &[u8],
    start_item: &str,
    start_idx: i32,
    start_side: i64,
    end_item: &str,
    end_idx: i32,
    end_side: i64,
    mark_name: &str,
    mark_value: Option<*mut sqlite::value>,
    is_add: bool,
) -> Result<(), String> {
    use sqlite::Destructor;
    stmt.bind_int64(1, ts).map_err(|_| String::from("bind ts"))?;
    stmt.bind_value(2, actor).map_err(|_| String::from("bind actor"))?;
    fugue_row_pk::bind(stmt, 3, row_pk).map_err(|_| String::from("bind row_pk"))?;
    stmt.bind_text(4, start_item, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind start_item"))?;
    stmt.bind_int64(5, start_idx as i64)
        .map_err(|_| String::from("bind start_idx"))?;
    stmt.bind_int64(6, start_side)
        .map_err(|_| String::from("bind start_side"))?;
    stmt.bind_text(7, end_item, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind end_item"))?;
    stmt.bind_int64(8, end_idx as i64)
        .map_err(|_| String::from("bind end_idx"))?;
    stmt.bind_int64(9, end_side)
        .map_err(|_| String::from("bind end_side"))?;
    stmt.bind_text(10, mark_name, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind mark_name"))?;
    if let Some(v) = mark_value {
        stmt.bind_value(11, v)
            .map_err(|_| String::from("bind mark_value"))?;
    } else {
        stmt.bind_null(11)
            .map_err(|_| String::from("bind null mark_value"))?;
    }
    stmt.bind_int64(12, if is_add { 1 } else { 0 })
        .map_err(|_| String::from("bind is_add"))?;
    Ok(())
}

fn require_int(
    ctx: *mut context,
    v: *mut sqlite::value,
    label: &str,
) -> Option<i64> {
    if v.value_type() != ColumnType::Integer {
        ctx.result_error(&format!("{} must be INTEGER", label));
        None
    } else {
        Some(v.int64())
    }
}

fn require_side(
    ctx: *mut context,
    v: *mut sqlite::value,
    label: &str,
) -> Option<i64> {
    let n = require_int(ctx, v, label)?;
    if n != SIDE_BEFORE && n != SIDE_AFTER {
        ctx.result_error(&format!(
            "{} must be 0 (before) or 1 (after), got {}",
            label, n
        ));
        None
    } else {
        Some(n)
    }
}
