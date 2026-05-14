//! Runtime invariant monitor for Fugue backing tables.
//!
//! Compile-gated behind the `debug-monitor` Cargo feature. When enabled, the
//! extension can install a `sqlite3_preupdate_hook` callback that PANICS the
//! moment any backing-table row mutation violates these invariants:
//!
//!   1. Row immutability: an UPDATE on `__crsql_fugue_*` may only change the
//!      `tombstoned` column, and the change must be 0 → 1.
//!   2. Tombstone monotonicity: `tombstoned` 1 → 0 is forbidden.
//!   3. No partial INSERTs (NOT NULL columns must carry values — schema also
//!      enforces this; the monitor double-checks at runtime).
//!
//! The hook only inspects tables whose name begins with `__crsql_fugue_`, and
//! explicitly ignores `__crsql_fugue_active` (the helper counter table). All
//! other tables — including the parent CRR, its clock table, `crsql_*`
//! bookkeeping — are unobserved.
//!
//! ## Linkage
//!
//! `sqlite3_preupdate_hook` and friends are NOT in `sqlite3_api_routines` (the
//! loadable-extension dispatch table). They are exposed as ordinary C symbols
//! that the host SQLite binary exports IFF it was compiled with
//! `-DSQLITE_ENABLE_PREUPDATE_HOOK`.
//!
//! We resolve them dynamically with `dlsym(RTLD_DEFAULT, ...)` at the moment
//! `install_invariant_monitor` is called — never at dylib load. That makes the
//! extension itself load cleanly on any host: only `crsql_fugue_install_monitor`
//! fails if the host lacks preupdate, and it fails with a clear error rather
//! than a cryptic dlopen failure.

extern crate alloc;

use alloc::format;
use alloc::string::{String, ToString};
use core::ffi::{c_char, c_int, c_void, CStr};
use core::ptr::null_mut;
use core::sync::atomic::{AtomicPtr, Ordering};

use sqlite_nostd as sqlite;
use sqlite::{sqlite3, value, ColumnType, Value};

extern "C" {
    fn write(fd: c_int, buf: *const c_void, count: usize) -> isize;
}

/// Best-effort write to stderr. We're in no_std and the bundle's panic_handler
/// is just `abort()` — it drops the panic message on the floor. To give callers
/// (especially tests asserting on the violation message) something to grep
/// for, we manually flush the message to fd 2 just before invoking `panic!`.
fn eprint_raw(msg: &str) {
    unsafe {
        let _ = write(2, msg.as_ptr() as *const c_void, msg.len());
        let _ = write(2, b"\n".as_ptr() as *const c_void, 1);
    }
}

/// Build a violation message, ship it to stderr, then panic. The `panic!` itself
/// triggers the abort handler (so the process dies with a non-zero status) but
/// the stderr write makes the failure observable.
macro_rules! monitor_panic {
    ($($arg:tt)*) => {{
        let msg = ::alloc::format!($($arg)*);
        eprint_raw(&msg);
        panic!("{}", msg);
    }};
}

/// Backing-table column layout, matching `registration.rs`:
///   col 0: row_pk         INTEGER NOT NULL
///   col 1: itemId         TEXT NOT NULL
///   col 2: idx            INTEGER NOT NULL
///   col 3: content        TEXT (nullable)
///   col 4: parentItemId   TEXT (nullable)
///   col 5: parentIdx      INTEGER (nullable)
///   col 6: tombstoned     INTEGER NOT NULL DEFAULT 0
const COL_ROW_PK: c_int = 0;
const COL_ITEM_ID: c_int = 1;
const COL_IDX: c_int = 2;
const COL_CONTENT: c_int = 3;
const COL_PARENT_ITEM_ID: c_int = 4;
const COL_PARENT_IDX: c_int = 5;
const COL_TOMBSTONED: c_int = 6;
const EXPECTED_COL_COUNT: c_int = 7;

const SQLITE_INSERT: c_int = 18;
const SQLITE_DELETE: c_int = 9;
const SQLITE_UPDATE: c_int = 23;

// preupdate_hook callback signature, per sqlite3.h.
type XPreUpdate = unsafe extern "C" fn(
    p_ctx: *mut c_void,
    db: *mut sqlite3,
    op: c_int,
    z_db: *const c_char,
    z_name: *const c_char,
    i_key1: i64,
    i_key2: i64,
);

