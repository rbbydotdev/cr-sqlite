// Each insert loads the row_pk's backing rows and walks the tree linearly.
// Typing workloads grow row count linearly (one row per keystroke); the
// 1000-random-position-insert pathological case is the only place where the
// O(n) load + walk shows up, and benchmarks against the alternatives (slim
// load filtered by tombstoned=0) showed no win at current scales.
extern crate alloc;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// SQL function `crsql_fugue_insert(table, col, row_pk, position, text)`:
///
/// Inserts `text` into the Fugue tree for `(table.col, row_pk)` at rendered character
/// offset `position`. Translates into one or more INSERTs on the backing table.
///
/// Returns the number of backing rows written (informational).
///
/// Case selection (mirrors Weidner's spec, issue #65):
///   Case 2: new child of the left neighbor (no children block)
///   Case 3: sentinel under right's parent (left has children)
pub fn fugue_insert(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 5 {
        ctx.result_error(
            "crsql_fugue_insert requires 5 args: (table, column, row_pk, position, text)",
        );
        return;
    }

    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = arg_slice[2].int64();
    let position = arg_slice[3].int();
    let text = arg_slice[4].text();
    let db = ctx.db_handle();

    if text.is_empty() {
        ctx.result_int(0);
        return;
    }

    let backing = backing_table_name(table, column);
    let user_data = ctx.user_data();

    // Track whether the fast path was taken so we can skip the O(N) end-of-
    // function rerender. The fast path itself updates `body` incrementally
    // (append-only string concat), turning the per-call cost from O(N) to
    // O(1) amortised — without which the cache wouldn't actually translate
    // to linear total time.
    let mut fast_path_taken = false;

    let result = crate::active::with_active(db, || {
        if let Some(cache) = unsafe { crate::cache::cache_from_user_data(user_data) } {
            if let Some(entry) = cache.get(&backing, row_pk) {
                let current_version = crate::cache::read_version(db, &backing, row_pk)
                    .map_err(|_| String::from("cache: read_version"))?;
                // Fast path: the caller is inserting at the position
                // *immediately after* our cached cursor marker. Covers both
                // append-at-tail (cursor IS the tail) and sequential typing
                // mid-content (cursor sits wherever the user typed last).
                if current_version == entry.backing_version
                    && position == entry.cursor_view_position + 1
                {
                    let n = perform_append_fast_path(
                        db, table, column, &backing, row_pk, text, &entry, cache,
                    )?;
                    fast_path_taken = true;
                    return Ok(n);
                }
            }
        }

        // Slow path. After it finishes, refresh the cache with the cursor
        // pointing at the *last inserted char* (view position
        // position + len(text) - 1) so subsequent sequential typing at that
        // spot hits the fast path.
        let n = perform_insert(db, table, column, row_pk, position, text)?;
        if let Some(cache) = unsafe { crate::cache::cache_from_user_data(user_data) } {
            let target_view_pos = position + (text.chars().count() as i32) - 1;
            crate::cache::refresh_from_db(
                db,
                &backing,
                row_pk,
                cache,
                Some(target_view_pos),
            )?;
        }
        Ok(n)
    });
    match result {
        Ok(n) => {
            // Fast path already updated `body` incrementally — skip the full
            // rerender to keep per-op cost O(1). Slow path takes the
            // canonical render path for correctness.
            if !fast_path_taken {
                if let Err(msg) =
                    crate::render::rerender_parent_column(db, table, column, row_pk)
                {
                    ctx.result_error(&msg);
                    return;
                }
            }
            ctx.result_int(n as i32);
        }
        Err(msg) => ctx.result_error(&msg),
    }
}

