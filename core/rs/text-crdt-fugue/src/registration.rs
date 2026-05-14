extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// SQL function `crsql_as_text_crdt(table, column [, eager])`:
///
///   1. validate parent `table` is a CRR (has `{table}__crsql_clock`)
///   2. validate `column` exists on parent
///   3. CREATE backing table `__crsql_fugue_{table}_{column}` (Weidner schema, WITHOUT ROWID)
///   4. mark backing as CRR via `crsql_as_crr`
///   5. if `eager` (default 0): no triggers — `fugue_insert/delete/cleanup` each render the
///      parent column once at end of their function (defer mode, fewer renders per call).
///      if `eager=1`: install AFTER INSERT/UPDATE/DELETE per-row render triggers that
///      materialize the parent column on every backing-row mutation (more renders, useful
///      when sync-apply paths bypass our fugue_* functions and you want body kept fresh
///      without calling `crsql_fugue_flush(...)`).
///
/// Idempotent — uses `IF NOT EXISTS` everywhere. Calling twice on the same pair is a no-op.
pub fn as_text_crdt(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() < 2 || arg_slice.len() > 3 {
        ctx.result_error("crsql_as_text_crdt requires 2 or 3 args: (table, column [, eager])");
        return;
    }

    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let eager = if arg_slice.len() == 3 {
        arg_slice[2].int() != 0
    } else {
        false
    };
    let db = ctx.db_handle();

    if let Err(msg) = register(db, table, column, eager) {
        ctx.result_error(&msg);
    }
}

