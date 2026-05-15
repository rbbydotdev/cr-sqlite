extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// SQL function `crsql_fugue_delete(table, col, row_pk, from, to)`:
///
/// Deletes character range `[from, to)` from the rendered text of `(table.col, row_pk)`.
/// Each overlapped sub-item is either wholly tombstoned (via the tombstoned boolean
/// column, content preserved) or split into (left kept, middle tombstoned, right kept)
/// parts. Coalescing runs inline after the split work, so adjacent same-itemId
/// tombstones collapse before the explicit rerender.
pub fn fugue_delete(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 5 {
        ctx.result_error(
            "crsql_fugue_delete requires 5 args: (table, column, row_pk, from, to)",
        );
        return;
    }

    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = arg_slice[2].int64();
    let from = arg_slice[3].int();
    let to = arg_slice[4].int();
    let db = ctx.db_handle();

    if to <= from {
        ctx.result_int(0);
        return;
    }

    let result = crate::active::with_active(db, || {
        perform_delete(db, table, column, row_pk, from, to)
        // Note: a β-split-era `coalesce_tombstones` pass ran here to drop
        // non-rightmost adjacent same-itemId tombstones. Obsolete in β-flat —
        // every char gets a unique itemId so the "group by itemId" filter
        // produces only singletons. Removed alongside the cleanup module.
    });
    match result {
        Ok(_) => {
            if let Err(msg) = crate::render::rerender_parent_column(db, table, column, row_pk) {
                ctx.result_error(&msg);
                return;
            }
            ctx.result_int(0);
        }
        Err(msg) => ctx.result_error(&msg),
    }
}

pub(crate) struct Node {
    pub(crate) item_id: String,
    pub(crate) idx: i32,
    pub(crate) content: Option<String>,
    pub(crate) parent_item_id: String,
    pub(crate) parent_idx: i32,
    pub(crate) tombstoned: bool,
}