/// Structural fast path. The cache's cursor marker tells us where the
/// previous insert landed; the caller has already verified `position ==
/// cursor_view_position + 1` AND the backing-version snapshot matches.
/// We attach the new node directly to the cursor (O(1) write — no tree
/// walk) and update the materialised parent column via a SQL string
/// operation:
///
/// - **Tail case** (`cursor_view_position == view_length - 1`, i.e.
///   appending at the doc's end): `body = body || ?`. Amortised O(1).
/// - **Mid-content case** (cursor sits inside the doc): `body =
///   substr(body, 1, position) || ? || substr(body, position+1)`. O(N) in
///   the body length but stays inside SQLite — no Rust render walk.
///
/// Both paths land at the correct final body; the split is just an
/// optimisation for the common typing-at-tail case.
fn perform_append_fast_path(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    backing: &str,
    row_pk: i64,
    text: &str,
    entry: &crate::cache::AppendCacheEntry,
    cache: &crate::cache::ConnCache,
) -> Result<usize, String> {
    let new_item_id = fresh_item_id(db).map_err(|_| String::from("fast: fresh_item_id"))?;
    let new_text_len = text.chars().count() as i32;
    let new_idx = new_text_len - 1;
    let insert_pos = entry.cursor_view_position + 1;
    let at_tail = insert_pos == entry.view_length;

    insert_node(
        db,
        backing,
        row_pk,
        &new_item_id,
        new_idx,
        Some(text),
        &entry.tail_item_id,
        entry.tail_original_idx,
        /*or_ignore=*/ false,
    )
    .map_err(|_| String::from("fast: insert_node"))?;

    let parent_esc = crate::util::escape_ident(table);
    let col_esc = crate::util::escape_ident(column);

    if at_tail {
        // O(1) amortised concat at the end.
        let append_sql = alloc::format!(
            "UPDATE \"{parent}\" SET \"{col}\" = COALESCE(\"{col}\", '') || ? WHERE rowid = ?",
            parent = parent_esc,
            col = col_esc,
        );
        let stmt = db
            .prepare_v2(&append_sql)
            .map_err(|_| String::from("fast: prepare tail append"))?;
        stmt.bind_text(1, text, sqlite::Destructor::TRANSIENT)
            .map_err(|_| String::from("fast: bind text"))?;
        stmt.bind_int64(2, row_pk)
            .map_err(|_| String::from("fast: bind row_pk"))?;
        stmt.step()
            .map_err(|_| String::from("fast: step tail append"))?;
    } else {
        // Mid-content splice via substr. substr(body, 1, n) takes the first n
        // chars; substr(body, n+1) takes from char n onwards (1-indexed,
        // character-based for UTF-8 TEXT in SQLite).
        let splice_sql = alloc::format!(
            "UPDATE \"{parent}\" SET \"{col}\" = \
             substr(COALESCE(\"{col}\", ''), 1, ?) || ? || substr(COALESCE(\"{col}\", ''), ?) \
             WHERE rowid = ?",
            parent = parent_esc,
            col = col_esc,
        );
        let stmt = db
            .prepare_v2(&splice_sql)
            .map_err(|_| String::from("fast: prepare mid splice"))?;
        stmt.bind_int(1, insert_pos)
            .map_err(|_| String::from("fast: bind splice prefix-len"))?;
        stmt.bind_text(2, text, sqlite::Destructor::TRANSIENT)
            .map_err(|_| String::from("fast: bind splice text"))?;
        stmt.bind_int(3, insert_pos + 1)
            .map_err(|_| String::from("fast: bind splice suffix-start"))?;
        stmt.bind_int64(4, row_pk)
            .map_err(|_| String::from("fast: bind row_pk"))?;
        stmt.step()
            .map_err(|_| String::from("fast: step mid splice"))?;
    }

    let new_version =
        crate::cache::read_version(db, backing, row_pk).unwrap_or(entry.backing_version + 1);

    cache.set(
        backing,
        row_pk,
        crate::cache::AppendCacheEntry {
            backing_version: new_version,
            tail_item_id: new_item_id,
            tail_original_idx: new_idx,
            // Cursor advances by the length of the inserted text — it now
            // sits at the LAST inserted char. View length grows by the same.
            cursor_view_position: entry.cursor_view_position + new_text_len,
            view_length: entry.view_length + new_text_len,
        },
    );

    Ok(1)
}

/// (itemId, idx) — a node in the Fugue tree.
#[derive(Clone)]
struct NodeRef {
    item_id: String,
    idx: i32,
}

