extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context, Value};
use sqlite_nostd as sqlite;

use crate::util::{
    escape_ident, escape_sql_lit, log_table, ops_table, state_table, validate_tree_name,
};

/// SQL: `SELECT crsql_create_tree(name)`
///
/// Registers a new replicated tree under `name`. Idempotent: re-calling with
/// the same name is a no-op (all DDL uses IF NOT EXISTS).
///
/// Creates three tables:
///   `{name}__tree_ops`   — CRDT-tracked raw move-ops (the wire log)
///   `{name}__tree_log`   — local-only apply-time snapshots used for undo
///   `{name}__tree_state` — materialized parent-of relation
///
/// Installs an `AFTER INSERT` trigger on `__tree_ops` that routes each new
/// row (local or sync-applied) through `crsql_tree_apply`, which runs
/// Kleppmann's undo/do/redo loop.
pub fn create_tree(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 1 {
        ctx.result_error("crsql_create_tree requires 1 arg: (name)");
        return;
    }
    let name = arg_slice[0].text();
    if let Err(msg) = validate_tree_name(name) {
        ctx.result_error(&msg);
        return;
    }
    let db = ctx.db_handle();
    if let Err(msg) = register(db, name) {
        ctx.result_error(&msg);
    }
}

fn register(db: *mut sqlite3, name: &str) -> Result<(), String> {
    let ops = ops_table(name);
    let log = log_table(name);
    let state = state_table(name);

    let ops_esc = escape_ident(&ops);
    let log_esc = escape_ident(&log);
    let state_esc = escape_ident(&state);
    let name_lit = escape_sql_lit(name);

    // 1. CRDT-tracked ops table. Primary key is (lamport_ts, actor): together
    //    they form the total order over operations.
    // node_id is logically NOT NULL but declared nullable: cr-sqlite's
    // CRR-shape check rejects non-PK NOT NULL columns without a DEFAULT
    // value (forwards-compat: a newer schema with a new NOT NULL col
    // would otherwise reject rows arriving from older peers). Non-null
    // is enforced by crsql_tree_move at the UDF entry point instead.
    let create_ops = format!(
        "CREATE TABLE IF NOT EXISTS \"{t}\" (\
            lamport_ts INTEGER NOT NULL,\
            actor      BLOB    NOT NULL,\
            node_id    BLOB,\
            new_parent BLOB,\
            meta       BLOB,\
            PRIMARY KEY (lamport_ts, actor)\
         )",
        t = ops_esc
    );
    db.exec_safe(&create_ops)
        .map_err(|_| format!("failed to create {}", ops))?;

    // Promote to CRR so cr-sqlite ships these rows between peers.
    let as_crr = format!("SELECT crsql_as_crr('{}')", escape_sql_lit(&ops));
    db.exec_safe(&as_crr)
        .map_err(|_| format!("failed to mark {} as CRR", ops))?;

    // 2. Local-only undo log. Each entry mirrors an op's (ts, actor) and
    //    records the (old_parent, old_meta, old_existed) snapshot that
    //    do_op observed when it ran. NOT a CRR — replica-local.
    let create_log = format!(
        "CREATE TABLE IF NOT EXISTS \"{t}\" (\
            lamport_ts  INTEGER NOT NULL,\
            actor       BLOB    NOT NULL,\
            old_parent  BLOB,\
            old_meta    BLOB,\
            old_existed INTEGER NOT NULL,\
            PRIMARY KEY (lamport_ts, actor)\
         )",
        t = log_esc
    );
    db.exec_safe(&create_log)
        .map_err(|_| format!("failed to create {}", log))?;

    // 3. Materialized current state. Derived; rebuilt by apply_op.
    let create_state = format!(
        "CREATE TABLE IF NOT EXISTS \"{t}\" (\
            node_id   BLOB PRIMARY KEY,\
            parent_id BLOB,\
            meta      BLOB\
         )",
        t = state_esc
    );
    db.exec_safe(&create_state)
        .map_err(|_| format!("failed to create {}", state))?;

    let create_state_idx = format!(
        "CREATE INDEX IF NOT EXISTS \"{t}__parent_idx\" ON \"{t}\" (parent_id)",
        t = state_esc
    );
    db.exec_safe(&create_state_idx)
        .map_err(|_| format!("failed to create parent index on {}", state))?;

    // 4. Drive apply on every insert into the ops table — local writes and
    //    sync-applied rows route through the same single trigger.
    install_apply_trigger(db, &ops, &name_lit)?;

    Ok(())
}

/// AFTER INSERT and AFTER UPDATE triggers on the ops table.
///
/// Both fire for local writes (the INSERT from `crsql_tree_move`) and for
/// rows arriving via cr-sqlite's apply path. cr-sqlite ships changesets
/// per-cell: the first cell write does an INSERT (PK + that one column,
/// others NULL), subsequent cells each do an UPDATE on the same PK. To
/// keep state consistent we must re-run apply on every cell — apply_op
/// is built to be idempotent for the same (ts, actor), so repeat fires
/// converge to the right state regardless of how many cells arrive.
fn install_apply_trigger(db: *mut sqlite3, ops: &str, name_lit: &str) -> Result<(), String> {
    let ops_esc = escape_ident(ops);

    let body = format!(
        "SELECT crsql_tree_apply('{name}', NEW.lamport_ts, NEW.actor);",
        name = name_lit,
    );

    let trig_ai = format!("{}__apply_ai", ops);
    let trig_ai_esc = escape_ident(&trig_ai);
    let sql_ai = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{trig}\" \
         AFTER INSERT ON \"{ops}\" FOR EACH ROW BEGIN {body} END",
        trig = trig_ai_esc,
        ops = ops_esc,
        body = body,
    );
    db.exec_safe(&sql_ai)
        .map_err(|_| format!("failed to install AFTER INSERT apply trigger on {}", ops))?;

    let trig_au = format!("{}__apply_au", ops);
    let trig_au_esc = escape_ident(&trig_au);
    let sql_au = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{trig}\" \
         AFTER UPDATE ON \"{ops}\" FOR EACH ROW BEGIN {body} END",
        trig = trig_au_esc,
        ops = ops_esc,
        body = body,
    );
    db.exec_safe(&sql_au)
        .map_err(|_| format!("failed to install AFTER UPDATE apply trigger on {}", ops))?;
    Ok(())
}
