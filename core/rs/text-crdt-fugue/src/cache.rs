//! Per-connection insertion cache.
//!
//! The append fast path: for the common IDE pattern of sequential typing
//! ("press a key, end up with one more char at the end"), we'd otherwise
//! do an O(N) load + walk of the entire backing table on every keystroke,
//! giving O(N²) for N keystrokes. The cache turns this into O(1) per
//! keystroke for the append path.
//!
//! What's cached, per `(backing_table_name, row_pk)`:
//!   * `view_length`: total visible char count after the last UDF call
//!   * `tail_item_id`, `tail_original_idx`: identity of the LAST visible
//!     char (the row that owns it + its abs-idx in that row's idx space).
//!     A new append attaches to this point as its parent.
//!   * `backing_version`: snapshot of the per-(backing, row_pk) version
//!     counter at the moment the cache was built. The counter is bumped
//!     by triggers on every backing-table mutation, so any external
//!     write (sync apply, manual SQL, etc.) invalidates the cache.
//!
//! Lookup protocol in fugue_insert:
//!   1. Get cache entry for `(backing, row_pk)`. Read current version.
//!   2. If entry exists AND entry.version == current AND pos == view_length:
//!      ─→ append fast path: new node's parent is `tail`.
//!      ─→ no full backing-row load, no visible_chars walk.
//!   3. Else: fall through to the slow path (current code). Update cache.
//!
//! Lifetime: the cache pointer is allocated in `sqlite3_crsqltextcrdtfugue_init`
//! and passed as user_data to the UDFs that need it. It lives as long as
//! the connection. We Box::leak it — no destructor wiring yet; a small
//! per-connection allocation is acceptable for dev. Wire a destructor in
//! before production deployment.
//!
//! Thread safety: SQLite serialises UDF calls per-connection by default
//! (SQLITE_CONFIG_SERIALIZED). Within a connection, calls are sequential,
//! so `RefCell` is sufficient. Cross-connection use is fine because each
//! connection allocates its own cache and the pointer doesn't escape.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::string::String;
use core::cell::RefCell;
use core::ffi::c_void;

use sqlite_nostd as sqlite;
use sqlite::{sqlite3, Connection, ResultCode};

/// Single-marker cache entry: where the last successful insert landed.
///
/// `tail_item_id` / `tail_original_idx` identify the visible char at view
/// position `cursor_view_position` — the LAST char of whatever was just
/// inserted. The next call hits the fast path if it targets the position
/// immediately after this marker (i.e. `position == cursor_view_position + 1`).
///
/// Field names are kept from the previous tail-only version to minimise
/// surface change; the semantic shift is just "tail of doc" → "wherever the
/// cursor ended up after the last write." Sequential typing at the end of
/// the doc still works (the cursor IS the tail in that case); sequential
/// typing mid-doc now also works (the cursor sits mid-doc, the fast path
/// kicks in on the next keystroke at cursor+1).
#[derive(Clone, Debug)]
pub(crate) struct AppendCacheEntry {
    pub(crate) backing_version: i64,
    pub(crate) tail_item_id: String,
    pub(crate) tail_original_idx: i32,
    /// View position (0-indexed) of the char at (tail_item_id, tail_original_idx).
    /// The fast path matches when `position == cursor_view_position + 1`.
    pub(crate) cursor_view_position: i32,
    /// Total visible char count in the doc. Lets the fast path distinguish
    /// "cursor at tail" (use `body || ?` — O(1) amortised) from "cursor mid-
    /// content" (use `substr(body, 1, n) || ? || substr(body, n+1)` — O(N)
    /// but stays in SQLite). Tail concat keeps sequential typing at the end
    /// truly amortised constant.
    pub(crate) view_length: i32,
}

/// Per-connection cache. Keyed by (backing_table_name, row_pk).
pub(crate) struct ConnCache {
    inner: RefCell<BTreeMap<(String, i64), AppendCacheEntry>>,
}