fn perform_delete(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
    from: i32,
    to: i32,
) -> Result<usize, String> {
    let backing = backing_table_name(table, column);

    let nodes = load_nodes(db, &backing, row_pk)
        .map_err(|_| format!("failed to load nodes for row_pk={}", row_pk))?;

    // β-flat deletion. Walk visible chars to map view positions [from, to)
    // onto the (item_id, original_idx) pairs they came from — accounting for
    // deletion markers from prior deletes (which shorten the visible text but
    // leave the underlying rows intact).
    let visible = visible_chars(&nodes);

    enum Op {
        WholeTombstone {
            item_id: String,
            idx: i32,
        },
        DeletionMarker {
            parent_item_id: String,
            cover_end_idx: i32, // LAST parent position covered
            deleted_text: String, // length encodes the cover span
        },
    }

    // For each item_id with chars in the delete range, collect the set of
    // original_idx values to be marked. After collecting, each item turns into
    // either a WholeTombstone (every char of the row is in the range) or a
    // DeletionMarker covering [min..max]. Mid-range gaps don't happen because
    // a contiguous view range maps to contiguous original_idxes within each
    // parent (the walk emits each row's chars in idx order, with children
    // interleaved as separate rows that we don't touch via this marker).
    let mut per_item: BTreeMap<String, Vec<i32>> = BTreeMap::new();
    for (view_pos, vc) in visible.iter().enumerate() {
        let view_i = view_pos as i32;
        if view_i < from {
            continue;
        }
        if view_i >= to {
            break;
        }
        per_item
            .entry(vc.item_id.clone())
            .or_default()
            .push(vc.original_idx);
    }

    // Look up each affected row's total content length so we can detect the
    // "every char of the row is in the delete range" case → WholeTombstone.
    let mut content_len_by_item: BTreeMap<String, usize> = BTreeMap::new();
    let mut last_idx_by_item: BTreeMap<String, i32> = BTreeMap::new();
    for n in &nodes {
        if let Some(s) = &n.content {
            let l = s.chars().count();
            if l > 0 {
                content_len_by_item.insert(n.item_id.clone(), l);
                last_idx_by_item.insert(n.item_id.clone(), n.idx);
            }
        }
    }

    let mut ops: Vec<Op> = Vec::new();
    for (item_id, idxes) in per_item {
        if idxes.is_empty() {
            continue;
        }
        let row_len = match content_len_by_item.get(&item_id) {
            Some(&n) => n,
            None => continue,
        };
        let row_idx = match last_idx_by_item.get(&item_id) {
            Some(&v) => v,
            None => continue,
        };

        // Slice the deleted text out of the row's content for the marker payload.
        let row_node = nodes
            .iter()
            .find(|n| n.item_id == item_id && Some(row_idx) == Some(n.idx))
            .ok_or_else(|| String::from("internal: deletion target row not found"))?;
        let row_content = row_node
            .content
            .as_ref()
            .ok_or_else(|| String::from("internal: deletion target row missing content"))?;
        let first_idx = row_idx - (row_len as i32) + 1;

        let min_idx = *idxes.iter().min().unwrap();
        let max_idx = *idxes.iter().max().unwrap();
        let span_chars = (max_idx - min_idx + 1) as usize;

        // If the delete covers every char of the row (and no other children are
        // shielding intermediate positions from being part of the visible run),
        // tombstone the whole row. Otherwise emit a span marker for [min..max].
        if span_chars == row_len && idxes.len() == row_len {
            ops.push(Op::WholeTombstone {
                item_id: item_id.clone(),
                idx: row_idx,
            });
        } else {
            let chars_vec: Vec<char> = row_content.chars().collect();
            let start_offset = (min_idx - first_idx) as usize;
            let end_offset = (max_idx - first_idx) as usize;
            let deleted_text: String = chars_vec
                .iter()
                .skip(start_offset)
                .take(end_offset - start_offset + 1)
                .collect();

            ops.push(Op::DeletionMarker {
                parent_item_id: item_id.clone(),
                cover_end_idx: max_idx,
                deleted_text,
            });
        }
    }

    let mut writes = 0usize;
    for op in ops {
        match op {
            Op::WholeTombstone { item_id, idx } => {
                // Set tombstoned=1; keep content (matters for cleanup-pass overlap math
                // and for tombstone-wins-on-NULL race resistance).
                mark_tombstoned(db, &backing, row_pk, &item_id, idx)?;
                writes += 1;
            }
            Op::DeletionMarker {
                parent_item_id,
                cover_end_idx,
                deleted_text,
            } => {
                // Generate a fresh marker itemId with the engine-reserved prefix.
                // The prefix lets the render walker recognise this row as a
                // span-cover marker rather than a regular tombstoned insert.
                let raw_id = crate::insertion::fresh_item_id(db)
                    .map_err(|_| String::from("deletion: fresh item_id"))?;
                let marker_id = format!("DM_{}", raw_id);
                // Marker rows store the deleted text as their `content` (its
                // length encodes how many parent chars the marker covers) and
                // attach to the parent at `cover_end_idx`. The marker's own
                // `idx` is irrelevant to the render walk and just needs to
                // satisfy the PK uniqueness constraint — we use `cover_end_idx`
                // for clarity (different marker itemIds = different PKs).
                insert_split_part(
                    db,
                    &backing,
                    row_pk,
                    &marker_id,
                    cover_end_idx,
                    Some(&deleted_text),
                    &parent_item_id,
                    cover_end_idx,
                    /*tombstoned=*/ true,
                )?;
                writes += 1;
            }
        }
    }

    Ok(writes)
}

/// One visible character in the rendered text, with the row that owns it and
/// its position in the owning row's idx-space. Per-char granularity is what
/// lets the deletion logic map a view-position delete range back to the
/// underlying (itemId, original_idx) targets — even when prior deletion
/// markers have shortened the visible text.
pub(crate) struct VisibleChar {
    pub(crate) item_id: String,
    /// Absolute idx in the owning row (parent's first_idx + offset).
    pub(crate) original_idx: i32,
}

pub(crate) const DELETION_MARKER_PREFIX: &str = "DM_";

pub(crate) fn is_deletion_marker_node(item_id: &str, tombstoned: bool) -> bool {
    tombstoned && item_id.starts_with(DELETION_MARKER_PREFIX)
}

fn is_deletion_marker(node: &Node) -> bool {
    is_deletion_marker_node(&node.item_id, node.tombstoned)
}

