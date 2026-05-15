//! Per-connection insertion cache (N-marker LRU).
//!
//! Each connection holds a bounded set of "search markers" per
//! (backing_table, row_pk) doc: pointers to specific (view_position,
//! item_id, original_idx) triples in the Fugue tree. When `fugue_insert`
//! is called with a target position, we scan the marker set for one whose
//! `view_position + 1 == target_position` — if found, the new node attaches
//! to that marker as its parent (Fugue Case-2 style) without walking the
//! tree. After the write, the hit marker advances to the new last-inserted
//! char so the NEXT call at that position also fast-paths.
//!
//! This is the design Yjs converged on (`ArraySearchMarker`, ~80 entries).
//! We use ~16 for less per-call shift overhead and because larger marker
//! counts don't help in practice for typical editing patterns.
//!
//! What's tracked per doc:
//!   * `view_length`: total visible char count
//!   * `backing_version`: snapshot of the per-(backing, row_pk) version
//!     counter from the version triggers
//!   * `markers`: bounded `Vec<Marker>` (≤ MAX_MARKERS)
//!   * `tick`: monotonic counter used for LRU eviction
//!
//! Fast-path protocol:
//!   1. Read `current_version`. If `current_version != cache.backing_version`,
//!      drop the doc entry entirely (external write happened — markers are
//!      stale) and fall through to slow path.
//!   2. Scan markers for one with `view_position == target - 1`. If found,
//!      use it as the parent for the new node.
//!   3. After the write: advance the hit marker's view_position by len(text),
//!      its identity to the new char; shift all OTHER markers at
//!      view_position > hit_pos by +len(text); update view_length and
//!      backing_version.
//!
//! Slow-path protocol:
//!   1. Run the full visible-chars walk via `perform_insert`.
//!   2. Call `refresh_from_db_keeping_markers`: shift existing markers for
//!      the insert; add a new marker at the just-inserted position. Evict
//!      LRU if over MAX_MARKERS.
//!
//! Invalidation: any backing-version mismatch ⇒ drop ALL markers for that
//! doc. Yjs does the same on remote transactions — adjusting marker
//! positions across an unknown batch of remote ops is too error-prone.
//!
//! Lifetime: cache pointer allocated in extension init, leaked, passed as
//! user_data to UDFs. Lives as long as the connection. SQLite serialises
//! per-connection so `RefCell` is enough for interior mutability.

extern crate alloc;

use alloc::boxed::Box;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use core::cell::RefCell;
use core::ffi::c_void;

use sqlite_nostd as sqlite;
use sqlite::{sqlite3, Connection, ResultCode};

/// Upper bound on markers per doc. Yjs uses 80; we use 16 to keep the
/// per-insert shift work small (we walk all markers on each insert) while
/// still covering the realistic "user has 2-3 active edit regions"
/// scenario. Tune up if profiling shows the LRU is thrashing.
const MAX_MARKERS: usize = 16;

#[derive(Clone, Debug)]
pub(crate) struct Marker {
    pub(crate) view_position: i32,
    pub(crate) item_id: String,
    pub(crate) original_idx: i32,
    pub(crate) last_used: u64,
}

#[derive(Clone, Debug)]
pub(crate) struct DocCache {
    pub(crate) backing_version: i64,
    pub(crate) view_length: i32,
    pub(crate) markers: Vec<Marker>,
    pub(crate) tick: u64,
}

impl DocCache {
    fn new(version: i64, view_length: i32) -> Self {
        DocCache {
            backing_version: version,
            view_length,
            markers: Vec::with_capacity(MAX_MARKERS),
            tick: 0,
        }
    }

    /// If any marker has `view_position == target_pos - 1`, return its
    /// `(item_id, original_idx, hit_view_position)` clone and bump its
    /// `last_used` so it survives subsequent LRU eviction.
    ///
    /// Returns `(item_id, original_idx, hit_view_position)` so the caller
    /// has everything needed to do the SQL insert without holding a
    /// borrow into the cache (avoids borrow-checker entanglement with the
    /// follow-up `apply_fast_path_hit`).
    pub(crate) fn try_fast_path(&mut self, target_pos: i32) -> Option<(String, i32, i32)> {
        self.tick += 1;
        let tick = self.tick;
        for m in self.markers.iter_mut() {
            if m.view_position == target_pos - 1 {
                m.last_used = tick;
                return Some((m.item_id.clone(), m.original_idx, m.view_position));
            }
        }
        None
    }