impl ConnCache {
    fn new() -> Self {
        ConnCache {
            inner: RefCell::new(BTreeMap::new()),
        }
    }

    pub(crate) fn get(&self, backing: &str, row_pk: i64) -> Option<AppendCacheEntry> {
        self.inner.borrow().get(&(String::from(backing), row_pk)).cloned()
    }

    pub(crate) fn set(&self, backing: &str, row_pk: i64, entry: AppendCacheEntry) {
        self.inner
            .borrow_mut()
            .insert((String::from(backing), row_pk), entry);
    }

    pub(crate) fn invalidate(&self, backing: &str, row_pk: i64) {
        self.inner
            .borrow_mut()
            .remove(&(String::from(backing), row_pk));
    }
}

/// Allocate a fresh ConnCache and return an opaque pointer. Caller is
/// responsible for either passing it as user_data to UDFs (which keeps it
/// alive) or freeing via `drop_conn_cache`.
pub(crate) fn make_conn_cache() -> *mut c_void {
    let boxed: alloc::boxed::Box<ConnCache> = alloc::boxed::Box::new(ConnCache::new());
    alloc::boxed::Box::into_raw(boxed) as *mut c_void
}

/// Resolve a user_data pointer back to a borrowed cache reference. Returns
/// None if the pointer is null (no cache wired) so callers can fall through
/// to the slow path safely.
pub(crate) unsafe fn cache_from_user_data<'a>(p: *mut c_void) -> Option<&'a ConnCache> {
    if p.is_null() {
        return None;
    }
    Some(&*(p as *const ConnCache))
}

/// Read the version counter for a (backing, row_pk) pair. Returns 0 if no
/// row exists yet (i.e. nothing has ever been written through the version
/// triggers). The counter is bumped by INSERT/UPDATE/DELETE triggers
/// installed by `install_version_triggers`.
pub(crate) fn read_version(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
) -> Result<i64, ResultCode> {
    let stmt = db.prepare_v2(
        "SELECT version FROM __crsql_fugue_versions WHERE backing = ? AND row_pk = ?",
    )?;
    stmt.bind_text(1, backing, sqlite::Destructor::TRANSIENT)?;
    stmt.bind_int64(2, row_pk)?;
    if stmt.step()? == ResultCode::ROW {
        Ok(stmt.column_int64(0))
    } else {
        Ok(0)
    }
}

/// Rebuild the cache entry for `(backing, row_pk)` after a slow-path insert
/// landed at view position `target_view_pos`. We walk visible chars once
/// (O(N), one allocation), index to find the just-inserted char, and store
/// it as the cursor marker. Sequential typing at that position now hits the
/// fast path on every subsequent call.
///
/// `target_view_pos == None` means "use the doc tail" — used by paths that
/// don't know where they wrote (or are confident the cursor IS at the tail).
pub(crate) fn refresh_from_db(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
    cache: &ConnCache,
    target_view_pos: Option<i32>,
) -> Result<(), String> {
    use crate::deletion;
    let nodes = deletion::load_nodes_pub(db, backing, row_pk)
        .map_err(|_| String::from("cache refresh: load_nodes"))?;
    let visible = deletion::visible_chars(&nodes);
    if visible.is_empty() {
        cache.invalidate(backing, row_pk);
        return Ok(());
    }
    let count = visible.len();
    let target_idx = match target_view_pos {
        Some(p) if p >= 0 && (p as usize) < count => p as usize,
        _ => count - 1, // default to tail
    };
    let marker = &visible[target_idx];
    let version = read_version(db, backing, row_pk)
        .map_err(|_| String::from("cache refresh: read_version"))?;
    cache.set(
        backing,
        row_pk,
        AppendCacheEntry {
            backing_version: version,
            tail_item_id: marker.item_id.clone(),
            tail_original_idx: marker.original_idx,
            cursor_view_position: target_idx as i32,
            view_length: count as i32,
        },
    );
    Ok(())
}
