extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

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

/// Render the canonical text from backing rows. After the apply-time split +
/// cleanup pipeline (registration.rs install_split_trigger + cleanup_trigger),
/// the tree is fully canonical: every child's parentIdx equals its parent's
/// terminal idx, and no overlapping/duplicate runs survive. So the simple
/// exact-idx recursive CTE matches what the auto-render trigger produces by
/// construction.
fn compute_render(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
) -> Result<String, String> {
    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);

    let sql = format!(
        "WITH RECURSIVE under_node(content, level, itemId, idx, tombstoned) AS (\
            VALUES ('', 0, '', -2, 0) \
            UNION ALL \
            SELECT f.content, under_node.level + 1, f.itemId, f.idx, f.tombstoned \
              FROM \"{backing}\" f \
              JOIN under_node ON f.parentItemId = under_node.itemId AND f.parentIdx = under_node.idx \
              WHERE f.row_pk = ? \
              ORDER BY 2 DESC, f.itemId, f.idx \
         ) \
         SELECT IFNULL(group_concat(content, ''), '') FROM under_node \
         WHERE idx != -1 AND tombstoned = 0",
        backing = backing_esc
    );

    let stmt = db.prepare_v2(&sql).map_err(|_| String::from("prepare render"))?;
    stmt.bind_int64(1, row_pk).map_err(|_| String::from("bind row_pk"))?;
    if stmt.step().map_err(|_| String::from("step render"))? == ResultCode::ROW {
        Ok(String::from(stmt.column_text(0).map_err(|_| String::from("column_text"))?))
    } else {
        Ok(String::new())
    }
}
