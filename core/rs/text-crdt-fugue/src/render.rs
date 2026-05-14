extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// Force-recompute the parent column for a single row_pk from the Fugue backing rows.
/// Called by fugue_insert/delete/cleanup at end-of-function (after their writes,
/// AFTER decrementing the active-counter so this render is itself trigger-suppressed
/// only when callers exist) and by crsql_fugue_flush for explicit refresh paths.
pub(crate) fn rerender_parent_column(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
) -> Result<(), String> {
    let backing = backing_table_name(table, column);
    let sql = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = (\
            WITH RECURSIVE under_node(content, level, itemId, idx, tombstoned) AS (\
                VALUES ('', 0, '', -2, 0) \
                UNION ALL \
                SELECT f.content, under_node.level + 1, f.itemId, f.idx, f.tombstoned \
                FROM \"{backing}\" f \
                JOIN under_node ON f.parentItemId = under_node.itemId AND f.parentIdx = under_node.idx \
                WHERE f.row_pk = ? \
                ORDER BY 2 DESC, f.itemId, f.idx \
            ) \
            SELECT IFNULL(group_concat(content, ''), '') FROM under_node \
            WHERE idx != -1 AND tombstoned = 0 \
         ) \
         WHERE rowid = ?",
        parent = escape_ident(table),
        col = escape_ident(column),
        backing = escape_ident(&backing)
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare rerender"))?;
    stmt.bind_int64(1, row_pk)
        .map_err(|_| String::from("bind row_pk subquery"))?;
    stmt.bind_int64(2, row_pk)
        .map_err(|_| String::from("bind row_pk where"))?;
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
/// Returns the current rendered text for a Fugue-backed column. Bypasses any
/// materialized parent-column state (which is itself a tracked CRDT cell and
/// participates in cr-sqlite sync — leading to render-cascade issues during sync).
///
/// Reads are O(rows-for-this-row_pk). Use this in tests + as the canonical reader.
///
/// #!~ Phase 6: cache result on parent for fast direct SELECT, but in a way that doesn't
///     feed back through cr-sqlite's CRR tracking — possibly a separate non-CRR sidecar table.
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

    match render(db, table, column, row_pk) {
        Ok(s) => ctx.result_text_transient(&s),
        Err(msg) => ctx.result_error(&msg),
    }
}

fn render(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
) -> Result<String, String> {
    let _ = (table, column);
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
    stmt.bind_int64(1, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    if stmt.step().map_err(|_| String::from("step render"))? == ResultCode::ROW {
        Ok(String::from(stmt.column_text(0).map_err(|_| String::from("text"))?))
    } else {
        Ok(String::new())
    }
}
