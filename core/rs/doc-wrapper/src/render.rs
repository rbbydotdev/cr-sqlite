//! `crsql_doc_render() → TEXT` — return current doc as a neutral
//! block-tree JSON. Same shape that `crsql_doc_apply` consumes.
//!
//! Built directly via SQL using json_object / json_group_array — no
//! Rust JSON serializer needed. We just compose the query and bind once.

extern crate alloc;
use alloc::string::String;
use sqlite::{args, context, Connection, Context, ResultCode};
use sqlite_nostd as sqlite;

pub fn doc_render(ctx: *mut context, _argc: i32, _argv: *mut *mut sqlite::value) {
    let _ = args!(_argc, _argv);
    let db = ctx.db_handle();
    // Order-preserving aggregation: SQLite 3.45+ supports `ORDER BY` inside
    // aggregate function calls. Without this, json_group_array would emit
    // rows in unspecified order regardless of an outer ORDER BY.
    let sql = "\
        WITH walk(node, ord_path) AS ( \
            SELECT s.node_id, CAST(s.meta AS BLOB) \
            FROM   doc__tree_state s \
            WHERE  s.parent_id = X'01' \
        ) \
        SELECT COALESCE(json_group_array(json_object( \
            'id',    lower(hex(b.id)), \
            'kind',  b.kind, \
            'spans', json(b.body) \
        ) ORDER BY w.ord_path), '[]') \
        FROM walk w \
        JOIN blocks b ON b.id = w.node \
        WHERE b.id != X'ff'";
    let stmt = match db.prepare_v2(sql) {
        Ok(s) => s,
        Err(_) => { ctx.result_error("prepare doc_render"); return; }
    };
    match stmt.step() {
        Ok(ResultCode::ROW) => {
            let s = stmt.column_text(0).unwrap_or("[]");
            ctx.result_text_transient(s);
        }
        _ => ctx.result_text_transient("[]"),
    }
}

// `[fn _silence_unused_string_import]` — keep alloc::string::String referenced
// even if no other use in this file changes.
#[allow(dead_code)]
fn _keep_use() -> String { String::new() }