    /// Apply a successful fast-path insert:
    ///   * the hit marker advances by `text_len` and now points at the
    ///     new last-inserted char (`new_item_id`, `new_original_idx`).
    ///   * any OTHER marker at `view_position > hit_pos` shifts by
    ///     `+text_len` (chars to its left were inserted).
    ///   * `view_length` grows by `text_len`; `backing_version` snapshot
    ///     updates so the next call's version-check succeeds.
    pub(crate) fn apply_fast_path_hit(
        &mut self,
        hit_pos: i32,
        new_item_id: String,
        new_original_idx: i32,
        text_len: i32,
        new_version: i64,
    ) {
        self.tick += 1;
        let tick = self.tick;
        for m in self.markers.iter_mut() {
            if m.view_position == hit_pos {
                m.view_position = hit_pos + text_len;
                m.item_id = new_item_id.clone();
                m.original_idx = new_original_idx;
                m.last_used = tick;
            } else if m.view_position > hit_pos {
                m.view_position += text_len;
            }
        }
        self.view_length += text_len;
        self.backing_version = new_version;
    }

    /// Apply a successful slow-path insert. We didn't hit any marker, but
    /// we DID land at `insert_pos` with `text_len` chars. Shift any
    /// markers at `view_position >= insert_pos` by `+text_len`, then add a
    /// new marker at `insert_pos + text_len - 1` (the last inserted char).
    /// Evict the LRU marker if over MAX_MARKERS.
    pub(crate) fn apply_slow_path_insert(
        &mut self,
        insert_pos: i32,
        text_len: i32,
        new_item_id: String,
        new_original_idx: i32,
        new_view_length: i32,
        new_version: i64,
    ) {
        // Shift existing markers that sit at or past the insert position.
        for m in self.markers.iter_mut() {
            if m.view_position >= insert_pos {
                m.view_position += text_len;
            }
        }
        self.tick += 1;
        let tick = self.tick;
        // Add a marker at the just-inserted char's position so subsequent
        // sequential typing here fast-paths.
        let new_marker = Marker {
            view_position: insert_pos + text_len - 1,
            item_id: new_item_id,
            original_idx: new_original_idx,
            last_used: tick,
        };
        self.markers.push(new_marker);
        // LRU eviction. Sort by last_used descending so most-recent stays
        // first, then truncate. Small N (≤16) so the sort is cheap.
        if self.markers.len() > MAX_MARKERS {
            self.markers.sort_by(|a, b| b.last_used.cmp(&a.last_used));
            self.markers.truncate(MAX_MARKERS);
        }
        self.view_length = new_view_length;
        self.backing_version = new_version;
    }
}

/// Per-connection cache. Keyed by (backing_table_name, row_pk).
pub(crate) struct ConnCache {
    inner: RefCell<BTreeMap<(String, Vec<u8>), DocCache>>,
}

impl ConnCache {
    fn new() -> Self {
        ConnCache {
            inner: RefCell::new(BTreeMap::new()),
        }
    }

    pub(crate) fn get_doc(&self, backing: &str, row_pk: &[u8]) -> Option<DocCache> {
        self.inner
            .borrow()
            .get(&(String::from(backing), row_pk.to_vec()))
            .cloned()
    }

    pub(crate) fn set_doc(&self, backing: &str, row_pk: &[u8], doc: DocCache) {
        self.inner
            .borrow_mut()
            .insert((String::from(backing), row_pk.to_vec()), doc);
    }

    /// Atomically mutate the doc cache. Allows fast-path updates without
    /// the get/modify/set race.
    pub(crate) fn with_doc<F, R>(&self, backing: &str, row_pk: &[u8], f: F) -> Option<R>
    where
        F: FnOnce(&mut DocCache) -> R,
    {
        let mut inner = self.inner.borrow_mut();
        inner
            .get_mut(&(String::from(backing), row_pk.to_vec()))
            .map(|doc| f(doc))
    }

