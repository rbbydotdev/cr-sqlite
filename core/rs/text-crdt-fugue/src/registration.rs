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
///   5. install AFTER INSERT/UPDATE/DELETE render triggers on the backing table
///      so the materialized parent column stays in lockstep with the Fugue
///      tree. Triggers are gated by an active-counter so local `fugue_insert/
///      delete/cleanup` paths do their multi-row writes silently and emit a
///      single explicit render at end-of-function. Sync-apply paths (cells
///      arriving via `crsql_changes`) execute with the counter at zero, so
///      triggers fire per-cell; clients must wrap apply in a SQL transaction
///      so the per-cell intermediate `body` writes are uncommitted until the
///      final correct render lands.
///
/// **Client contract:** wrap sync-apply (`INSERT INTO crsql_changes ...`) in a
/// transaction. Per-cell trigger fires during apply are uncommitted within the
/// transaction; external connections see only the final committed state.
/// Without a wrapping transaction, observers may see brief intermediate body
/// values during the cr-sqlite per-cell apply sequence.
///
/// Idempotent — uses `IF NOT EXISTS` everywhere. Calling twice on the same pair is a no-op.
pub fn as_text_crdt(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    // Accept 2 args; for compatibility with earlier scripts that passed a 3rd
    // `eager` flag we silently accept (and ignore) a third arg. The old eager
    // mode was a vestigial option: under β-flat it produced identical body
    // outputs to the default mode, just with duplicate trigger fires. Removed
    // for a smaller API surface.
    if arg_slice.len() < 2 || arg_slice.len() > 3 {
        ctx.result_error("crsql_as_text_crdt requires 2 args: (table, column)");
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

    // #!~ Parent must have a single INTEGER PRIMARY KEY (aliased to rowid). Compound
    // PKs or TEXT PKs require row_pk to be a different shape (e.g. BLOB encoding the
    // tuple). We don't enforce this here; the render trigger silently noops on
    // mismatched parents so misuse is observable as "body never updates."

    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);

    // 3. create backing table — Weidner schema (renaming "index" → "idx" to avoid the SQL keyword)
    //    WITHOUT ROWID per the perf-principles section of the plan.
    // `tombstoned` is a dedicated boolean cell for delete-vs-edit race resistance.
    // Deletion sets tombstoned=1 (content preserved for cleanup overlap math).
    // cr-sqlite syncs the cell via LWW; 0→1 monotonic, 1>0 under ValueWin tie-break →
    // any peer's tombstone wins over any peer's concurrent content edit.
    let create_table = format!(
        "CREATE TABLE IF NOT EXISTS \"{backing}\" (\
            row_pk INTEGER NOT NULL,\
            itemId TEXT NOT NULL,\
            idx INTEGER NOT NULL,\
            content TEXT,\
            parentItemId TEXT,\
            parentIdx INTEGER,\
            tombstoned INTEGER NOT NULL DEFAULT 0,\
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

    // 5. render strategy:
    //    AFTER INSERT/UPDATE/DELETE triggers WITH `WHEN active_counter=0` clause.
    //      Sync-apply paths (cr-sqlite writing remote changes through crsql_changes):
    //        counter=0 → trigger fires → parent column auto-renders. No client work.
    //      Local fugue_*  paths (insertion/deletion/cleanup):
    //        function brackets its work with counter++/--. During its writes counter≥1
    //        so the per-row trigger fires-but-skips. At end-of-function the explicit
    //        rerender_parent_column call renders once. N-row writes → 1 render.
    ensure_active_counter_table(db)?;
    // recursive_triggers stays ON so the render trigger's RECURSIVE CTE walks
    // its own re-fire safely under the counter-guarded WHEN clause.
    db.exec_safe("PRAGMA recursive_triggers = ON")
        .map_err(|_| String::from("failed to enable recursive_triggers"))?;
    install_render_trigger(db, &backing, table, column)?;
    // #!~ Cleanup-on-apply (concurrent-split overlap trim) is the missing
    // piece for fuzz convergence. A pure-SQL trim trigger was prototyped but
    // proved too aggressive for delete+insert scenarios — needs more careful
    // gating and likely a commit-hook approach. Until then, sync-apply leaves
    // overlapping rows that the existing `crsql_fugue_cleanup` UDF resolves
    // when called from local fugue_insert/delete paths.

    // 6. UNTRACK the parent column at the cr-sqlite layer.
    //    notes.body is a materialized view of the Fugue backing rows. cr-sqlite's
    //    per-cell LWW would otherwise ship the body value to peers, where it can
    //    win over the receiving peer's freshly-rendered body (e.g. when site_id or
    //    lexicographic value tiebreaks go the wrong way under concurrent edits).
    //    Block body from `{parent}__crsql_clock` so it never enters the change log.
    //    Each peer's body stays as a purely local materialized view of its own
    //    backing rows — which converge across peers via Fugue, not via LWW on body.
    install_clock_untrack(db, table, column)?;

    Ok(())
}

/// Prevent the parent column from being tracked in `{parent_table}__crsql_clock`.
/// Removes any existing clock entries for the column and installs a BEFORE INSERT
/// trigger that ignores future inserts. Body changes propagate via the backing
/// table (which IS a CRR); the materialized parent column is purely local.
fn install_clock_untrack(
    db: *mut sqlite3,
    parent_table: &str,
    parent_column: &str,
) -> Result<(), String> {
    let clock = format!("{}__crsql_clock", parent_table);
    let clock_esc = escape_ident(&clock);
    let col_lit = parent_column.replace('\'', "''");

    // Purge any existing tracked entries from before crsql_as_text_crdt was called.
    let purge = format!(
        "DELETE FROM \"{}\" WHERE col_name = '{}'",
        clock_esc, col_lit
    );
    db.exec_safe(&purge)
        .map_err(|_| format!("failed to purge clock entries for {}", parent_column))?;

    // Block future tracking inserts via BEFORE INSERT + RAISE(IGNORE).
    let trig_name = format!("__crsql_fugue_untrack_{}_{}", parent_table, parent_column);
    let sql = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{trig}\" \
         BEFORE INSERT ON \"{clock}\" \
         FOR EACH ROW WHEN NEW.col_name = '{col}' BEGIN \
            SELECT RAISE(IGNORE); \
         END",
        trig = escape_ident(&trig_name),
        clock = clock_esc,
        col = col_lit
    );
    db.exec_safe(&sql)
        .map_err(|_| format!("failed to install untrack trigger on {}", clock))?;
    Ok(())
}