/// One row of the backing table relevant to neighbor lookup.
struct Node {
    item_id: String,
    idx: i32,
    content: Option<String>,
    parent_item_id: String,
    parent_idx: i32,
    tombstoned: bool,
}

fn perform_insert(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
    position: i32,
    text: &str,
) -> Result<usize, String> {
    let backing = backing_table_name(table, column);

    // Load all backing rows for this row_pk. Row count grows with edits; the
    // full load is fine at current scales (see top-of-file note).
    let nodes = load_nodes(db, &backing, row_pk)
        .map_err(|_| format!("failed to load fugue nodes for row_pk={}", row_pk))?;

    // Walk to find neighbors. Mid-run is handled β-flat (no split — new insert
    // attaches at parentIdx inside the entry's content range). `split_writes`
    // stays 0; we kept the binding to preserve the return-value shape.
    let split_writes = 0usize;
    let (left, right) = match find_neighbors_or_split(&nodes, position) {
        NeighborLookup::Boundary { left, right } => (left, right),
        NeighborLookup::MidRun {
            entry_item_id,
            entry_idx,
            attachment_idx,
        } => {
            // β-flat: don't split the entry row. The new insert attaches at a
            // mid-content position via parentIdx pointing inside the entry's
            // content range. `attachment_idx` was already resolved against
            // visible chars in find_neighbors_or_split, so deletion markers
            // from prior partial deletes don't shift the position incorrectly.
            (
                Some(NodeRef {
                    item_id: entry_item_id.clone(),
                    idx: attachment_idx,
                }),
                Some(NodeRef {
                    item_id: entry_item_id,
                    idx: entry_idx,
                }),
            )
        }
    };

    // Generate a fresh item_id for this insertion.
    let new_item_id = fresh_item_id(db).map_err(|_| String::from("failed to generate item_id"))?;
    // New idx = len(text) - 1 (Weidner: index is the LAST char strictly contained).
    let new_idx = (text.chars().count() as i32) - 1;

    // Case selection:
    //   Case 2: left neighbor has no children → new child of left neighbor
    //   Case 3: left neighbor has children → sentinel(rightItemId, -1) under right's parent
    //           + new child of sentinel
    //   Special: empty doc / inserting at position 0 with no left → new child of root
    //
    // Root parent is represented as ("", -2) per registration::install_render_trigger.

    let root = NodeRef {
        item_id: String::new(),
        idx: -2,
    };

    let (parent_for_new, sentinel_to_insert) = match (left, right) {
        (None, None) => {
            // Empty doc → new child of root.
            (root.clone(), None)
        }
        (None, Some(rn)) => {
            // Prepend: no left, right exists → Case 3.
            // Sentinel is a sibling of right (same parent), with right's itemId and idx=-1,
            // which sorts before right in (itemId, idx) order.
            // Look up the row by item_id alone — under β-flat each itemId has a
            // single row, and `rn.idx` may now point at a visible-char position
            // (different from the row's full idx when markers cover the tail).
            let r_node = nodes
                .iter()
                .find(|n| n.item_id == rn.item_id)
                .ok_or_else(|| String::from("right neighbor row not found"))?;
            let sentinel_parent = NodeRef {
                item_id: r_node.parent_item_id.clone(),
                idx: r_node.parent_idx,
            };
            (
                NodeRef {
                    item_id: rn.item_id.clone(),
                    idx: -1,
                },
                Some((rn.item_id.clone(), sentinel_parent)),
            )
        }
        (Some(l), r) => {
            if has_children(&nodes, &l) {
                match r {
                    Some(r) => {
                        // Case 3: sentinel under right's parent (rightItemId, -1).
                        let r_node = nodes
                            .iter()
                            .find(|n| n.item_id == r.item_id)
                            .ok_or_else(|| String::from("right neighbor row not found"))?;
                        let sentinel_parent = NodeRef {
                            item_id: r_node.parent_item_id.clone(),
                            idx: r_node.parent_idx,
                        };
                        (
                            NodeRef {
                                item_id: r.item_id.clone(),
                                idx: -1,
                            },
                            Some((r.item_id.clone(), sentinel_parent)),
                        )
                    }
                    None => {
                        // Left has (possibly all-invisible) children and we're at end-of-doc.
                        // Fall back to Case 2 — child of left. The new node sorts as a sibling of
                        // existing (tombstone/sentinel) children; (itemId, idx) ordering is then
                        // determined by item-id hex.
                        // #!~ Edge case worth revisiting: a stable end-of-doc append might want
                        // the new node placed as a child of the deepest-rightmost visible
                        // descendant rather than as a sibling of left's children. Not exercised
                        // by the Hypothesis trials so far.
                        (l, None)
                    }
                }
            } else {
                // Case 2: new child of left neighbor.
                (l, None)
            }
        }
    };

    // Insert sentinel if needed (Case 3).
    let mut written = 0usize;
    if let Some((sent_item_id, sent_parent)) = sentinel_to_insert {
        // Sentinel may already exist (idempotent under concurrent peers); INSERT OR IGNORE.
        insert_node(
            db,
            &backing,
            row_pk,
            &sent_item_id,
            -1,
            None,
            &sent_parent.item_id,
            sent_parent.idx,
            /*or_ignore=*/ true,
        )
        .map_err(|_| String::from("failed to insert sentinel"))?;
        written += 1;
    }

    // Insert the new content row.
    insert_node(
        db,
        &backing,
        row_pk,
        &new_item_id,
        new_idx,
        Some(text),
        &parent_for_new.item_id,
        parent_for_new.idx,
        /*or_ignore=*/ false,
    )
    .map_err(|_| String::from("failed to insert new content row"))?;
    written += 1;

    Ok(written + split_writes)
}

