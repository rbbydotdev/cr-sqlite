//! Sync RPCs — hide the `crsql_changes` table schema from callers.
//!
//!   `crsql_doc_pull(site_id_hex) → TEXT`
//!       JSON blob containing all changes not originated by the given
//!       site. Empty/NULL arg means "everything."
//!
//!   `crsql_doc_push(blob)`
//!       Apply changes from the blob into this db's `crsql_changes`.
//!
//! Callers treat the blob as opaque and shuttle it verbatim. Each row
//! is encoded as a JSON array preserving SQLite's `val` type via a
//! `[type_name, value]` tuple — blobs hex-encoded, everything else
//! carried as a JSON primitive so the parser recreates exact types on
//! push.

extern crate alloc;
use alloc::string::String;
use sqlite::{args, context, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

pub fn doc_pull(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 1 {
        ctx.result_error("crsql_doc_pull requires 1 arg: (exclude_site_hex)");
        return;
    }
    let exclude_hex = arg_slice[0].text();
    let db = ctx.db_handle();

    let sql = "\
        SELECT COALESCE(json_group_array(json_array( \
            \"table\", \
            lower(hex(pk)), \
            cid, \
            json_array(typeof(val), \
                CASE typeof(val) \
                    WHEN 'blob' THEN lower(hex(val)) \
                    ELSE val \
                END), \
            col_version, \
            db_version, \
            lower(hex(site_id)), \
            cl, \
            seq \
        )), '[]') \
        FROM crsql_changes \
        WHERE ?1 IS NULL OR ?1 = '' OR site_id IS NOT unhex(?1)";
    let stmt = match db.prepare_v2(sql) {
        Ok(s) => s,
        Err(_) => { ctx.result_error("prepare doc_pull"); return; }
    };
    if stmt.bind_text(1, exclude_hex, Destructor::TRANSIENT).is_err() {
        ctx.result_error("bind exclude_hex");
        return;
    }
    match stmt.step() {
        Ok(ResultCode::ROW) => ctx.result_text_transient(stmt.column_text(0).unwrap_or("[]")),
        _                   => ctx.result_text_transient("[]"),
    }
}

pub fn doc_push(ctx: *mut context, argc: i32, argv: *mut *mut sqlite::value) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 1 {
        ctx.result_error("crsql_doc_push requires 1 arg: (blob)");
        return;
    }
    let blob = arg_slice[0].text();
    // Empty / "[]" / NULL means "no changes to apply" — skip the
    // INSERT entirely (json_each would error on a non-JSON arg).
    if blob.is_empty() || blob == "[]" { return; }
    let db = ctx.db_handle();

    let sql = "\
        INSERT INTO crsql_changes ( \
            \"table\",\"pk\",\"cid\",\"val\",\"col_version\",\"db_version\",site_id,cl,seq \
        ) \
        SELECT \
            json_extract(r.value, '$[0]'), \
            unhex(json_extract(r.value, '$[1]')), \
            json_extract(r.value, '$[2]'), \
            CASE json_extract(r.value, '$[3][0]') \
                WHEN 'blob' THEN unhex(json_extract(r.value, '$[3][1]')) \
                WHEN 'null' THEN NULL \
                ELSE json_extract(r.value, '$[3][1]') \
            END, \
            json_extract(r.value, '$[4]'), \
            json_extract(r.value, '$[5]'), \
            unhex(json_extract(r.value, '$[6]')), \
            json_extract(r.value, '$[7]'), \
            json_extract(r.value, '$[8]') \
        FROM json_each(?1) AS r";
    let stmt = match db.prepare_v2(sql) {
        Ok(s) => s,
        Err(_) => { ctx.result_error("prepare doc_push"); return; }
    };
    if stmt.bind_text(1, blob, Destructor::TRANSIENT).is_err() {
        ctx.result_error("bind blob");
        return;
    }
    if stmt.step().is_err() {
        ctx.result_error("step doc_push");
    }
}

#[allow(dead_code)]
fn _keep_use() -> String { String::new() }