/// Idempotent: creates the suppression-counter helper used by transparent-mode triggers.
/// One row, `counter` defaults to 0. fugue_* functions bump it during their work.
///
/// Stored as a regular (non-temp) table because SQLite triggers on regular tables
/// cannot reference temp tables in their WHEN clauses. The cost is one extra table in
/// the schema; the row is never synced (not a CRR).
fn ensure_active_counter_table(db: *mut sqlite3) -> Result<(), String> {
    db.exec_safe(
        "CREATE TABLE IF NOT EXISTS __crsql_fugue_active (\
            id INTEGER PRIMARY KEY CHECK (id = 1),\
            counter INTEGER NOT NULL DEFAULT 0\
        );\
        INSERT OR IGNORE INTO __crsql_fugue_active (id, counter) VALUES (1, 0);",
    )
    .map_err(|_| String::from("failed to create __crsql_fugue_active"))?;
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

    // Call the `crsql_fugue_render` UDF (the β-flat Rust walker) instead of
    // inlining a SQL recursive CTE. The walker handles mid-content children
    // correctly; the old CTE could only join on exact-idx parent equality and
    // silently dropped any child whose parentIdx pointed inside a multi-char
    // parent. Routing the trigger through the UDF means the same code path
    // serves explicit `SELECT crsql_fugue_render(...)` and the materialized
    // body column.
    let _ = backing_esc;
    let render_body = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = crsql_fugue_render('{ptab}', '{pcol}', ROW_PK_PARAM) \
         WHERE rowid = ROW_PK_PARAM",
        parent = parent_esc,
        col = col_esc,
        ptab = parent_table.replace('\'', "''"),
        pcol = parent_column.replace('\'', "''"),
    );

    // WHEN suppression clause skips the render while a fugue_* function is
    // executing (counter>0). Sync-apply paths leave counter=0, so the trigger
    // renders normally — no client responsibility for flushing.
    let when_clause =
        String::from(" WHEN (SELECT counter FROM __crsql_fugue_active WHERE id=1) = 0");

    let trig_ai = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__render_ai\" \
         AFTER INSERT ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = when_clause,
        body = render_body.replace("ROW_PK_PARAM", "NEW.row_pk")
    );
    db.exec_safe(&trig_ai)
        .map_err(|_| format!("failed to install AFTER INSERT trigger on {}", backing))?;

    let trig_au = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__render_au\" \
         AFTER UPDATE ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = when_clause,
        body = render_body.replace("ROW_PK_PARAM", "NEW.row_pk")
    );
    db.exec_safe(&trig_au)
        .map_err(|_| format!("failed to install AFTER UPDATE trigger on {}", backing))?;

    let trig_ad = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__render_ad\" \
         AFTER DELETE ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = when_clause,
        body = render_body.replace("ROW_PK_PARAM", "OLD.row_pk")
    );
    db.exec_safe(&trig_ad)
        .map_err(|_| format!("failed to install AFTER DELETE trigger on {}", backing))?;

    Ok(())
}