/// Summary of the visible chars: total count + identity of the LAST visible
/// char. Equivalent to `visible_chars(nodes).last().cloned()` paired with
/// `visible_chars(nodes).len()` but walks the tree in O(N) without
/// allocating a per-char Vec — important for the cache-refresh path after
/// bulk inserts where the visible_chars Vec would be huge.
pub(crate) fn visible_summary(nodes: &[Node]) -> Option<(String, i32, usize)> {
    let mut by_parent: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for n in nodes {
        by_parent
            .entry(n.parent_item_id.as_str())
            .or_default()
            .push(n);
    }
    for v in by_parent.values_mut() {
        v.sort_by(|a, b| {
            a.parent_idx
                .cmp(&b.parent_idx)
                .then_with(|| a.item_id.cmp(&b.item_id))
                .then_with(|| a.idx.cmp(&b.idx))
        });
    }

    let mut count: usize = 0;
    let mut last: Option<(String, i32)> = None;
    if let Some(roots) = by_parent.get("") {
        for kid in roots.iter().filter(|r| r.parent_idx == -2) {
            walk_summary(kid, &by_parent, &mut count, &mut last);
        }
    }
    last.map(|(id, idx)| (id, idx, count))
}

fn walk_summary<'a>(
    node: &'a Node,
    by_parent: &BTreeMap<&'a str, Vec<&'a Node>>,
    count: &mut usize,
    last: &mut Option<(String, i32)>,
) {
    let chars_count = match &node.content {
        Some(s) => s.chars().count(),
        None => 0,
    };
    let kids = by_parent.get(node.item_id.as_str());

    if chars_count == 0 {
        if let Some(kids_v) = kids {
            for kid in kids_v.iter().filter(|k| k.parent_idx == node.idx) {
                walk_summary(kid, by_parent, count, last);
            }
        }
        return;
    }

    let n_chars = chars_count as i32;
    let first_idx = node.idx - n_chars + 1;

    let mut covered: alloc::collections::BTreeSet<i32> = alloc::collections::BTreeSet::new();
    if let Some(kids_v) = kids {
        for kid in kids_v.iter() {
            if is_deletion_marker(kid)
                && kid.parent_idx >= first_idx
                && kid.parent_idx <= node.idx
            {
                let span_len = kid
                    .content
                    .as_ref()
                    .map(|c| c.chars().count() as i32)
                    .unwrap_or(0);
                if span_len > 0 {
                    let start = (kid.parent_idx - span_len + 1).max(first_idx);
                    for p in start..=kid.parent_idx {
                        covered.insert(p);
                    }
                }
            }
        }
    }

    for offset in 0..n_chars {
        let abs_idx = first_idx + offset;
        if !node.tombstoned && node.idx != -1 && !covered.contains(&abs_idx) {
            *count += 1;
            *last = Some((node.item_id.clone(), abs_idx));
        }
        if let Some(kids_v) = kids {
            for kid in kids_v
                .iter()
                .filter(|k| k.parent_idx == abs_idx && !is_deletion_marker(k))
            {
                walk_summary(kid, by_parent, count, last);
            }
        }
    }
}

/// Walk the Fugue tree producing one entry per visible char in render order.
/// Mirrors render.rs::walk_node but emits per-char records instead of a string,
/// so callers can resolve a view-position back to the (itemId, original_idx)
/// pair to attach a deletion marker to.
pub(crate) fn visible_chars(nodes: &[Node]) -> Vec<VisibleChar> {
    let mut by_parent: BTreeMap<&str, Vec<&Node>> = BTreeMap::new();
    for n in nodes {
        by_parent
            .entry(n.parent_item_id.as_str())
            .or_default()
            .push(n);
    }
    for v in by_parent.values_mut() {
        v.sort_by(|a, b| {
            a.parent_idx
                .cmp(&b.parent_idx)
                .then_with(|| a.item_id.cmp(&b.item_id))
                .then_with(|| a.idx.cmp(&b.idx))
        });
    }

    let mut out: Vec<VisibleChar> = Vec::new();
    if let Some(roots) = by_parent.get("") {
        for kid in roots.iter().filter(|r| r.parent_idx == -2) {
            walk_chars(kid, &by_parent, &mut out);
        }
    }
    out
}

