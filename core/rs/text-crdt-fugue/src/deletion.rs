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
        perform_delete(db, table, column, row_pk, from, to)?;
        // Coalesce adjacent tombstones from this delete (and any prior deletes on
        // the same itemId). Inline here so the explicit rerender below sees the
        // coalesced state.
        let backing = crate::util::backing_table_name(table, column);
        crate::cleanup::coalesce_tombstones(db, &backing, row_pk)?;
        Ok(())
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

struct Node {
    item_id: String,
    idx: i32,
    content: Option<String>,
    parent_item_id: String,
    parent_idx: i32,
    tombstoned: bool,
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

    // Build render order with cumulative offsets.
    let visible = render_order_with_offsets(&nodes);

    // β-flat deletion: a partial delete inserts a single deletion-marker child
    // (tombstoned, with the deleted text as content) instead of splitting the
    // parent into L/M/R + UPDATEing the parent's content. The render walker
    // hides the covered parent positions on read. The atomic-row invariant is
    // preserved — the parent row's `content` cell is never UPDATEd.
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

    let mut ops: Vec<Op> = Vec::new();

    for entry in &visible {
        let render_end = entry.render_start + entry.char_count;
        if render_end <= from || entry.render_start >= to {
            continue;
        }

        let local_from = (from - entry.render_start).max(0) as usize;
        let local_to = ((to - entry.render_start) as usize).min(entry.char_count as usize);
        if local_from >= local_to {
            continue;
        }

        let content_str = &entry.content;
        let len = content_str.chars().count();
        let chars_vec: Vec<char> = content_str.chars().collect();
        let l_text: String = chars_vec.iter().take(local_from).collect();
        let m_text: String = chars_vec.iter().skip(local_from).take(local_to - local_from).collect();
        let r_text: String = chars_vec.iter().skip(local_to).collect();

        if l_text.is_empty() && r_text.is_empty() {
            ops.push(Op::WholeTombstone {
                item_id: entry.item_id.clone(),
                idx: entry.idx,
            });
        } else {
            // Partial delete: insert a marker that covers parent positions
            //   [entry.idx - len + 1 + local_from, entry.idx - len + local_to]
            // We anchor the marker by its `parent_idx` = LAST covered position;
            // the render walker reconstructs the cover span from `content` length.
            let cover_end_idx = entry.idx - (len as i32) + (local_to as i32);

            ops.push(Op::DeletionMarker {
                parent_item_id: entry.item_id.clone(),
                cover_end_idx,
                deleted_text: m_text,
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

struct VisibleEntry {
    item_id: String,
    idx: i32,
    parent_item_id: String,
    parent_idx: i32,
    content: String,
    char_count: i32,
    render_start: i32,
}

fn render_order_with_offsets(nodes: &[Node]) -> Vec<VisibleEntry> {
    let mut children: BTreeMap<(String, i32), Vec<&Node>> = BTreeMap::new();
    for n in nodes {
        children
            .entry((n.parent_item_id.clone(), n.parent_idx))
            .or_default()
            .push(n);
    }
    for v in children.values_mut() {
        v.sort_by(|a, b| (a.item_id.as_str(), a.idx).cmp(&(b.item_id.as_str(), b.idx)));
    }

    let mut out: Vec<VisibleEntry> = Vec::new();
    let mut cursor: i32 = 0;
    let mut stack: Vec<(String, i32)> = Vec::new();
    stack.push((String::new(), -2));
    walk(&children, &mut stack, &mut out, &mut cursor);
    out
}

fn walk(
    children: &BTreeMap<(String, i32), Vec<&Node>>,
    stack: &mut Vec<(String, i32)>,
    out: &mut Vec<VisibleEntry>,
    cursor: &mut i32,
) {
    let Some(top) = stack.last().cloned() else {
        return;
    };
    if let Some(kids) = children.get(&top) {
        for kid in kids {
            let is_sentinel = kid.idx == -1;
            let is_tombstone = kid.content.is_none() || kid.tombstoned;
            if !is_sentinel && !is_tombstone {
                if let Some(s) = &kid.content {
                    let chars = s.chars().count() as i32;
                    if chars > 0 {
                        out.push(VisibleEntry {
                            item_id: kid.item_id.clone(),
                            idx: kid.idx,
                            parent_item_id: kid.parent_item_id.clone(),
                            parent_idx: kid.parent_idx,
                            content: s.clone(),
                            char_count: chars,
                            render_start: *cursor,
                        });
                        *cursor += chars;
                    }
                }
            }
            stack.push((kid.item_id.clone(), kid.idx));
            walk(children, stack, out, cursor);
            stack.pop();
        }
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

fn update_content(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
    item_id: &str,
    idx: i32,
    content: Option<&str>,
) -> Result<(), String> {
    let sql = format!(
        "UPDATE \"{}\" SET content = ? WHERE row_pk = ? AND itemId = ? AND idx = ?",
        escape_ident(backing)
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare update_content"))?;
    match content {
        Some(s) => stmt
            .bind_text(1, s, Destructor::TRANSIENT)
            .map_err(|_| String::from("bind content"))?,
        None => stmt.bind_null(1).map_err(|_| String::from("bind NULL"))?,
    };
    stmt.bind_int64(2, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    stmt.bind_text(3, item_id, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind item_id"))?;
    stmt.bind_int(4, idx)
        .map_err(|_| String::from("bind idx"))?;
    stmt.step().map_err(|_| String::from("update_content step"))?;
    Ok(())
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