type FnPreupdateHook = unsafe extern "C" fn(
    db: *mut sqlite3,
    callback: Option<XPreUpdate>,
    p_arg: *mut c_void,
) -> *mut c_void;
type FnPreupdateOld = unsafe extern "C" fn(db: *mut sqlite3, col: c_int, out: *mut *mut value) -> c_int;
type FnPreupdateNew = unsafe extern "C" fn(db: *mut sqlite3, col: c_int, out: *mut *mut value) -> c_int;
type FnPreupdateCount = unsafe extern "C" fn(db: *mut sqlite3) -> c_int;

// libc/dlfcn FFI. We resolve sqlite3_preupdate_* symbols dynamically via
// dlsym(RTLD_DEFAULT, ...) at install time. This avoids unresolved-symbol
// errors at dylib load when hosts lack SQLITE_ENABLE_PREUPDATE_HOOK; the
// failure mode becomes a clean SQL error from `crsql_fugue_install_monitor()`
// instead of a cryptic dlopen failure.
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
// RTLD_DEFAULT differs across libc implementations.
#[cfg(target_os = "macos")]
const RTLD_DEFAULT: *mut c_void = (-2_isize) as *mut c_void;
#[cfg(not(target_os = "macos"))]
const RTLD_DEFAULT: *mut c_void = core::ptr::null_mut();

// Cached resolved function pointers (set on first install, reused thereafter).
// AtomicPtr gives us lock-free idempotent caching without dragging in a Mutex.
static PREUPDATE_HOOK: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static PREUPDATE_OLD: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static PREUPDATE_NEW: AtomicPtr<c_void> = AtomicPtr::new(null_mut());
static PREUPDATE_COUNT: AtomicPtr<c_void> = AtomicPtr::new(null_mut());

unsafe fn resolve(name: &str, slot: &AtomicPtr<c_void>) -> Result<*mut c_void, &'static str> {
    let cached = slot.load(Ordering::Acquire);
    if !cached.is_null() {
        return Ok(cached);
    }
    // name comes from a const literal we wrote, so building a CString is
    // cheap; but a stack buffer keeps us no-std friendly.
    let mut buf = [0u8; 64];
    let bytes = name.as_bytes();
    if bytes.len() + 1 > buf.len() {
        return Err("dlsym name too long");
    }
    buf[..bytes.len()].copy_from_slice(bytes);
    buf[bytes.len()] = 0;
    let p = dlsym(RTLD_DEFAULT, buf.as_ptr() as *const c_char);
    if p.is_null() {
        return Err(
            "host SQLite does not export sqlite3_preupdate_hook \
             — recompile host with -DSQLITE_ENABLE_PREUPDATE_HOOK",
        );
    }
    slot.store(p, Ordering::Release);
    Ok(p)
}

unsafe fn fp_preupdate_hook() -> Result<FnPreupdateHook, &'static str> {
    let p = resolve("sqlite3_preupdate_hook", &PREUPDATE_HOOK)?;
    Ok(core::mem::transmute(p))
}
unsafe fn fp_preupdate_old() -> Result<FnPreupdateOld, &'static str> {
    let p = resolve("sqlite3_preupdate_old", &PREUPDATE_OLD)?;
    Ok(core::mem::transmute(p))
}
unsafe fn fp_preupdate_new() -> Result<FnPreupdateNew, &'static str> {
    let p = resolve("sqlite3_preupdate_new", &PREUPDATE_NEW)?;
    Ok(core::mem::transmute(p))
}
unsafe fn fp_preupdate_count() -> Result<FnPreupdateCount, &'static str> {
    let p = resolve("sqlite3_preupdate_count", &PREUPDATE_COUNT)?;
    Ok(core::mem::transmute(p))
}

/// Install the invariant monitor on `db`. Idempotent — replaces any prior hook.
pub fn install_invariant_monitor(db: *mut sqlite3) -> Result<(), &'static str> {
    if db.is_null() {
        return Err("install_invariant_monitor: null db");
    }
    unsafe {
        let hook = fp_preupdate_hook()?;
        // Eagerly resolve the rest so that a misconfigured host fails fast
        // here, not deep inside an UPDATE's preupdate fire.
        fp_preupdate_old()?;
        fp_preupdate_new()?;
        fp_preupdate_count()?;

        hook(db, Some(preupdate_callback), null_mut());
    }
    Ok(())
}