    pub(crate) fn invalidate(&self, backing: &str, row_pk: &[u8]) {
        self.inner
            .borrow_mut()
            .remove(&(String::from(backing), row_pk.to_vec()));
    }
}

/// Allocate a fresh ConnCache and return an opaque pointer. The pointer is
/// passed as `user_data` to UDF registrations and lives for the
/// connection's lifetime (we leak the Box).
pub(crate) fn make_conn_cache() -> *mut c_void {
    let boxed: Box<ConnCache> = Box::new(ConnCache::new());
    Box::into_raw(boxed) as *mut c_void
}

/// Resolve a user_data pointer back to a borrowed cache reference. Returns
/// `None` if the pointer is null so callers can fall through to the slow
/// path safely.
pub(crate) unsafe fn cache_from_user_data<'a>(p: *mut c_void) -> Option<&'a ConnCache> {
    if p.is_null() {
        return None;
    }
    Some(&*(p as *const ConnCache))
}

/// Read the per-(backing, row_pk) version counter bumped by triggers on
/// every backing-table mutation. Returns 0 if no row exists yet (doc has
/// never been written through the triggers).
pub(crate) fn read_version(
    db: *mut sqlite3,
    backing: &str,
    row_pk: &[u8],
) -> Result<i64, ResultCode> {
    let stmt = db.prepare_v2(
        "SELECT version FROM __crsql_fugue_versions WHERE backing = ? AND row_pk = ?",
    )?;
    stmt.bind_text(1, backing, sqlite::Destructor::TRANSIENT)?;
    crate::row_pk::bind(&stmt, 2, row_pk).map_err(|_| ResultCode::ERROR)?;
    if stmt.step()? == ResultCode::ROW {
        Ok(stmt.column_int64(0))
    } else {
        Ok(0)
    }
}

/// Refresh the doc cache after a slow-path insert. If a cache entry
/// already exists (i.e. version-still-matching for this caller), we
/// preserve its markers and just shift / append for the new insert. If
/// the cache was empty or version-mismatched, we build a fresh entry with
/// a single marker at the insert position.
///
/// The visible_chars walk is O(N) regardless — it's needed to find the
/// new char's (item_id, original_idx) by position. That's the one
/// unavoidable cost of slow path.
pub(crate) fn refresh_after_slow_path(
    db: *mut sqlite3,
    backing: &str,
    row_pk: &[u8],
    cache: &ConnCache,
    insert_pos: i32,
    text_len: i32,
) -> Result<(), String> {
    use crate::deletion;
    let nodes = deletion::load_nodes_pub(db, backing, row_pk)
        .map_err(|_| String::from("cache refresh: load_nodes"))?;
    let visible = deletion::visible_chars(&nodes);
    if visible.is_empty() {
        cache.invalidate(backing, row_pk);
        return Ok(());
    }
    let count = visible.len() as i32;
    // The new char's view position is `insert_pos + text_len - 1`. If
    // perform_insert did something unexpected (Case-3 sentinel rerouting
    // the actual position), `insert_pos` may not be the exact landing
    // spot — but it's our best-effort. The version + marker scan
    // protects us: if a follow-up call doesn't match, slow path runs
    // again and the cache catches up.
    let target_pos = (insert_pos + text_len - 1).clamp(0, count - 1);
    let new_marker_char = &visible[target_pos as usize];
    let new_version = read_version(db, backing, row_pk)
        .map_err(|_| String::from("cache refresh: read_version"))?;

    let mut doc = cache
        .get_doc(backing, row_pk)
        .unwrap_or_else(|| DocCache::new(new_version, count));
    doc.apply_slow_path_insert(
        insert_pos,
        text_len,
        new_marker_char.item_id.clone(),
        new_marker_char.original_idx,
        count,
        new_version,
    );
    cache.set_doc(backing, row_pk, doc);
    Ok(())
}
