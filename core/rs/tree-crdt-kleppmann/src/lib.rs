#![cfg_attr(not(test), no_std)]
#![allow(non_upper_case_globals)]
#![feature(core_intrinsics)]

extern crate alloc;

mod apply;
mod move_op;
mod registration;
mod util;
mod value;

use core::ffi::{c_char, c_int};
use sqlite::Connection;
use sqlite::ResultCode;
use sqlite_nostd as sqlite;

pub extern "C" fn crsql_create_tree(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    registration::create_tree(ctx, argc, argv);
}

pub extern "C" fn crsql_tree_move(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    move_op::tree_move(ctx, argc, argv);
}

pub extern "C" fn crsql_tree_apply(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    apply::tree_apply(ctx, argc, argv);
}

#[no_mangle]
pub extern "C" fn sqlite3_crsqltreecrdtkleppmann_init(
    db: *mut sqlite::sqlite3,
    _err_msg: *mut *mut c_char,
    api: *mut sqlite::api_routines,
) -> c_int {
    sqlite::EXTENSION_INIT2(api);

    if let Err(rc) = db.create_function_v2(
        "crsql_create_tree",
        1,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_create_tree),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_tree_move",
        6,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_tree_move),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    // INNOCUOUS so the AFTER INSERT trigger on the ops table can call it
    // under `trusted_schema=OFF`. Mirrors the text-CRDT render UDF's flag
    // choice — UDFs invoked from triggers need INNOCUOUS rather than
    // DIRECTONLY; the function still mutates DB state but only through
    // tables we own (`__tree_state` and `__tree_log`).
    if let Err(rc) = db.create_function_v2(
        "crsql_tree_apply",
        3,
        sqlite::UTF8 | sqlite::INNOCUOUS,
        None,
        Some(crsql_tree_apply),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    ResultCode::OK as c_int
}
