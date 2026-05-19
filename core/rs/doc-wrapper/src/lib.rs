#![cfg_attr(not(test), no_std)]
#![allow(non_upper_case_globals)]
#![feature(core_intrinsics)]

extern crate alloc;

mod apply;
mod init;
mod render;
mod sync;
mod util;

use core::ffi::{c_char, c_int};
use sqlite::Connection;
use sqlite::ResultCode;
use sqlite_nostd as sqlite;

pub extern "C" fn crsql_doc_init(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    init::doc_init(ctx, argc, argv);
}

pub extern "C" fn crsql_doc_apply(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    apply::doc_apply(ctx, argc, argv);
}

pub extern "C" fn crsql_doc_render(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    render::doc_render(ctx, argc, argv);
}

pub extern "C" fn crsql_doc_pull(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    sync::doc_pull(ctx, argc, argv);
}

pub extern "C" fn crsql_doc_push(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    sync::doc_push(ctx, argc, argv);
}

#[no_mangle]
pub extern "C" fn sqlite3_crsqldocwrapper_init(
    db: *mut sqlite::sqlite3,
    _err_msg: *mut *mut c_char,
    api: *mut sqlite::api_routines,
) -> c_int {
    sqlite::EXTENSION_INIT2(api);

    if let Err(rc) = db.create_function_v2(
        "crsql_doc_init", 0, sqlite::UTF8 | sqlite::DIRECTONLY,
        None, Some(crsql_doc_init), None, None, None,
    ) { return rc as c_int; }

    if let Err(rc) = db.create_function_v2(
        "crsql_doc_apply", 1, sqlite::UTF8 | sqlite::DIRECTONLY,
        None, Some(crsql_doc_apply), None, None, None,
    ) { return rc as c_int; }

    if let Err(rc) = db.create_function_v2(
        "crsql_doc_render", 0, sqlite::UTF8 | sqlite::DIRECTONLY,
        None, Some(crsql_doc_render), None, None, None,
    ) { return rc as c_int; }

    if let Err(rc) = db.create_function_v2(
        "crsql_doc_pull", 1, sqlite::UTF8 | sqlite::DIRECTONLY,
        None, Some(crsql_doc_pull), None, None, None,
    ) { return rc as c_int; }

    if let Err(rc) = db.create_function_v2(
        "crsql_doc_push", 1, sqlite::UTF8 | sqlite::DIRECTONLY,
        None, Some(crsql_doc_push), None, None, None,
    ) { return rc as c_int; }

    ResultCode::OK as c_int
}
