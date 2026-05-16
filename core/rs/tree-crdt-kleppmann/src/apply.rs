//! Apply-op engine — Kleppmann 2022 §3.4 (Fig. 4 lines 26–49).
//!
//! Triggered AFTER INSERT on `{name}__tree_ops` for both local writes (from
//! `crsql_tree_move`) and rows arriving via cr-sqlite's apply path. The
//! algorithm:
//!
//!   1. Snapshot all log entries whose `(lamport_ts, actor)` is strictly
//!      greater than the incoming op's stamp, joined with their original
//!      op rows. Captured in descending stamp order.
//!   2. Undo each of those entries against `__tree_state` (restoring its
//!      pre-op `(parent, meta)`, or removing the row if the node didn't
//!      exist pre-op). Drop them from `__tree_log`.
//!   3. `do_op` the new op: snapshot the pre-state of its node_id, write
//!      a log entry, run the recursive-CTE cycle check, and (if safe)
//!      upsert state.
//!   4. Redo each suffix op in ascending order. Each goes through `do_op`
//!      again — the recomputed pre-state may differ from before, which
//!      is the whole point of the undo/redo: an op that previously formed
//!      a cycle may now be safe (or vice versa).

extern crate alloc;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, ColumnType, Connection, Context, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{escape_ident, log_table, ops_table, state_table, validate_tree_name};
use crate::value::OwnedValue;

/// Trigger-only entry point. Signature:
/// `SELECT crsql_tree_apply(name, lamport_ts, actor)`
pub fn tree_apply(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_tree_apply requires 3 args: (name, lamport_ts, actor)");
        return;
    }
    let name = arg_slice[0].text();
    if let Err(msg) = validate_tree_name(name) {
        ctx.result_error(&msg);
        return;
    }
    if arg_slice[1].value_type() != ColumnType::Integer {
        ctx.result_error("lamport_ts must be INTEGER");
        return;
    }
    if arg_slice[2].value_type() == ColumnType::Null {
        ctx.result_error("actor must not be NULL");
        return;
    }
    let ts = arg_slice[1].int64();
    let actor = OwnedValue::from_value(arg_slice[2]);
    let db = ctx.db_handle();
    if let Err(msg) = apply(db, name, ts, &actor) {
        ctx.result_error(&msg);
    }
}

/// A row from `ops JOIN log` for an op strictly later than the new one.
struct LaterEntry {
    ts: i64,
    actor: OwnedValue,
    node_id: OwnedValue,
    new_parent: OwnedValue,
    meta: OwnedValue,
    old_parent: OwnedValue,
    old_meta: OwnedValue,
    old_existed: bool,
}

/// The five fields of an op needed by `do_op`.
struct OpFields {
    node_id: OwnedValue,
    new_parent: OwnedValue,
    meta: OwnedValue,
}

fn apply(db: *mut sqlite3, name: &str, ts: i64, actor: &OwnedValue) -> Result<(), String> {
    // 0. Idempotency for repeat fires of the same op. cr-sqlite ships rows
    //    per-cell, so a single arriving op fires our trigger multiple times
    //    (once per non-PK column). Each fire must produce the same final
    //    state. Achieve this by undoing any prior log entry for THIS
    //    (ts, actor) first, restoring the pre-op state before we re-do.
    if let Some(existing) = fetch_log_entry(db, name, ts, actor)? {
        undo_log_entry(db, name, &existing, &fetch_op_node_id(db, name, ts, actor)?)?;
        delete_log_entry(db, name, ts, actor)?;
    }

    // 1. snapshot the suffix (entries strictly later than the incoming op)
    let later = snapshot_later(db, name, ts, actor)?;

    // 2. undo them (newest first), then drop them from the log
    for entry in &later {
        undo_op(db, name, entry)?;
    }
    delete_later_log(db, name, ts, actor)?;

    // 3. fetch the incoming op and do_op it
    let new_op = fetch_op(db, name, ts, actor)?;
    do_op(db, name, ts, actor, &new_op)?;

    // 4. redo the suffix in ascending order; do_op recomputes the snapshot
    //    each time, so the rebuilt log entries reflect the new pre-states.
    for entry in later.iter().rev() {
        let op = OpFields {
            node_id: entry.node_id.clone(),
            new_parent: entry.new_parent.clone(),
            meta: entry.meta.clone(),
        };
        do_op(db, name, entry.ts, &entry.actor, &op)?;
    }
    Ok(())
}

