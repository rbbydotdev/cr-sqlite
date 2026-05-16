#![cfg_attr(not(test), no_std)]
#![allow(non_upper_case_globals)]
#![feature(core_intrinsics)]

extern crate alloc;

mod mark_op;
mod registration;
mod render;
mod util;
mod walker;

use core::ffi::{c_char, c_int};
use sqlite::Connection;
use sqlite::ResultCode;
use sqlite_nostd as sqlite;

pub extern "C" fn crsql_as_peritext(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    registration::as_peritext(ctx, argc, argv);
}

pub extern "C" fn crsql_peritext_mark(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    mark_op::peritext_mark(ctx, argc, argv);
}

pub extern "C" fn crsql_peritext_unmark(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    mark_op::peritext_unmark(ctx, argc, argv);
}

pub extern "C" fn crsql_peritext_render(
    ctx: *mut sqlite::context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    render::peritext_render(ctx, argc, argv);
}

#[no_mangle]
pub extern "C" fn sqlite3_crsqlperitextmarks_init(
    db: *mut sqlite::sqlite3,
    _err_msg: *mut *mut c_char,
    api: *mut sqlite::api_routines,
) -> c_int {
    sqlite::EXTENSION_INIT2(api);

    // `crsql_as_peritext` — registration. -1 = variadic (accepts 2 or 3 args).
    if let Err(rc) = db.create_function_v2(
        "crsql_as_peritext",
        -1,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_as_peritext),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_peritext_mark",
        11,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_peritext_mark),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    if let Err(rc) = db.create_function_v2(
        "crsql_peritext_unmark",
        10,
        sqlite::UTF8 | sqlite::DIRECTONLY,
        None,
        Some(crsql_peritext_unmark),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    // INNOCUOUS so the render trigger can call it under trusted_schema=OFF.
    // NOT DETERMINISTIC — the function reads mutable rows; marking it
    // deterministic would let SQLite cache results inside trigger
    // expressions and surface stale renders. Mirrors crsql_fugue_render.
    if let Err(rc) = db.create_function_v2(
        "crsql_peritext_render",
        3,
        sqlite::UTF8 | sqlite::INNOCUOUS,
        None,
        Some(crsql_peritext_render),
        None,
        None,
        None,
    ) {
        return rc as c_int;
    }

    ResultCode::OK as c_int
}