/// Returns true if `table_name` is a Fugue backing table we want to observe.
///
/// The naming patterns we see in a live DB after `crsql_as_text_crdt`:
///   __crsql_fugue_<table>_<column>                ← the backing CRR (observe!)
///   __crsql_fugue_active                          ← suppression-counter helper (skip)
///   __crsql_fugue_<table>_<column>__crsql_clock   ← cr-sqlite clock for backing (skip)
///   __crsql_fugue_<table>_<column>__crsql_pks     ← cr-sqlite pk-lookup (skip)
///
/// cr-sqlite may add more __crsql_<suffix> auxiliaries on the backing table in
/// the future; we conservatively exclude anything that has `__crsql_` AFTER the
/// initial fugue prefix.
fn is_fugue_backing_table(table_name: &str) -> bool {
    let Some(rest) = table_name.strip_prefix("__crsql_fugue_") else {
        return false;
    };
    // The helper counter table shares the prefix but isn't a backing table.
    if rest == "active" {
        return false;
    }
    // cr-sqlite bookkeeping tables built on top of the backing CRR all carry
    // `__crsql_` somewhere after the fugue prefix (e.g. `_notes_body__crsql_clock`).
    if rest.contains("__crsql_") {
        return false;
    }
    true
}

unsafe fn cstr_to_str<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        return "";
    }
    match CStr::from_ptr(p).to_str() {
        Ok(s) => s,
        Err(_) => "<non-utf8>",
    }
}

unsafe fn value_to_display(v: *mut value) -> String {
    if v.is_null() {
        return "<null-ptr>".to_string();
    }
    match v.value_type() {
        ColumnType::Null => "NULL".to_string(),
        ColumnType::Integer => format!("{}", v.int64()),
        ColumnType::Float => format!("{}", v.double()),
        ColumnType::Text => {
            let s = v.text();
            format!("{:?}", s)
        }
        ColumnType::Blob => {
            let b = v.blob();
            format!("<blob {} bytes>", b.len())
        }
    }
}

/// Cheap value-equality across two sqlite3_value pointers. We compare by
/// (type, content) using the typed accessors. NULL == NULL.
unsafe fn values_equal(a: *mut value, b: *mut value) -> bool {
    if a.is_null() || b.is_null() {
        return a.is_null() && b.is_null();
    }
    let ta = a.value_type();
    let tb = b.value_type();
    if ta != tb {
        return false;
    }
    match ta {
        ColumnType::Null => true,
        ColumnType::Integer => a.int64() == b.int64(),
        ColumnType::Float => a.double() == b.double(),
        ColumnType::Text => a.text() == b.text(),
        ColumnType::Blob => a.blob() == b.blob(),
    }
}

unsafe fn fetch_old(db: *mut sqlite3, col: c_int) -> *mut value {
    let mut out: *mut value = null_mut();
    if let Ok(f) = fp_preupdate_old() {
        f(db, col, &mut out);
    }
    out
}

unsafe fn fetch_new(db: *mut sqlite3, col: c_int) -> *mut value {
    let mut out: *mut value = null_mut();
    if let Ok(f) = fp_preupdate_new() {
        f(db, col, &mut out);
    }
    out
}

unsafe fn fetch_count(db: *mut sqlite3) -> c_int {
    match fp_preupdate_count() {
        Ok(f) => f(db),
        Err(_) => -1,
    }
}

// SQLite calls this on every INSERT/UPDATE/DELETE against any real table. We
// short-circuit on table name so the cost on non-Fugue tables is one prefix
// check.
unsafe extern "C" fn preupdate_callback(
    _p_ctx: *mut c_void,
    db: *mut sqlite3,
    op: c_int,
    _z_db: *const c_char,
    z_name: *const c_char,
    _i_key1: i64,
    _i_key2: i64,
) {
    let table = cstr_to_str(z_name);
    if !is_fugue_backing_table(table) {
        return;
    }

    match op {
        SQLITE_INSERT => check_insert(db, table),
        SQLITE_UPDATE => check_update(db, table),
        SQLITE_DELETE => { /* deletes are always allowed (manual cleanup, sync apply) */ }
        _ => {}
    }
}

