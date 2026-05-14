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

#[derive(Clone, Debug)]
pub(crate) struct AppendCacheEntry {
    pub(crate) backing_version: i64,
    pub(crate) tail_item_id: String,
    pub(crate) tail_original_idx: i32,
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

/// Rebuild the cache entry for `(backing, row_pk)` from the current
/// visible-chars walk. Called after slow-path inserts/deletes to leave the
/// cache populated so the *next* append can use the fast path. Total cost
/// is one extra O(N) walk, on top of the slow path's own O(N) work — so
/// slow-path-followed-by-N-fast-path-appends is O(N) instead of O(N²).
pub(crate) fn refresh_from_db(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
    cache: &ConnCache,
) -> Result<(), String> {
    use crate::deletion;
    let nodes = deletion::load_nodes_pub(db, backing, row_pk)
        .map_err(|_| String::from("cache refresh: load_nodes"))?;
    let summary = deletion::visible_summary(&nodes);
    let Some((tail_id, tail_idx, count)) = summary else {
        cache.invalidate(backing, row_pk);
        return Ok(());
    };
    let version = read_version(db, backing, row_pk)
        .map_err(|_| String::from("cache refresh: read_version"))?;
    cache.set(
        backing,
        row_pk,
        AppendCacheEntry {
            backing_version: version,
            tail_item_id: tail_id,
            tail_original_idx: tail_idx,
            view_length: count as i32,
        },
    );
    Ok(())
}