/// Result of locating an insertion point: either a boundary (left/right refs) or a mid-run
/// position that requires splitting the entry first.
enum NeighborLookup {
    Boundary {
        left: Option<NodeRef>,
        right: Option<NodeRef>,
    },
    MidRun {
        entry_item_id: String,
        /// The row's last-char idx in original-item space (i.e. `entry.idx`).
        entry_idx: i32,
        /// Absolute idx in the entry's idx-space *after* which the new content
        /// attaches (i.e. the `parent_idx` of the new row).
        attachment_idx: i32,
    },
}

/// Marker-aware neighbor lookup.
///
/// Walks the Fugue tree's visible chars (mirrors deletion::visible_chars and
/// render's walker — they all see the same view). For a view position P,
/// classifies the insertion site as:
///   - empty doc: Boundary { left: None, right: None }
///   - at start (P == 0): Boundary { left: None, right: first visible char }
///   - at end (P >= visible.len()): Boundary { left: last visible char, right: None }
///   - between two adjacent chars of the same row: MidRun
///   - between two chars in different rows (or across a marker gap): Boundary
///
/// NodeRef.idx in this β-flat scheme points at the original_idx of the
/// visible char, not necessarily the row's last-char idx. That's exactly the
/// `parent_idx` the new node will use to attach into the tree.
fn find_neighbors_or_split(nodes: &[Node], position: i32) -> NeighborLookup {
    // Convert insertion::Node to deletion::Node for the shared walker. Cheap
    // — one allocation per insert call; row count is small at our scales.
    let dn: Vec<crate::deletion::Node> = nodes
        .iter()
        .map(|n| crate::deletion::Node {
            item_id: n.item_id.clone(),
            idx: n.idx,
            content: n.content.clone(),
            parent_item_id: n.parent_item_id.clone(),
            parent_idx: n.parent_idx,
            tombstoned: n.tombstoned,
        })
        .collect();
    let visible = crate::deletion::visible_chars(&dn);

    let p = position.max(0) as usize;

    if visible.is_empty() {
        return NeighborLookup::Boundary {
            left: None,
            right: None,
        };
    }

    if p == 0 {
        let first = &visible[0];
        return NeighborLookup::Boundary {
            left: None,
            right: Some(NodeRef {
                item_id: first.item_id.clone(),
                idx: first.original_idx,
            }),
        };
    }

    if p >= visible.len() {
        let last = &visible[visible.len() - 1];
        return NeighborLookup::Boundary {
            left: Some(NodeRef {
                item_id: last.item_id.clone(),
                idx: last.original_idx,
            }),
            right: None,
        };
    }

    let left_vc = &visible[p - 1];
    let right_vc = &visible[p];

    // Same-row & adjacent in idx-space → MidRun. The "adjacent" check rejects
    // pairs that look adjacent in view but actually have a marker-covered gap
    // between them in original-idx space.
    let same_row_adjacent = left_vc.item_id == right_vc.item_id
        && right_vc.original_idx == left_vc.original_idx + 1;

    if same_row_adjacent {
        // Find the row's full idx so Case-3 sentinel placement works.
        let row_idx = nodes
            .iter()
            .find(|n| n.item_id == left_vc.item_id)
            .map(|n| n.idx)
            .unwrap_or(left_vc.original_idx);
        return NeighborLookup::MidRun {
            entry_item_id: left_vc.item_id.clone(),
            entry_idx: row_idx,
            attachment_idx: left_vc.original_idx,
        };
    }

    NeighborLookup::Boundary {
        left: Some(NodeRef {
            item_id: left_vc.item_id.clone(),
            idx: left_vc.original_idx,
        }),
        right: Some(NodeRef {
            item_id: right_vc.item_id.clone(),
            idx: right_vc.original_idx,
        }),
    }
}