/// A prior log entry for (ts, actor) — used by the idempotency shim.
struct LogEntry {
    old_parent: OwnedValue,
    old_meta: OwnedValue,
    old_existed: bool,
}

fn fetch_log_entry(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
) -> Result<Option<LogEntry>, String> {
    let log_esc = escape_ident(&log_table(name));
    let sql = format!(
        "SELECT old_parent, old_meta, old_existed FROM \"{t}\" \
         WHERE lamport_ts = ? AND actor = ?",
        t = log_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare fetch_log_entry: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    actor
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    match stmt.step().map_err(|rc| format!("step fetch_log_entry: {:?}", rc))? {
        ResultCode::ROW => Ok(Some(LogEntry {
            old_parent: OwnedValue::from_column(&stmt, 0)
                .map_err(|rc| format!("read old_parent: {:?}", rc))?,
            old_meta: OwnedValue::from_column(&stmt, 1)
                .map_err(|rc| format!("read old_meta: {:?}", rc))?,
            old_existed: stmt.column_int64(2) != 0,
        })),
        ResultCode::DONE => Ok(None),
        other => Err(format!("fetch_log_entry: unexpected step {:?}", other)),
    }
}

/// Read just the node_id for an op — used by the idempotency undo step,
/// which needs to know which node to roll back.
fn fetch_op_node_id(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
) -> Result<OwnedValue, String> {
    let ops_esc = escape_ident(&ops_table(name));
    let sql = format!(
        "SELECT node_id FROM \"{t}\" WHERE lamport_ts = ? AND actor = ?",
        t = ops_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare fetch_op_node_id: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    actor
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    match stmt.step().map_err(|rc| format!("step fetch_op_node_id: {:?}", rc))? {
        ResultCode::ROW => OwnedValue::from_column(&stmt, 0)
            .map_err(|rc| format!("read node_id: {:?}", rc)),
        other => Err(format!(
            "fetch_op_node_id: row not found ({:?})",
            other
        )),
    }
}

/// Reverse a prior log entry without dropping it (caller does that).
fn undo_log_entry(
    db: *mut sqlite3,
    name: &str,
    entry: &LogEntry,
    node_id: &OwnedValue,
) -> Result<(), String> {
    let state_esc = escape_ident(&state_table(name));
    if !entry.old_existed {
        let sql = format!("DELETE FROM \"{t}\" WHERE node_id = ?", t = state_esc);
        let stmt = db
            .prepare_v2(&sql)
            .map_err(|rc| format!("prepare undo_log_entry delete: {:?}", rc))?;
        node_id
            .bind(&stmt, 1)
            .map_err(|rc| format!("bind node_id: {:?}", rc))?;
        step_done(&stmt, "undo_log_entry delete")?;
        return Ok(());
    }
    let sql = format!(
        "INSERT INTO \"{t}\" (node_id, parent_id, meta) VALUES (?, ?, ?) \
         ON CONFLICT(node_id) DO UPDATE SET parent_id = excluded.parent_id, meta = excluded.meta",
        t = state_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare undo_log_entry upsert: {:?}", rc))?;
    node_id
        .bind(&stmt, 1)
        .map_err(|rc| format!("bind node_id: {:?}", rc))?;
    entry
        .old_parent
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind old_parent: {:?}", rc))?;
    entry
        .old_meta
        .bind(&stmt, 3)
        .map_err(|rc| format!("bind old_meta: {:?}", rc))?;
    step_done(&stmt, "undo_log_entry upsert")
}

fn delete_log_entry(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
) -> Result<(), String> {
    let log_esc = escape_ident(&log_table(name));
    let sql = format!(
        "DELETE FROM \"{t}\" WHERE lamport_ts = ? AND actor = ?",
        t = log_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare delete_log_entry: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    actor
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    step_done(&stmt, "delete_log_entry")
}

fn snapshot_later(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
) -> Result<Vec<LaterEntry>, String> {
    let ops_esc = escape_ident(&ops_table(name));
    let log_esc = escape_ident(&log_table(name));

    // (lamport_ts, actor) > (?, ?) in lexicographic tuple order:
    //   ts > ?  OR  (ts = ? AND actor > ?)
    let sql = format!(
        "SELECT l.lamport_ts, l.actor, o.node_id, o.new_parent, o.meta, \
                l.old_parent, l.old_meta, l.old_existed \
         FROM \"{log}\" l JOIN \"{ops}\" o \
              ON l.lamport_ts = o.lamport_ts AND l.actor = o.actor \
         WHERE l.lamport_ts > ? \
            OR (l.lamport_ts = ? AND l.actor > ?) \
         ORDER BY l.lamport_ts DESC, l.actor DESC",
        log = log_esc,
        ops = ops_esc,
    );

    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare snapshot_later: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    stmt.bind_int64(2, ts).ok();
    actor
        .bind(&stmt, 3)
        .map_err(|rc| format!("bind actor in snapshot_later: {:?}", rc))?;

    let mut out: Vec<LaterEntry> = Vec::new();
    loop {
        match stmt.step().map_err(|rc| format!("step snapshot_later: {:?}", rc))? {
            ResultCode::ROW => {
                out.push(LaterEntry {
                    ts: stmt.column_int64(0),
                    actor: OwnedValue::from_column(&stmt, 1)
                        .map_err(|rc| format!("read actor: {:?}", rc))?,
                    node_id: OwnedValue::from_column(&stmt, 2)
                        .map_err(|rc| format!("read node_id: {:?}", rc))?,
                    new_parent: OwnedValue::from_column(&stmt, 3)
                        .map_err(|rc| format!("read new_parent: {:?}", rc))?,
                    meta: OwnedValue::from_column(&stmt, 4)
                        .map_err(|rc| format!("read meta: {:?}", rc))?,
                    old_parent: OwnedValue::from_column(&stmt, 5)
                        .map_err(|rc| format!("read old_parent: {:?}", rc))?,
                    old_meta: OwnedValue::from_column(&stmt, 6)
                        .map_err(|rc| format!("read old_meta: {:?}", rc))?,
                    old_existed: stmt.column_int64(7) != 0,
                });
            }
            ResultCode::DONE => break,
            other => return Err(format!("snapshot_later: unexpected step {:?}", other)),
        }
    }
    Ok(out)
}

/// Restore state to the pre-op snapshot recorded for `entry`.
fn undo_op(db: *mut sqlite3, name: &str, entry: &LaterEntry) -> Result<(), String> {
    let state_esc = escape_ident(&state_table(name));
    if !entry.old_existed {
        // Node did not exist before this op → delete it.
        let sql = format!("DELETE FROM \"{t}\" WHERE node_id = ?", t = state_esc);
        let stmt = db
            .prepare_v2(&sql)
            .map_err(|rc| format!("prepare undo delete: {:?}", rc))?;
        entry
            .node_id
            .bind(&stmt, 1)
            .map_err(|rc| format!("bind node_id: {:?}", rc))?;
        step_done(&stmt, "undo delete")?;
        return Ok(());
    }
    // Restore prior (parent, meta).
    let sql = format!(
        "INSERT INTO \"{t}\" (node_id, parent_id, meta) VALUES (?, ?, ?) \
         ON CONFLICT(node_id) DO UPDATE SET parent_id = excluded.parent_id, meta = excluded.meta",
        t = state_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare undo upsert: {:?}", rc))?;
    entry
        .node_id
        .bind(&stmt, 1)
        .map_err(|rc| format!("bind node_id: {:?}", rc))?;
    entry
        .old_parent
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind old_parent: {:?}", rc))?;
    entry
        .old_meta
        .bind(&stmt, 3)
        .map_err(|rc| format!("bind old_meta: {:?}", rc))?;
    step_done(&stmt, "undo upsert")?;
    Ok(())
}

fn delete_later_log(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
) -> Result<(), String> {
    let log_esc = escape_ident(&log_table(name));
    let sql = format!(
        "DELETE FROM \"{t}\" WHERE lamport_ts > ? OR (lamport_ts = ? AND actor > ?)",
        t = log_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare delete_later_log: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    stmt.bind_int64(2, ts).ok();
    actor
        .bind(&stmt, 3)
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    step_done(&stmt, "delete_later_log")
}

fn fetch_op(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
) -> Result<OpFields, String> {
    let ops_esc = escape_ident(&ops_table(name));
    let sql = format!(
        "SELECT node_id, new_parent, meta FROM \"{t}\" WHERE lamport_ts = ? AND actor = ?",
        t = ops_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare fetch_op: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    actor
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    match stmt.step().map_err(|rc| format!("step fetch_op: {:?}", rc))? {
        ResultCode::ROW => Ok(OpFields {
            node_id: OwnedValue::from_column(&stmt, 0)
                .map_err(|rc| format!("read node_id: {:?}", rc))?,
            new_parent: OwnedValue::from_column(&stmt, 1)
                .map_err(|rc| format!("read new_parent: {:?}", rc))?,
            meta: OwnedValue::from_column(&stmt, 2)
                .map_err(|rc| format!("read meta: {:?}", rc))?,
        }),
        other => Err(format!(
            "fetch_op: op (ts={}, actor=...) not found ({:?})",
            ts, other
        )),
    }
}

/// do_op: snapshot pre-state for `op.node_id`, write a log entry, check
/// for a cycle, and (if no cycle) upsert state.
///
/// Important: the log entry is always written, even when the op is ignored
/// for cycle/self-parent reasons. That way `undo_op` later in the loop has
/// the snapshot to restore from, and the paper's correctness arguments
/// hold (every op contributes exactly one log entry).
fn do_op(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
    op: &OpFields,
) -> Result<(), String> {
    // a. pre-state snapshot
    let (old_parent, old_meta, old_existed) = lookup_state(db, name, &op.node_id)?;

    // b. log entry
    insert_log(
        db,
        name,
        ts,
        actor,
        &old_parent,
        &old_meta,
        old_existed,
    )?;

    // c. cycle / self-parent rejection — state untouched
    if op.node_id == op.new_parent {
        return Ok(());
    }
    if !op.new_parent.is_null() && causes_cycle(db, name, &op.node_id, &op.new_parent)? {
        return Ok(());
    }

    // d. upsert state
    upsert_state(db, name, &op.node_id, &op.new_parent, &op.meta)
}

fn lookup_state(
    db: *mut sqlite3,
    name: &str,
    node_id: &OwnedValue,
) -> Result<(OwnedValue, OwnedValue, bool), String> {
    let state_esc = escape_ident(&state_table(name));
    let sql = format!(
        "SELECT parent_id, meta FROM \"{t}\" WHERE node_id = ?",
        t = state_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare lookup_state: {:?}", rc))?;
    node_id
        .bind(&stmt, 1)
        .map_err(|rc| format!("bind node_id: {:?}", rc))?;
    match stmt.step().map_err(|rc| format!("step lookup_state: {:?}", rc))? {
        ResultCode::ROW => Ok((
            OwnedValue::from_column(&stmt, 0)
                .map_err(|rc| format!("read parent: {:?}", rc))?,
            OwnedValue::from_column(&stmt, 1).map_err(|rc| format!("read meta: {:?}", rc))?,
            true,
        )),
        ResultCode::DONE => Ok((OwnedValue::Null, OwnedValue::Null, false)),
        other => Err(format!("lookup_state: unexpected step {:?}", other)),
    }
}

fn insert_log(
    db: *mut sqlite3,
    name: &str,
    ts: i64,
    actor: &OwnedValue,
    old_parent: &OwnedValue,
    old_meta: &OwnedValue,
    old_existed: bool,
) -> Result<(), String> {
    let log_esc = escape_ident(&log_table(name));
    // ON CONFLICT to remain idempotent if the trigger somehow fires twice
    // for the same (ts, actor) — defensive only; cr-sqlite's apply should
    // de-dupe via the table's primary key.
    let sql = format!(
        "INSERT INTO \"{t}\" (lamport_ts, actor, old_parent, old_meta, old_existed) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(lamport_ts, actor) DO UPDATE SET \
             old_parent = excluded.old_parent, \
             old_meta = excluded.old_meta, \
             old_existed = excluded.old_existed",
        t = log_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare insert_log: {:?}", rc))?;
    stmt.bind_int64(1, ts).ok();
    actor
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind actor: {:?}", rc))?;
    old_parent
        .bind(&stmt, 3)
        .map_err(|rc| format!("bind old_parent: {:?}", rc))?;
    old_meta
        .bind(&stmt, 4)
        .map_err(|rc| format!("bind old_meta: {:?}", rc))?;
    stmt.bind_int64(5, if old_existed { 1 } else { 0 })
        .map_err(|rc| format!("bind old_existed: {:?}", rc))?;
    step_done(&stmt, "insert_log")
}

/// Recursive-CTE ancestor walk from `new_parent`. Returns true iff
/// `node_id` appears in the ancestor chain — i.e., moving `node_id`
/// under `new_parent` would create a cycle.
///
/// Bounded by tree depth and uses the `parent_id` index on `__tree_state`.
fn causes_cycle(
    db: *mut sqlite3,
    name: &str,
    node_id: &OwnedValue,
    new_parent: &OwnedValue,
) -> Result<bool, String> {
    let state_esc = escape_ident(&state_table(name));

    // The CTE seeds with `new_parent` and walks parent_id upward. If we
    // ever land on `node_id`, a cycle would form. SQLite recursive CTEs
    // can't accept BLOB seeds via `VALUES (?)` cleanly across all builds,
    // so seed via a `SELECT ?` and let SQLite handle the type cleanly.
    let sql = format!(
        "WITH RECURSIVE anc(node) AS ( \
             SELECT ? \
             UNION ALL \
             SELECT s.parent_id FROM \"{state}\" s JOIN anc ON s.node_id = anc.node \
                 WHERE s.parent_id IS NOT NULL \
         ) \
         SELECT EXISTS(SELECT 1 FROM anc WHERE node = ?)",
        state = state_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare causes_cycle: {:?}", rc))?;
    new_parent
        .bind(&stmt, 1)
        .map_err(|rc| format!("bind new_parent: {:?}", rc))?;
    node_id
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind node_id: {:?}", rc))?;
    match stmt.step().map_err(|rc| format!("step causes_cycle: {:?}", rc))? {
        ResultCode::ROW => Ok(stmt.column_int64(0) != 0),
        other => Err(format!("causes_cycle: unexpected step {:?}", other)),
    }
}

fn upsert_state(
    db: *mut sqlite3,
    name: &str,
    node_id: &OwnedValue,
    parent: &OwnedValue,
    meta: &OwnedValue,
) -> Result<(), String> {
    let state_esc = escape_ident(&state_table(name));
    let sql = format!(
        "INSERT INTO \"{t}\" (node_id, parent_id, meta) VALUES (?, ?, ?) \
         ON CONFLICT(node_id) DO UPDATE SET parent_id = excluded.parent_id, meta = excluded.meta",
        t = state_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|rc| format!("prepare upsert_state: {:?}", rc))?;
    node_id
        .bind(&stmt, 1)
        .map_err(|rc| format!("bind node_id: {:?}", rc))?;
    parent
        .bind(&stmt, 2)
        .map_err(|rc| format!("bind parent: {:?}", rc))?;
    meta.bind(&stmt, 3)
        .map_err(|rc| format!("bind meta: {:?}", rc))?;
    step_done(&stmt, "upsert_state")
}

fn step_done(stmt: &sqlite::ManagedStmt, label: &str) -> Result<(), String> {
    match stmt.step() {
        Ok(ResultCode::DONE) => Ok(()),
        Ok(other) => Err(format!("{}: expected DONE, got {:?}", label, other)),
        Err(rc) => Err(format!("{}: {:?}", label, rc)),
    }
}
