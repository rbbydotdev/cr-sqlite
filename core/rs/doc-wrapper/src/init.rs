//! `crsql_doc_init()` — idempotent setup for the document schema.
//!
//! Creates the `blocks` table, promotes its `body` column to Peritext
//! (which also brings in text-CRDT-fugue under the hood), registers the
//! tree CRDT under name "doc", and seeds the two sentinel rows (root +
//! trash) that pin the doc's structural anchor points.
//!
//! All operations use IF NOT EXISTS / INSERT OR IGNORE so re-calling on
//! a primed connection is a no-op. Demo frontends just call this once
//! after opening their DB; no need to manage schema themselves.

extern crate alloc;
use alloc::format;
use alloc::string::String;
use sqlite::{args, context, sqlite3, Connection, Context};
use sqlite_nostd as sqlite;

pub fn doc_init(ctx: *mut context, _argc: i32, _argv: *mut *mut sqlite::value) {
    let _ = args!(_argc, _argv);
    let db = ctx.db_handle();
    if let Err(msg) = setup(db) {
        ctx.result_error(&msg);
    }
}

fn setup(db: *mut sqlite3) -> Result<(), String> {
    // 1. blocks table — id BLOB PRIMARY KEY NOT NULL is needed for cr-sqlite's CRR rules
    db.exec_safe(
        "CREATE TABLE IF NOT EXISTS blocks (\
            id    BLOB PRIMARY KEY NOT NULL,\
            kind  TEXT NOT NULL DEFAULT '',\
            attrs TEXT,\
            body  TEXT\
         )",
    )
    .map_err(|_| String::from("create blocks table"))?;

    // 2. Promote to CRR. Idempotent inside crsql_as_crr's own implementation.
    db.exec_safe("SELECT crsql_as_crr('blocks')")
        .map_err(|_| String::from("crsql_as_crr('blocks')"))?;

    // 3. Promote body column to Peritext. This pulls in text-CRDT-fugue
    //    + marks table + the no-fast-path opt-out. Declare `comment` as
    //    additive (paper §3.2.2): overlapping comments coexist as separate
    //    highlights rather than LWW-collapsing.
    db.exec_safe("SELECT crsql_as_peritext('blocks', 'body', '[\"comment\"]')")
        .map_err(|_| String::from("crsql_as_peritext('blocks','body')"))?;

    // 4. Register the doc-level tree CRDT.
    db.exec_safe("SELECT crsql_create_tree('doc')")
        .map_err(|_| String::from("crsql_create_tree('doc')"))?;

    // 5. Seed sentinels. Both peers using the same well-known IDs means
    //    concurrent INSERTs converge cleanly via cr-sqlite per-column LWW.
    let seed = format!(
        "INSERT OR IGNORE INTO blocks (id, kind) VALUES \
             (X'{}', 'document'), (X'{}', 'trash')",
        crate::util::ROOT_HEX,
        crate::util::TRASH_HEX,
    );
    db.exec_safe(&seed)
        .map_err(|_| String::from("seed root/trash sentinels"))?;

    Ok(())
}
