//! `crsql_as_peritext(table, column, additive_names?)` — promote a column
//! to a Peritext rich-text CRDT.
//!
//! Steps:
//!   1. Ensure the column is registered as a Fugue text-CRDT (under the
//!      hood `crsql_as_peritext` calls `crsql_as_text_crdt` for char-level
//!      collaboration).
//!   2. Create the per-column marks table (CRR) and the shared metadata
//!      table (`__crsql_peritext_meta`).
//!   3. Record the `additive_names` list (if any) in the metadata table.
//!   4. Install render triggers on BOTH the marks table AND the Fugue
//!      backing table so the parent column's portable-text JSON stays
//!      fresh on any kind of change.

extern crate alloc;
use alloc::format;
use alloc::string::String;
use crsql_text_crdt_fugue::{backing_table_name, escape_ident};
use sqlite::{args, context, sqlite3, ColumnType, Connection, Context, Destructor, Value};
use sqlite_nostd as sqlite;

use crate::util::{marks_table_name, validate_ident, META_TABLE};

pub fn as_peritext(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() < 2 || arg_slice.len() > 3 {
        ctx.result_error(
            "crsql_as_peritext requires 2 or 3 args: (table, column[, additive_names_json])",
        );
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let additive_names = if arg_slice.len() == 3
        && arg_slice[2].value_type() != ColumnType::Null
    {
        arg_slice[2].text()
    } else {
        ""
    };

    if let Err(msg) = validate_ident(table, "table") {
        ctx.result_error(&msg);
        return;
    }
    if let Err(msg) = validate_ident(column, "column") {
        ctx.result_error(&msg);
        return;
    }

    let db = ctx.db_handle();
    if let Err(msg) = register(db, table, column, additive_names) {
        ctx.result_error(&msg);
    }
}

fn register(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    additive_names: &str,
) -> Result<(), String> {
    // 1. Underlying char CRDT. If the column is already a text-CRDT this
    //    is a no-op (idempotent). Quote the args defensively.
    let promote_text = format!(
        "SELECT crsql_as_text_crdt('{}', '{}')",
        table.replace('\'', "''"),
        column.replace('\'', "''"),
    );
    db.exec_safe(&promote_text)
        .map_err(|_| format!("failed to promote {}.{} to text-crdt", table, column))?;

    // 2. Marks table.
    let marks = marks_table_name(table, column);
    let marks_esc = escape_ident(&marks);
    // Anchors carry a (start_item, start_idx, start_side) triple because
    // Fugue β-flat packs multiple chars into one row — itemId alone
    // doesn't uniquely identify a character. `*_idx` is the char's
    // abs_idx within its row's content (matches the row's `idx` column
    // for the last char, `idx - len + 1` for the first).
    let create_marks = format!(
        "CREATE TABLE IF NOT EXISTS \"{t}\" (\
            lamport_ts INTEGER NOT NULL,\
            actor      BLOB    NOT NULL,\
            row_pk     BLOB,\
            start_item TEXT,\
            start_idx  INTEGER NOT NULL DEFAULT 0,\
            start_side INTEGER,\
            end_item   TEXT,\
            end_idx    INTEGER NOT NULL DEFAULT 0,\
            end_side   INTEGER,\
            mark_name  TEXT,\
            mark_value BLOB,\
            is_add     INTEGER NOT NULL DEFAULT 0,\
            PRIMARY KEY (lamport_ts, actor)\
         )",
        t = marks_esc
    );
    db.exec_safe(&create_marks)
        .map_err(|_| format!("failed to create {}", marks))?;

    // Promote to CRR so the marks log replicates.
    let as_crr = format!("SELECT crsql_as_crr('{}')", marks.replace('\'', "''"));
    db.exec_safe(&as_crr)
        .map_err(|_| format!("failed to mark {} as CRR", marks))?;

    // 3. Shared metadata table — one row per (table, column) registration,
    //    storing the additive-name list. Not a CRR; replica-local.
    let create_meta = format!(
        "CREATE TABLE IF NOT EXISTS \"{t}\" (\
            parent_table  TEXT NOT NULL,\
            parent_column TEXT NOT NULL,\
            additive_json TEXT NOT NULL DEFAULT '',\
            PRIMARY KEY (parent_table, parent_column)\
         )",
        t = META_TABLE
    );
    db.exec_safe(&create_meta)
        .map_err(|_| String::from("failed to create __crsql_peritext_meta"))?;

    let upsert_meta = format!(
        "INSERT INTO \"{t}\" (parent_table, parent_column, additive_json) VALUES (?, ?, ?) \
         ON CONFLICT(parent_table, parent_column) DO UPDATE SET additive_json = excluded.additive_json",
        t = META_TABLE
    );
    let stmt = db
        .prepare_v2(&upsert_meta)
        .map_err(|_| String::from("prepare meta upsert"))?;
    stmt.bind_text(1, table, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind parent_table"))?;
    stmt.bind_text(2, column, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind parent_column"))?;
    stmt.bind_text(3, additive_names, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind additive_json"))?;
    stmt.step()
        .map_err(|_| String::from("step meta upsert"))?;

    // 4. Render triggers. Two sources fire re-render of the parent column:
    //    (a) marks-table changes (this layer's ops)
    //    (b) Fugue backing-table changes (text edits, sync-apply of remote chars)
    //
    //    Both must drive the same portable-text JSON projection. We install
    //    AFTER INSERT/UPDATE/DELETE triggers on both tables; each calls the
    //    shared `crsql_peritext_render` UDF and writes to the parent column.
    install_render_triggers(db, table, column, &marks)?;

    Ok(())
}

fn install_render_triggers(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    marks: &str,
) -> Result<(), String> {
    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);
    let marks_esc = escape_ident(marks);

    let table_lit = table.replace('\'', "''");
    let column_lit = column.replace('\'', "''");

    // Re-use the existing `__crsql_fugue_active` suppression counter:
    // the text-CRDT's render triggers are gated on it, and so should
    // ours. While a Fugue insertion/deletion is composing multi-row
    // writes, we don't want to re-render after each — we want a single
    // render at end-of-call. The text-CRDT layer already brackets its
    // work with counter++/--.
    let when_clause = String::from(
        " WHEN (SELECT counter FROM __crsql_fugue_active WHERE id=1) = 0",
    );

    // Resolve the parent table's PK column so the trigger can match rows.
    let pk_col = parent_pk_column(db, table)?;
    let pk_col_esc = escape_ident(&pk_col);
    // Hoisted aliases for use in both marks-table and parent-table triggers.
    let parent_esc = escape_ident(table);
    let col_esc = escape_ident(column);
    let pk_col_esc_clone = escape_ident(&pk_col);

    // Trigger body: project portable-text JSON via the render UDF and
    // write it into the parent column.
    let render_body = |pk_expr: &str| -> String {
        format!(
            "UPDATE \"{parent}\" SET \"{col}\" = crsql_peritext_render('{ptab}', '{pcol}', {pk}) \
             WHERE \"{pk_col}\" = {pk}",
            parent = escape_ident(table),
            col = escape_ident(column),
            ptab = table_lit,
            pcol = column_lit,
            pk = pk_expr,
            pk_col = pk_col_esc,
        )
    };

    // Marks-table triggers: invalidate the parent column's JSON so the
    // notes-table trigger picks up "non-JSON content" and re-renders.
    //
    // Why indirect? Calling crsql_peritext_render directly from the marks-
    // table trigger fails during cr-sqlite's per-cell apply path with a
    // generic "SQL logic error" — re-entering the same CRR table for a
    // SELECT inside a trigger fired by `INSERT INTO crsql_changes` trips
    // up cr-sqlite's apply machinery. Setting body='' is a side-effect-
    // only write that the notes-trigger then promotes to JSON.
    //
    // Note: this means during apply of a remote mark, body becomes ''
    // briefly between the marks-trigger and notes-trigger fires. Both
    // run in the same statement / transaction, so external readers
    // never observe the empty intermediate value at commit.
    let invalidate_body = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = '' \
         WHERE \"{pk}\" = {{pk}} AND substr(\"{col}\", 1, 1) = '['",
        parent = parent_esc,
        col = col_esc,
        pk = pk_col_esc_clone,
    );
    for (event, pk_ref, suffix, when) in &[
        ("INSERT", "NEW.row_pk", "ai", " WHEN NEW.row_pk IS NOT NULL"),
        ("UPDATE", "NEW.row_pk", "au", " WHEN NEW.row_pk IS NOT NULL"),
        ("DELETE", "OLD.row_pk", "ad", " WHEN OLD.row_pk IS NOT NULL"),
    ] {
        let body = invalidate_body.replace("{pk}", pk_ref);
        let trig_name = format!("{marks}__invalidate_{suffix}");
        let sql = format!(
            "CREATE TRIGGER IF NOT EXISTS \"{trig}\" \
             AFTER {event} ON \"{marks}\"{when} BEGIN {body}; END",
            trig = escape_ident(&trig_name),
            event = event,
            marks = marks_esc,
            when = when,
            body = body,
        );
        db.exec_safe(&sql).map_err(|_| {
            format!(
                "failed to install AFTER {} invalidate trigger on {}",
                event, marks
            )
        })?;
    }

    // Parent-table triggers — convert plain text → JSON.
    //
    // Fugue's `rerender_parent_column` writes plain text into the parent
    // column at the end of every fugue_insert/delete (and from backing-
    // table change triggers on sync-apply paths). We need that plain
    // text to become portable-text JSON. Trigger on UPDATE-of-body and
    // INSERT into the parent. WHEN guard prevents infinite recursion:
    // if the column already holds JSON (starts with '['), skip.
    let _ = backing_esc; // suppress unused warning now that backing triggers are gone

    let upgrade_body = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = crsql_peritext_render('{ptab}', '{pcol}', NEW.\"{pk}\") \
         WHERE \"{pk}\" = NEW.\"{pk}\"",
        parent = parent_esc,
        col = col_esc,
        ptab = table_lit,
        pcol = column_lit,
        pk = pk_col_esc_clone,
    );

    // The WHEN clause: trigger fires when body is NULL, empty, or
    // doesn't start with '[' — i.e. anything that isn't already a
    // JSON array. Our render output always starts with '['.
    let needs_upgrade = format!(
        "(NEW.\"{col}\" IS NULL OR length(NEW.\"{col}\") = 0 \
          OR substr(NEW.\"{col}\", 1, 1) != '[')",
        col = col_esc
    );

    let trig_ai = format!("{table}__peritext_render_ai");
    let sql_ai = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{trig}\" \
         AFTER INSERT ON \"{parent}\" FOR EACH ROW \
         WHEN {when} BEGIN {body}; END",
        trig = escape_ident(&trig_ai),
        parent = parent_esc,
        when = needs_upgrade,
        body = upgrade_body,
    );
    db.exec_safe(&sql_ai).map_err(|_| {
        format!("failed to install AFTER INSERT render trigger on {}", table)
    })?;

    let trig_au = format!("{table}__peritext_render_au");
    let sql_au = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{trig}\" \
         AFTER UPDATE OF \"{col}\" ON \"{parent}\" FOR EACH ROW \
         WHEN {when} BEGIN {body}; END",
        trig = escape_ident(&trig_au),
        col = col_esc,
        parent = parent_esc,
        when = needs_upgrade,
        body = upgrade_body,
    );
    db.exec_safe(&sql_au).map_err(|_| {
        format!("failed to install AFTER UPDATE render trigger on {}", table)
    })?;

    // recursive_triggers must be ON so the AFTER UPDATE trigger's own
    // body-UPDATE causes the trigger to re-evaluate — the WHEN guard
    // then short-circuits because the new value starts with '['.
    db.exec_safe("PRAGMA recursive_triggers = ON")
        .map_err(|_| String::from("failed to enable recursive_triggers"))?;

    Ok(())
}

/// Same idea as text-crdt-fugue's `parent_pk_column` — resolve the parent
/// table's PK column name so the render trigger can match rows. Local
/// copy so we don't have to widen text-crdt-fugue's pub surface further.
pub(crate) fn parent_pk_column(db: *mut sqlite3, table: &str) -> Result<String, String> {
    use alloc::vec::Vec;
    use sqlite::ResultCode;
    let stmt = db
        .prepare_v2("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk")
        .map_err(|_| String::from("prepare pragma_table_info"))?;
    stmt.bind_text(1, table, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind table name"))?;
    let mut cols: Vec<String> = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step pragma_table_info"))? {
            ResultCode::ROW => {
                let name = stmt
                    .column_text(0)
                    .map_err(|_| String::from("read pk col name"))?;
                cols.push(String::from(name));
            }
            ResultCode::DONE => break,
            _ => return Err(String::from("pragma_table_info unexpected step")),
        }
    }
    if cols.is_empty() {
        Ok(String::from("rowid"))
    } else if cols.len() == 1 {
        Ok(cols.into_iter().next().unwrap())
    } else {
        Err(format!(
            "compound primary keys are not supported (table '{}' has {} PK columns)",
            table,
            cols.len()
        ))
    }
}