fn walk_chars<'a>(
    node: &'a Node,
    by_parent: &BTreeMap<&'a str, Vec<&'a Node>>,
    out: &mut Vec<VisibleChar>,
) {
    let chars: Vec<char> = match &node.content {
        Some(s) => s.chars().collect(),
        None => Vec::new(),
    };
    let kids = by_parent.get(node.item_id.as_str());

    if chars.is_empty() {
        if let Some(kids_v) = kids {
            for kid in kids_v.iter().filter(|k| k.parent_idx == node.idx) {
                walk_chars(kid, by_parent, out);
            }
        }
        return;
    }

    let n_chars = chars.len() as i32;
    let first_idx = node.idx - n_chars + 1;

    // Build the set of parent positions covered by any deletion-marker child.
    let mut covered: alloc::collections::BTreeSet<i32> = alloc::collections::BTreeSet::new();
    if let Some(kids_v) = kids {
        for kid in kids_v.iter() {
            if is_deletion_marker(kid)
                && kid.parent_idx >= first_idx
                && kid.parent_idx <= node.idx
            {
                let span_len = kid
                    .content
                    .as_ref()
                    .map(|c| c.chars().count() as i32)
                    .unwrap_or(0);
                if span_len > 0 {
                    let start = (kid.parent_idx - span_len + 1).max(first_idx);
                    for p in start..=kid.parent_idx {
                        covered.insert(p);
                    }
                }
            }
        }
    }

    for offset in 0..n_chars {
        let abs_idx = first_idx + offset;
        if !node.tombstoned && node.idx != -1 && !covered.contains(&abs_idx) {
            out.push(VisibleChar {
                item_id: node.item_id.clone(),
                original_idx: abs_idx,
            });
        }
        if let Some(kids_v) = kids {
            for kid in kids_v
                .iter()
                .filter(|k| k.parent_idx == abs_idx && !is_deletion_marker(k))
            {
                walk_chars(kid, by_parent, out);
            }
        }
    }
}

pub(crate) fn load_nodes_pub(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
) -> Result<Vec<Node>, ResultCode> {
    load_nodes(db, backing, row_pk)
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

fn insert_split_part(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
    item_id: &str,
    idx: i32,
    content: Option<&str>,
    parent_item_id: &str,
    parent_idx: i32,
    tombstoned: bool,
) -> Result<(), String> {
    let sql = format!(
        "INSERT OR IGNORE INTO \"{}\" (row_pk, itemId, idx, content, parentItemId, parentIdx, tombstoned) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        escape_ident(backing)
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare insert_split_part"))?;
    stmt.bind_int64(1, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    stmt.bind_text(2, item_id, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind item_id"))?;
    stmt.bind_int(3, idx)
        .map_err(|_| String::from("bind idx"))?;
    match content {
        Some(s) => stmt
            .bind_text(4, s, Destructor::TRANSIENT)
            .map_err(|_| String::from("bind content"))?,
        None => stmt.bind_null(4).map_err(|_| String::from("bind NULL"))?,
    };
    stmt.bind_text(5, parent_item_id, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind parent_item_id"))?;
    stmt.bind_int(6, parent_idx)
        .map_err(|_| String::from("bind parent_idx"))?;
    stmt.bind_int(7, if tombstoned { 1 } else { 0 })
        .map_err(|_| String::from("bind tombstoned"))?;
    stmt.step()
        .map_err(|_| String::from("insert_split_part step"))?;
    Ok(())
}

/// Set tombstoned=1 on an existing row without changing its content. Used for whole-row deletes
/// where we want to preserve content for cleanup overlap math and tombstone-wins races.
fn mark_tombstoned(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
    item_id: &str,
    idx: i32,
) -> Result<(), String> {
    let sql = format!(
        "UPDATE \"{}\" SET tombstoned = 1 WHERE row_pk = ? AND itemId = ? AND idx = ?",
        escape_ident(backing)
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare mark_tombstoned"))?;
    stmt.bind_int64(1, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    stmt.bind_text(2, item_id, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind item_id"))?;
    stmt.bind_int(3, idx)
        .map_err(|_| String::from("bind idx"))?;
    stmt.step()
        .map_err(|_| String::from("mark_tombstoned step"))?;
    Ok(())
}

// (derive_middle_content removed — m_text now carried directly through the Op struct.)
// (rerender_parent moved to render::rerender_parent_column for sharing across modules.)