fn register(db: *mut sqlite3, table: &str, column: &str, eager: bool) -> Result<(), String> {
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

    // 5. render strategy (transparent mode by default):
    //    Default → AFTER INSERT/UPDATE/DELETE triggers WITH `WHEN active_counter=0` clause.
    //      Sync-apply paths (cr-sqlite writing remote changes through crsql_changes):
    //        counter=0 → trigger fires → parent column auto-renders. No client work.
    //      Local fugue_*  paths (insertion/deletion/cleanup):
    //        function brackets its work with counter++/--. During its writes counter≥1
    //        so the per-row trigger fires-but-skips. At end-of-function the explicit
    //        rerender_parent_column call renders once. N-row writes → 1 render.
    //    eager=1 (opt-in legacy): triggers installed WITHOUT the WHEN clause, so they
    //      ALWAYS fire (no suppression). Slower for multi-row fugue calls (N triggers
    //      + 1 explicit rerender), kept for callers who explicitly want eager-everywhere
    //      semantics or for diagnostic comparison.
    //    Note: commit-hook batching (one render per row_pk per tx instead of one
    //    per fugue call) was considered and rejected — it would reintroduce mid-tx
    //    stale reads, which transparent mode just fixed. Not pursuing.
    ensure_active_counter_table(db)?;
    install_render_trigger(db, &backing, table, column, eager)?;
    install_split_trigger(db, &backing, table, column)?;

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
    eager: bool,
) -> Result<(), String> {
    let backing_esc = escape_ident(backing);
    let parent_esc = escape_ident(parent_table);
    let col_esc = escape_ident(parent_column);

    // Simple exact-idx tree walk. Correctness depends on the apply-time
    // splitter restoring the `child.parentIdx = parent.idx` invariant — see
    // `apply_split.rs`. With that invariant, a child always references a
    // parent's terminal idx, so the recursive join is sufficient.
    let render_body = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = (\
            WITH RECURSIVE under_node(content, level, itemId, idx, tombstoned) AS (\
                VALUES ('', 0, '', -2, 0) \
                UNION ALL \
                SELECT f.content, under_node.level + 1, f.itemId, f.idx, f.tombstoned \
                FROM \"{backing}\" f \
                JOIN under_node ON f.parentItemId = under_node.itemId AND f.parentIdx = under_node.idx \
                WHERE f.row_pk = ROW_PK_PARAM \
                ORDER BY 2 DESC, f.itemId, f.idx \
            ) \
            SELECT IFNULL(group_concat(content, ''), '') FROM under_node \
            WHERE idx != -1 AND tombstoned = 0 \
        ) \
        WHERE rowid = ROW_PK_PARAM",
        parent = parent_esc,
        col = col_esc,
        backing = backing_esc
    );

    // Transparent mode (default): WHEN suppression clause skips the render while a
    // fugue_* function is executing (counter>0). Sync-apply paths leave counter=0,
    // so the trigger renders normally — no client responsibility for flushing.
    //
    // Eager mode (opt-in via 3rd arg): no WHEN clause, trigger always fires. Useful
    // when callers want every backing-row mutation to render unconditionally.
    let when_clause = if eager {
        String::new()
    } else {
        String::from(" WHEN (SELECT counter FROM __crsql_fugue_active WHERE id=1) = 0")
    };

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

/// Apply-time split triggers — see `apply_split.rs` for the rationale.
///
/// We watch for the moment a backing row has both `parentItemId` and `parentIdx`
/// set (cr-sqlite delivers cells one at a time on sync-apply, so the row only
/// becomes "linkable" after both have arrived). Each trigger fires the splitter
/// UDF, which is idempotent — repeated calls for the same row are O(1) lookups
/// once the parent has already been split.
///
/// Gated by `__crsql_fugue_active.counter = 0` so:
///   - Local fugue_* paths (which manipulate the backing table inside an active
///     bracket) don't re-enter the splitter — they handle mid-run split locally
///     via the existing `insertion.rs` Path-A logic.
///   - The splitter's own writes (a shorten + an insert) don't recurse into
///     itself; the splitter wraps its mutations in `with_active`.
fn install_split_trigger(
    db: *mut sqlite3,
    backing: &str,
    parent_table: &str,
    parent_column: &str,
) -> Result<(), String> {
    let backing_esc = escape_ident(backing);
    let parent_esc = escape_ident(parent_table);
    let col_esc = escape_ident(parent_column);

    // Pure-SQL split — no UDF call. Calling a UDF from a trigger that fires
    // during cr-sqlite's apply path errors with SQL_LOGIC_ERROR (the merge
    // vtable holds an outer cursor on the backing table and a UDF opening its
    // own prepare_v2 statement collides). Inlining the split as SQL DML
    // statements inside the trigger body works because the existing render
    // trigger already does this pattern with its recursive CTE.
    //
    // The body shape:
    //   1. Bump __crsql_fugue_active.counter so render + split triggers see
    //      counter>0 and skip during our own writes (otherwise the new row's
    //      AFTER INSERT would fire the split trigger again).
    //   2. INSERT a LEFT-HALF row (same itemId, new idx=NEW.parentIdx) by
    //      copying the parent's grandparent linkage. The condition restricts
    //      to a parent whose stored idx is strictly greater than NEW.parentIdx
    //      AND whose run actually covers NEW.parentIdx (i.e.
    //      idx - length(content) + 1 <= NEW.parentIdx).
    //   3. UPDATE the existing parent row to its RIGHT half (drop the left
    //      portion from content). The original idx stays — children pinned
    //      at the original idx are unaffected.
    //   4. Restore the counter.
    //
    // Idempotency: after a successful split the parent row's first-char idx
    // shifts past NEW.parentIdx, so the WHERE clauses no longer match. Repeat
    // invocations no-op.
    //
    // The substr math: position-in-content of NEW.parentIdx is
    // `NEW.parentIdx - first_idx + 1` where `first_idx = idx - length(content) + 1`.
    // That simplifies to `NEW.parentIdx - idx + length(content)`, which is the
    // length of the LEFT half.
    // The NOT EXISTS guard avoids a PK conflict in the concurrent-split case:
    // peer A's local split produced (itemId=X, idx=2) "Hey" and peer B's local
    // split produced (itemId=X, idx=3) "Hey ". On sync, both rows exist on the
    // target. When a child arrives with parentIdx=2, our splitter would try
    // shrinking the idx=3 row to idx=2 — but the idx=2 row already exists, and
    // it's already a valid parent for parentIdx=2. So we skip the split when
    // a row at the exact target (itemId, parentIdx) is already present.
    //
    // The cleanup pass in insertion.rs is responsible for deduplicating the
    // overlapping rows once both are visible; we just need to not crash here.
    // Body is statement-sequence, no inter-statement guarding needed because
    // the trigger's WHEN clause has already verified:
    //   (1) a splittable parent run exists (idx > parentIdx, run covers parentIdx)
    //   (2) no row at (itemId, parentIdx) already exists
    //
    // After the split, we inline an explicit render UPDATE to refresh the
    // materialized parent column. The normal render trigger DID fire earlier
    // (when cr-sqlite UPDATEd the child's parentIdx) but ran BEFORE the split,
    // so its output reflected the pre-split tree and missed the child. The
    // splitter's own backing-table writes happen with counter>0, suppressing
    // the render trigger from re-running on them. So we render here, with the
    // counter restored to 0 first, using the same CTE as the trigger body.
    let render_sql = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = (\
            WITH RECURSIVE under_node(content, level, itemId, idx, tombstoned) AS (\
                VALUES ('', 0, '', -2, 0) \
                UNION ALL \
                SELECT f.content, under_node.level + 1, f.itemId, f.idx, f.tombstoned \
                FROM \"{backing}\" f \
                JOIN under_node ON f.parentItemId = under_node.itemId AND f.parentIdx = under_node.idx \
                WHERE f.row_pk = NEW.row_pk \
                ORDER BY 2 DESC, f.itemId, f.idx \
            ) \
            SELECT IFNULL(group_concat(content, ''), '') FROM under_node \
            WHERE idx != -1 AND tombstoned = 0 \
        ) WHERE rowid = NEW.row_pk",
        parent = parent_esc,
        col = col_esc,
        backing = backing_esc,
    );

    let split_body = format!(
        "UPDATE __crsql_fugue_active SET counter = counter + 1 WHERE id = 1; \
         INSERT INTO \"{backing}\" (row_pk, itemId, idx, content, parentItemId, parentIdx, tombstoned) \
           SELECT row_pk, itemId, NEW.parentIdx, \
                  substr(content, 1, NEW.parentIdx - idx + length(content)), \
                  parentItemId, parentIdx, tombstoned \
             FROM \"{backing}\" \
             WHERE row_pk = NEW.row_pk \
               AND itemId = NEW.parentItemId \
               AND idx > NEW.parentIdx \
               AND (idx - length(content) + 1) <= NEW.parentIdx; \
         UPDATE \"{backing}\" \
           SET content = substr(content, NEW.parentIdx - idx + length(content) + 1) \
           WHERE row_pk = NEW.row_pk \
             AND itemId = NEW.parentItemId \
             AND idx > NEW.parentIdx \
             AND (idx - length(content) + 1) <= NEW.parentIdx; \
         UPDATE __crsql_fugue_active SET counter = counter - 1 WHERE id = 1; \
         {render}",
        backing = backing_esc,
        render = render_sql,
    );

    let when_clause = format!(
        " WHEN NEW.idx != -1 \
            AND NEW.parentItemId IS NOT NULL AND NEW.parentItemId != '' \
            AND NEW.parentIdx IS NOT NULL AND NEW.parentIdx >= 0 \
            AND (SELECT counter FROM __crsql_fugue_active WHERE id=1) = 0 \
            AND NOT EXISTS ( \
              SELECT 1 FROM \"{backing}\" \
               WHERE row_pk = NEW.row_pk AND itemId = NEW.parentItemId AND idx = NEW.parentIdx \
            ) \
            AND EXISTS ( \
              SELECT 1 FROM \"{backing}\" \
               WHERE row_pk = NEW.row_pk AND itemId = NEW.parentItemId \
                 AND idx > NEW.parentIdx \
                 AND (idx - length(content) + 1) <= NEW.parentIdx \
            )",
        backing = backing_esc,
    );
    let when_clause = when_clause.as_str();

    // AFTER INSERT — catches the case where parentItemId/parentIdx are present
    // in the very first cell write (rare but possible).
    let trig_split_ai = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__split_ai\" \
         AFTER INSERT ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = when_clause,
        body = split_body,
    );
    db.exec_safe(&trig_split_ai)
        .map_err(|_| format!("failed to install split AFTER INSERT trigger on {}", backing))?;

    // AFTER UPDATE OF parentIdx / parentItemId — catches the common case where
    // cr-sqlite's per-cell apply sets these one at a time.
    let trig_split_au_pidx = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__split_au_pidx\" \
         AFTER UPDATE OF parentIdx ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = when_clause,
        body = split_body,
    );
    db.exec_safe(&trig_split_au_pidx)
        .map_err(|_| format!("failed to install split AFTER UPDATE-parentIdx trigger on {}", backing))?;

    let trig_split_au_pitem = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__split_au_pitem\" \
         AFTER UPDATE OF parentItemId ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = when_clause,
        body = split_body,
    );
    db.exec_safe(&trig_split_au_pitem)
        .map_err(|_| format!("failed to install split AFTER UPDATE-parentItemId trigger on {}", backing))?;

    // Orphan-resolution triggers: fire from the PARENT row's perspective. When
    // a row arrives (or its content changes) and any local child has parentIdx
    // that falls inside the row's run, split the row at the SMALLEST such
    // parentIdx. Subsequent orphans (if any) are resolved by recursive trigger
    // fires: the body UPDATE-touches the (possibly shortened) row to retrigger.
    //
    // Why this case exists: when peer A locally Case-1-extends a run (idx
    // bumps from 11 to 29), cr-sqlite ships the change as a row replacement
    // (DELETE old idx=11 + INSERT new idx=29). On peer B, the local child at
    // parentIdx=11 is suddenly orphaned because its parent row was replaced.
    // The child-side trigger (split_au_*) doesn't help here — the child wasn't
    // touched, only the parent was. This parent-side trigger catches it.
    // Order matters: UPDATE NEW's row to its right-half content FIRST, then
    // INSERT the left-half row. If we INSERTed first, the new row at the
    // orphan parentIdx would cause the UPDATE's `NOT EXISTS` orphan check to
    // return false and the UPDATE would skip — leaving the original (full)
    // content in place. By UPDATEing first we still have NEW.content as the
    // table column value, and NEW.* refers to the trigger-time snapshot of the
    // pre-statement row so length(NEW.content) reflects the original full
    // length in both substrings.
    let orphan_body = format!(
        "UPDATE __crsql_fugue_active SET counter = counter + 1 WHERE id = 1; \
         UPDATE \"{backing}\" \
           SET content = substr(NEW.content, ( \
                 SELECT MIN(child.parentIdx) FROM \"{backing}\" child \
                  WHERE child.row_pk = NEW.row_pk \
                    AND child.parentItemId = NEW.itemId \
                    AND child.parentIdx >= (NEW.idx - length(NEW.content) + 1) \
                    AND child.parentIdx < NEW.idx \
                    AND NOT EXISTS ( \
                      SELECT 1 FROM \"{backing}\" p2 \
                       WHERE p2.row_pk = NEW.row_pk AND p2.itemId = NEW.itemId AND p2.idx = child.parentIdx \
                    ) \
               ) - NEW.idx + length(NEW.content) + 1) \
           WHERE row_pk = NEW.row_pk AND itemId = NEW.itemId AND idx = NEW.idx; \
         INSERT INTO \"{backing}\" (row_pk, itemId, idx, content, parentItemId, parentIdx, tombstoned) \
           SELECT NEW.row_pk, NEW.itemId, child.parentIdx, \
                  substr(NEW.content, 1, child.parentIdx - NEW.idx + length(NEW.content)), \
                  NEW.parentItemId, NEW.parentIdx, NEW.tombstoned \
             FROM \"{backing}\" child \
             WHERE child.row_pk = NEW.row_pk \
               AND child.parentItemId = NEW.itemId \
               AND child.parentIdx >= (NEW.idx - length(NEW.content) + 1) \
               AND child.parentIdx < NEW.idx \
               AND NOT EXISTS ( \
                 SELECT 1 FROM \"{backing}\" p2 \
                  WHERE p2.row_pk = NEW.row_pk AND p2.itemId = NEW.itemId AND p2.idx = child.parentIdx \
               ) \
             ORDER BY child.parentIdx ASC LIMIT 1; \
         UPDATE __crsql_fugue_active SET counter = counter - 1 WHERE id = 1; \
         {render}",
        backing = backing_esc,
        render = render_sql,
    );

    let orphan_when = format!(
        " WHEN NEW.idx != -1 \
            AND NEW.content IS NOT NULL AND length(NEW.content) > 0 \
            AND (SELECT counter FROM __crsql_fugue_active WHERE id=1) = 0 \
            AND EXISTS ( \
              SELECT 1 FROM \"{backing}\" child \
               WHERE child.row_pk = NEW.row_pk \
                 AND child.parentItemId = NEW.itemId \
                 AND child.parentIdx >= (NEW.idx - length(NEW.content) + 1) \
                 AND child.parentIdx < NEW.idx \
                 AND NOT EXISTS ( \
                   SELECT 1 FROM \"{backing}\" p2 \
                    WHERE p2.row_pk = NEW.row_pk AND p2.itemId = NEW.itemId AND p2.idx = child.parentIdx \
                 ) \
            )",
        backing = backing_esc,
    );

    let trig_orphan_ai = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__split_orphan_ai\" \
         AFTER INSERT ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = orphan_when,
        body = orphan_body,
    );
    db.exec_safe(&trig_orphan_ai)
        .map_err(|_| format!("failed to install orphan AFTER INSERT trigger on {}", backing))?;

    let trig_orphan_au = format!(
        "CREATE TRIGGER IF NOT EXISTS \"{backing}__split_orphan_au_content\" \
         AFTER UPDATE OF content ON \"{backing}\"{when} BEGIN {body}; END",
        backing = backing_esc,
        when = orphan_when,
        body = orphan_body,
    );
    db.exec_safe(&trig_orphan_au)
        .map_err(|_| format!("failed to install orphan AFTER UPDATE-content trigger on {}", backing))?;

    Ok(())
}
