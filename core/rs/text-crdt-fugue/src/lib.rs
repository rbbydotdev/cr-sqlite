#![cfg_attr(not(test), no_std)]
#![allow(non_upper_case_globals)]
#![feature(core_intrinsics)]

extern crate alloc;

mod cleanup;
mod deletion;
mod insertion;
mod registration;
mod render;
mod util;

use core::ffi::{c_char, c_int};
use sqlite::Connection;
use sqlite::ResultCode;
use sqlite_nostd as sqlite;

pub extern "C" fn crsql_as_text_crdt(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    registration::as_text_crdt(ctx, argc, argv);
}

pub extern "C" fn crsql_fugue_insert(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    insertion::fugue_insert(ctx, argc, argv);
}

pub extern "C" fn crsql_fugue_delete(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    deletion::fugue_delete(ctx, argc, argv);
}

pub extern "C" fn crsql_fugue_render(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    render::fugue_render(ctx, argc, argv);
}

pub extern "C" fn crsql_fugue_cleanup(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    cleanup::fugue_cleanup(ctx, argc, argv);
}

pub extern "C" fn crsql_fugue_flush(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    render::fugue_flush(ctx, argc, argv);
}

#[no_mangle]
pub extern "C" fn sqlite3_crsqltextcrdtfugue_init(
    db: *mut sqlite::sqlite3,
    _err_msg: *mut *mut c_char,
    api: *mut sqlite::api_routines,
) -> c_int {
    sqlite::EXTENSION_INIT2(api);

    if let Err(rc) = db.create_function_v2(
        "crsql_fugue_insert",
        5,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_fugue_insert),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_fugue_delete",
        5,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_fugue_delete),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_fugue_render",
        3,
        sqlite::UTF8 | sqlite::DETERMINISTIC | sqlite::INNOCUOUS,
        None,
        Some(crsql_fugue_render),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_fugue_cleanup",
        3,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_fugue_cleanup),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_fugue_flush",
        3,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_fugue_flush),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    // Allow 2-or-3-arg crsql_as_text_crdt (eager flag optional)
    if let Err(rc) = db.create_function_v2(
        "crsql_as_text_crdt",
        -1,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_as_text_crdt),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    ResultCode::OK as c_int
}