fn load_nodes(db: *mut sqlite3, backing: &str, row_pk: i64) -> Result<Vec<Node>, ResultCode> {
    let sql = format!(
        "SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned \
         FROM \"{}\" WHERE row_pk = ?",
        escape_ident(backing)
    );
    let stmt = db.prepare_v2(&sql)?;
    stmt.bind_int64(1, row_pk)?;
    let mut out = Vec::new();
    while stmt.step()? == ResultCode::ROW {
        out.push(Node {
            item_id: String::from(stmt.column_text(0)?),
            idx: stmt.column_int(1),
            content: if stmt.column_type(2)? == sqlite::ColumnType::Null {
                None
            } else {
                Some(String::from(stmt.column_text(2)?))
            },
            parent_item_id: String::from(stmt.column_text(3)?),
            parent_idx: stmt.column_int(4),
            tombstoned: stmt.column_int(5) != 0,
        });
    }
    Ok(out)
}

fn has_children(nodes: &[Node], parent: &NodeRef) -> bool {
    nodes
        .iter()
        .any(|n| n.parent_item_id == parent.item_id && n.parent_idx == parent.idx)
}

fn insert_node(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
    item_id: &str,
    idx: i32,
    content: Option<&str>,
    parent_item_id: &str,
    parent_idx: i32,
    or_ignore: bool,
) -> Result<(), ResultCode> {
    let or_clause = if or_ignore { "OR IGNORE" } else { "" };
    let sql = format!(
        "INSERT {} INTO \"{}\" (row_pk, itemId, idx, content, parentItemId, parentIdx) \
         VALUES (?, ?, ?, ?, ?, ?)",
        or_clause,
        escape_ident(backing)
    );
    let stmt = db.prepare_v2(&sql)?;
    stmt.bind_int64(1, row_pk)?;
    stmt.bind_text(2, item_id, Destructor::TRANSIENT)?;
    stmt.bind_int(3, idx)?;
    match content {
        Some(s) => stmt.bind_text(4, s, Destructor::TRANSIENT)?,
        None => stmt.bind_null(4)?,
    };
    stmt.bind_text(5, parent_item_id, Destructor::TRANSIENT)?;
    stmt.bind_int(6, parent_idx)?;
    stmt.step()?;
    Ok(())
}

/// Generate a fresh item_id: hex(crsql_site_id()) prefix + random suffix.
///
/// #!~ tighten to {site}.{monotonic_counter} for ordering stability
pub(crate) fn fresh_item_id(db: *mut sqlite3) -> Result<String, ResultCode> {
    let stmt = db.prepare_v2(
        "SELECT lower(hex(crsql_site_id())) || '_' || lower(hex(randomblob(6)))",
    )?;
    stmt.step()?;
    Ok(String::from(stmt.column_text(0)?))
}
