extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, ColumnType, Connection, Context, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{escape_ident, ops_table, validate_tree_name};

/// SQL: `SELECT crsql_tree_move(name, node_id, new_parent, meta, lamport_ts, actor)`
///
/// Appends a move op to `{name}__tree_ops`. The AFTER INSERT trigger
/// installed by `crsql_create_tree` will fire `crsql_tree_apply`, which
/// runs the undo/do/redo loop against `{name}__tree_state` + `__tree_log`.
///
/// `new_parent` and `meta` may be NULL.
/// `node_id` and `actor` must be non-NULL.
/// `lamport_ts` must be an INTEGER.
///
/// `(lamport_ts, actor)` is the totally-ordered op stamp. The caller is
/// responsible for monotonically advancing `lamport_ts` and picking a
/// stable `actor` byte string; the CRDT does not own the clock.
pub fn tree_move(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 6 {
        ctx.result_error(
            "crsql_tree_move requires 6 args: (name, node_id, new_parent, meta, lamport_ts, actor)",
        );
        return;
    }

    let name = arg_slice[0].text();
    if let Err(msg) = validate_tree_name(name) {
        ctx.result_error(&msg);
        return;
    }

    // args layout: name(0), node_id(1), new_parent(2), meta(3), lamport_ts(4), actor(5)
    if arg_slice[1].value_type() == ColumnType::Null {
        ctx.result_error("node_id must not be NULL");
        return;
    }
    if arg_slice[4].value_type() != ColumnType::Integer {
        ctx.result_error("lamport_ts must be INTEGER");
        return;
    }
    if arg_slice[5].value_type() == ColumnType::Null {
        ctx.result_error("actor must not be NULL");
        return;
    }

    let db = ctx.db_handle();
    if let Err(msg) = insert_op(db, name, arg_slice) {
        ctx.result_error(&msg);
    }
}

fn insert_op(
    db: *mut sqlite3,
    name: &str,
    args: &[*mut sqlite::value],
) -> Result<(), String> {
    let ops = ops_table(name);
    let ops_esc = escape_ident(&ops);

    let sql = format!(
        "INSERT INTO \"{t}\" (lamport_ts, actor, node_id, new_parent, meta) \
         VALUES (?, ?, ?, ?, ?)",
        t = ops_esc
    );

    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare insert into {}: {:?}", ops, rc))?;

    // bind order matches placeholders: lamport_ts, actor, node_id, new_parent, meta
    stmt.bind_value(1, args[4])
        .map_err(|rc| format!("bind lamport_ts: {:?}", rc))?;
    stmt.bind_value(2, args[5])
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    stmt.bind_value(3, args[1])
        .map_err(|rc| format!("bind node_id: {:?}", rc))?;
    stmt.bind_value(4, args[2])
        .map_err(|rc| format!("bind new_parent: {:?}", rc))?;
    stmt.bind_value(5, args[3])
        .map_err(|rc| format!("bind meta: {:?}", rc))?;

    match stmt.step() {
        Ok(ResultCode::DONE) => Ok(()),
        Ok(other) => Err(format!("insert into {} returned {:?}", ops, other)),
        Err(rc) => Err(format!("insert into {} failed: {:?}", ops, rc)),
    }
}
