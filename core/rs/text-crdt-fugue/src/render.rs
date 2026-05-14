extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

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
        "WITH RECURSIVE under_node(content, level, itemId, idx) AS (\
            VALUES ('', 0, '', -2) \
            UNION ALL \
            SELECT f.content, under_node.level + 1, f.itemId, f.idx \
            FROM \"{backing}\" f \
            JOIN under_node ON f.parentItemId = under_node.itemId AND f.parentIdx = under_node.idx \
            WHERE f.row_pk = ? \
            ORDER BY 2 DESC, f.itemId, f.idx \
         ) \
         SELECT IFNULL(group_concat(content, ''), '') FROM under_node \
         WHERE idx != -1 AND content IS NOT NULL",
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
