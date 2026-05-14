extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// SQL function `crsql_as_text_crdt(table, column)`:
///
///   1. validate parent `table` is a CRR (has `{table}__crsql_clock`)
///   2. validate `column` exists on parent
///   3. CREATE backing table `__crsql_fugue_{table}_{column}` (Weidner schema, WITHOUT ROWID)
///   4. mark backing as CRR via `crsql_as_crr`
///   5. install AFTER INSERT render trigger that materializes parent.column from backing rows
///
/// Idempotent — uses `IF NOT EXISTS` everywhere. Calling twice on the same pair is a no-op.
pub fn as_text_crdt(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 2 {
        ctx.result_error("crsql_as_text_crdt requires exactly 2 arguments: (table, column)");
        return;
    }

    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let db = ctx.db_handle();

    if let Err(msg) = register(db, table, column) {
        ctx.result_error(&msg);
    }
}

fn register(db: *mut sqlite3, table: &str, column: &str) -> Result<(), String> {
    // 1. parent must be a CRR
    if !is_crr(db, table).map_err(|_| String::from("failed to inspect sqlite_master"))? {
        return Err(format!(
            "Table '{}' is not a CRR — call crsql_as_crr('{}') first",
            table, table
        ));
    }

    // 2. column must exist on parent
    if !column_exists(db, table, column)
        .map_err(|_| String::from("failed to inspect pragma_table_info"))?
    {
        return Err(format!(
            "Column '{}' does not exist on table '{}'",
            column, table
        ));
    }

    // #!~ Phase 1: parent must have a single INTEGER PRIMARY KEY (aliased to rowid).
    // Compound PKs or TEXT PKs require row_pk to be a different shape — extend later.
    // For now we don't enforce this; the render trigger will silently noop on mismatched parents.

    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);

    // 3. create backing table — Weidner schema (renaming "index" → "idx" to avoid the SQL keyword)
    //    WITHOUT ROWID per the perf-principles section of the plan.
    let create_table = format!(
        "CREATE TABLE IF NOT EXISTS \"{backing}\" (\
            row_pk INTEGER NOT NULL,\
            itemId TEXT NOT NULL,\
            idx INTEGER NOT NULL,\
            content TEXT,\
            parentItemId TEXT,\
            parentIdx INTEGER,\
            PRIMARY KEY (row_pk, itemId, idx)\
         ) WITHOUT ROWID",
        backing = backing_esc
    );
    db.exec_safe(&create_table)
        .map_err(|_| format!("failed to create backing table {}", backing))?;

    // index on (row_pk, parentItemId, parentIdx) for the recursive read query's join
    let create_index = format!(
        "CREATE INDEX IF NOT EXISTS \"{backing}__parent_idx\" \
         ON \"{backing}\" (row_pk, parentItemId, parentIdx)",
        backing = backing_esc
    );
    db.exec_safe(&create_index)
        .map_err(|_| format!("failed to create parent index on {}", backing))?;

    // 4. mark backing as CRR — single-quote-escape via cr-sqlite's existing function
    let as_crr = format!(
        "SELECT crsql_as_crr('{}')",
        backing.replace('\'', "''")
    );
    db.exec_safe(&as_crr)
        .map_err(|_| format!("failed to mark {} as CRR", backing))?;

    // 5. render trigger on INSERT into backing
    //    Materializes parent.column via the Weidner recursive CTE.
    //    #!~ Phase 3: extend to UPDATE/DELETE on backing too (tombstones)
    //    #!~ Phase 6: move to COMMIT hook if profiling shows quadratic
    install_render_trigger(db, &backing, table, column)?;

    Ok(())
}

fn is_crr(db: *mut sqlite3, table: &str) -> Result<bool, ResultCode> {
    let clock = format!("{}__crsql_clock", table);
    let stmt =
        db.prepare_v2("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?")?;
    stmt.bind_text(1, &clock, Destructor::STATIC)?;
    if stmt.step()? == ResultCode::ROW {
        Ok(stmt.column_int(0) > 0)
    } else {
        Ok(false)
    }
}

fn column_exists(db: *mut sqlite3, table: &str, column: &str) -> Result<bool, ResultCode> {
    let stmt = db.prepare_v2("SELECT count(*) FROM pragma_table_info(?) WHERE name=?")?;
    stmt.bind_text(1, table, Destructor::STATIC)?;
    stmt.bind_text(2, column, Destructor::STATIC)?;
    if stmt.step()? == ResultCode::ROW {
        Ok(stmt.column_int(0) > 0)
    } else {
        Ok(false)
    }
}

fn install_render_trigger(
    db: *mut sqlite3,
    backing: &str,
    parent_table: &str,
    parent_column: &str,
) -> Result<(), String> {
    let backing_esc = escape_ident(backing);
    let parent_esc = escape_ident(parent_table);
    let col_esc = escape_ident(parent_column);

    let render_body = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = (\
            WITH RECURSIVE under_node(content, level, itemId, idx) AS (\
                VALUES ('', 0, '', -2) \
                UNION ALL \
                SELECT f.content, under_node.level + 1, f.itemId, f.idx \
                FROM \"{backing}\" f \
                JOIN under_node ON f.parentItemId = under_node.itemId AND f.parentIdx = under_node.idx \
                WHERE f.row_pk = ROW_PK_PARAM \
                ORDER BY 2 DESC, f.itemId, f.idx \
            ) \
            SELECT IFNULL(group_concat(content, ''), '') FROM under_node \
            WHERE idx != -1 AND content IS NOT NULL \
        ) \
        WHERE rowid = ROW_PK_PARAM",
        parent = parent_esc,
        col = col_esc,
        backing = backing_esc
    );

    // AFTER INSERT — also fires when cr-sqlite's apply inserts via crsql_changes
    let trig_ai = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__render_ai\" \
         AFTER INSERT ON \"{backing}\" BEGIN {body}; END",
        backing = backing_esc,
        body = render_body.replace("ROW_PK_PARAM", "NEW.row_pk")
    );
    db.exec_safe(&trig_ai)
        .map_err(|_| format!("failed to install AFTER INSERT trigger on {}", backing))?;

    // AFTER UPDATE — content/tombstone changes from local edits or sync
    let trig_au = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__render_au\" \
         AFTER UPDATE ON \"{backing}\" BEGIN {body}; END",
        backing = backing_esc,
        body = render_body.replace("ROW_PK_PARAM", "NEW.row_pk")
    );
    db.exec_safe(&trig_au)
        .map_err(|_| format!("failed to install AFTER UPDATE trigger on {}", backing))?;

    // AFTER DELETE — completeness; cr-sqlite doesn't typically delete CRR rows, but defensive
    let trig_ad = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__render_ad\" \
         AFTER DELETE ON \"{backing}\" BEGIN {body}; END",
        backing = backing_esc,
        body = render_body.replace("ROW_PK_PARAM", "OLD.row_pk")
    );
    db.exec_safe(&trig_ad)
        .map_err(|_| format!("failed to install AFTER DELETE trigger on {}", backing))?;

    Ok(())
}