unsafe fn check_insert(db: *mut sqlite3, table: &str) {
    let count = fetch_count(db);
    if count != EXPECTED_COL_COUNT {
        monitor_panic!(
            "[debug-monitor] INSERT on {}: preupdate_count = {}, expected {} \
             (schema drift?)",
            table,
            count,
            EXPECTED_COL_COUNT
        );
    }

    let row_pk = fetch_new(db, COL_ROW_PK);
    let item_id = fetch_new(db, COL_ITEM_ID);
    let idx = fetch_new(db, COL_IDX);
    let tombstoned = fetch_new(db, COL_TOMBSTONED);

    // NOT NULL columns must carry a non-NULL value.
    let null_cols: &[(c_int, &str, *mut value)] = &[
        (COL_ROW_PK, "row_pk", row_pk),
        (COL_ITEM_ID, "itemId", item_id),
        (COL_IDX, "idx", idx),
        (COL_TOMBSTONED, "tombstoned", tombstoned),
    ];
    for (_col_idx, name, v) in null_cols {
        if v.is_null() || v.value_type() == ColumnType::Null {
            monitor_panic!(
                "[debug-monitor] INSERT on {}: NOT NULL column `{}` is NULL \
                 (invariant 3: no partial inserts)",
                table,
                name
            );
        }
    }
}

unsafe fn check_update(db: *mut sqlite3, table: &str) {
    let count = fetch_count(db);
    if count != EXPECTED_COL_COUNT {
        monitor_panic!(
            "[debug-monitor] UPDATE on {}: preupdate_count = {}, expected {} \
             (schema drift?)",
            table,
            count,
            EXPECTED_COL_COUNT
        );
    }

    // Check every column other than `tombstoned`. If any of them differ between
    // OLD and NEW, that's a row-immutability violation.
    let immutable_cols: &[(c_int, &str)] = &[
        (COL_ROW_PK, "row_pk"),
        (COL_ITEM_ID, "itemId"),
        (COL_IDX, "idx"),
        (COL_CONTENT, "content"),
        (COL_PARENT_ITEM_ID, "parentItemId"),
        (COL_PARENT_IDX, "parentIdx"),
    ];
    for (col, name) in immutable_cols {
        let old_v = fetch_old(db, *col);
        let new_v = fetch_new(db, *col);
        if !values_equal(old_v, new_v) {
            let row_pk_v = fetch_old(db, COL_ROW_PK);
            let item_id_v = fetch_old(db, COL_ITEM_ID);
            let idx_v = fetch_old(db, COL_IDX);
            monitor_panic!(
                "[debug-monitor] UPDATE on {} violates row immutability:\n\
                 \trow (row_pk={}, itemId={}, idx={})\n\
                 \tcolumn `{}` changed: OLD={} -> NEW={}\n\
                 \tinvariant 1: only `tombstoned` may change on a backing-table UPDATE.",
                table,
                value_to_display(row_pk_v),
                value_to_display(item_id_v),
                value_to_display(idx_v),
                name,
                value_to_display(old_v),
                value_to_display(new_v),
            );
        }
    }

    // Now check the tombstone transition (the only legal mutation).
    let old_t = fetch_old(db, COL_TOMBSTONED);
    let new_t = fetch_new(db, COL_TOMBSTONED);
    let old_v = if old_t.is_null() { -1 } else { old_t.int() };
    let new_v = if new_t.is_null() { -1 } else { new_t.int() };

    // No-op tombstone write (0->0 or 1->1) is permitted (idempotent).
    if old_v == new_v {
        return;
    }
    // 0->1 is the only legal flip.
    if old_v == 0 && new_v == 1 {
        return;
    }

    let row_pk_v = fetch_old(db, COL_ROW_PK);
    let item_id_v = fetch_old(db, COL_ITEM_ID);
    let idx_v = fetch_old(db, COL_IDX);
    monitor_panic!(
        "[debug-monitor] UPDATE on {} violates tombstone monotonicity:\n\
         \trow (row_pk={}, itemId={}, idx={})\n\
         \ttombstoned: {} -> {}\n\
         \tinvariant 2: `tombstoned` may only flip 0 -> 1 (never 1 -> 0, and \
         non-boolean values are disallowed).",
        table,
        value_to_display(row_pk_v),
        value_to_display(item_id_v),
        value_to_display(idx_v),
        old_v,
        new_v,
    );
}

/// SQL UDF `crsql_fugue_install_monitor()`: tests/dev sites can opt in
/// dynamically without rebuilding the extension.
pub extern "C" fn install_monitor_udf(
    ctx: *mut sqlite::context,
    _argc: i32,
    _argv: *mut *mut sqlite::value,
) {
    use sqlite::Context;
    let db = ctx.db_handle();
    if let Err(msg) = install_invariant_monitor(db) {
        ctx.result_error(msg);
        return;
    }
    ctx.result_int(1);
}
