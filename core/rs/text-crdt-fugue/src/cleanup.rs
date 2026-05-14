extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

/// SQL function `crsql_fugue_cleanup(table, col, row_pk) → INT (rows updated)`.
///
/// Applies tantaman's smallest-index-first trim pass (issue #65, Weidner-endorsed) to the
/// Fugue backing rows for a given (table.col, row_pk). After mutual sync of concurrent splits
/// of the same item, peers each see overlapping sub-items with the same itemId. This pass
/// trims the overlap so render output is the deterministic Fugue result.
///
/// Call after each sync-apply for correctness on concurrent split scenarios.
///
/// #!~ tighten-3: tombstone-wins-via-NULL is not enforced. If peers race a tombstone against a
///     content edit on the same (itemId, idx) primary key, cr-sqlite's per-column LWW decides
///     which value wins. A dedicated `tombstoned` boolean column would give monotonic "any peer
///     said delete → it's deleted" semantics but requires a schema migration.
pub fn fugue_cleanup(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_fugue_cleanup requires 3 args: (table, column, row_pk)");
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = arg_slice[2].int64();
    let db = ctx.db_handle();

    let result = crate::active::with_active(db, || {
        perform_cleanup(db, table, column, row_pk)
    });
    match result {
        Ok(n) => {
            if let Err(msg) = crate::render::rerender_parent_column(db, table, column, row_pk) {
                ctx.result_error(&msg);
                return;
            }
            ctx.result_int(n as i32);
        }
        Err(msg) => ctx.result_error(&msg),
    }
}

struct Node {
    item_id: String,
    idx: i32,
    content: Option<String>,
    tombstoned: bool,
}

fn perform_cleanup(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: i64,
) -> Result<usize, String> {
    let backing = backing_table_name(table, column);
    let nodes = load_nodes(db, &backing, row_pk)
        .map_err(|_| format!("failed to load nodes for row_pk={}", row_pk))?;

    // Group by itemId. Filter out sentinels (idx == -1) — they're not content.
    let mut by_item: BTreeMap<String, Vec<Node>> = BTreeMap::new();
    for n in nodes {
        if n.idx == -1 {
            continue;
        }
        by_item.entry(n.item_id.clone()).or_default().push(n);
    }

    let mut updates = 0usize;
    for (_, mut items) in by_item {
        if items.len() < 2 {
            continue;
        }
        items.sort_by_key(|n| n.idx);

        // For each (i, j) with i < j: if items[j].startIdx <= items[i].idx, trim items[j]'s
        // content from offset (items[i].idx + 1 - items[j].startIdx). Where:
        //   startIdx = idx - len(content) + 1   (only defined for content rows)
        // Mutate items[j].content in place so cascading overlaps use the trimmed length.
        for i in 0..items.len() {
            let current_idx = items[i].idx;
            for j in (i + 1)..items.len() {
                let Some(later_content) = items[j].content.clone() else {
                    continue; // tombstone — no content to trim
                };
                let chars: Vec<char> = later_content.chars().collect();
                let later_len = chars.len() as i32;
                let later_start = items[j].idx - later_len + 1;
                if later_start > current_idx {
                    continue; // no overlap
                }
                let trim_offset_signed = current_idx + 1 - later_start;
                if trim_offset_signed <= 0 {
                    continue; // already consistent
                }
                let trim_offset = trim_offset_signed as usize;
                if trim_offset >= chars.len() {
                    // The overlap covers the entire later content. Weidner's spec keeps the row
                    // around as a tombstone of zero-length content. We replace with empty string
                    // for now. #!~ tighten-3: if we adopt a tombstoned boolean, set tombstoned=1
                    // and leave content alone.
                    let new_content = String::new();
                    if items[j].content.as_deref() != Some(&new_content) {
                        update_row_content(
                            db,
                            &backing,
                            row_pk,
                            &items[j].item_id,
                            items[j].idx,
                            Some(&new_content),
                        )?;
                        items[j].content = Some(new_content);
                        updates += 1;
                    }
                    continue;
                }
                let new_content: String = chars[trim_offset..].iter().collect();
                if items[j].content.as_deref() != Some(new_content.as_str()) {
                    update_row_content(
                        db,
                        &backing,
                        row_pk,
                        &items[j].item_id,
                        items[j].idx,
                        Some(&new_content),
                    )?;
                    items[j].content = Some(new_content);
                    updates += 1;
                }
            }
        }
    }

    // After content trimming, coalesce adjacent tombstones for the same itemId.
    coalesce_tombstones(db, &backing, row_pk)?;

    Ok(updates)
}

fn load_nodes(db: *mut sqlite3, backing: &str, row_pk: i64) -> Result<Vec<Node>, ResultCode> {
    let sql = format!(
        "SELECT itemId, idx, content, tombstoned FROM \"{}\" WHERE row_pk = ?",
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
            tombstoned: stmt.column_int(3) != 0,
        });
    }
    Ok(out)
}

/// Tombstone coalescing per Weidner: delete non-rightmost adjacent same-itemId tombstones
/// (preserving any that have children). Reduces row count after typing-then-deleting
/// patterns and after sync of concurrent deletes.
///
/// Called from fugue_delete (post-delete inline) and fugue_cleanup. Safe in both modes
/// because we only delete rows that have no children — the rightmost tombstone retains
/// the idx that any sibling/parent linkage would target.
pub(crate) fn coalesce_tombstones(
    db: *mut sqlite3,
    backing: &str,
    row_pk: i64,
) -> Result<usize, String> {
    let nodes = load_nodes(db, backing, row_pk)
        .map_err(|_| format!("coalesce: failed to load nodes for row_pk={}", row_pk))?;

    // Group tombstones by itemId. For each group, the rightmost (highest idx) stays;
    // earlier siblings get queued for deletion if and only if they have no children.
    let mut by_item: BTreeMap<String, Vec<&Node>> = BTreeMap::new();
    for n in &nodes {
        if n.tombstoned && n.idx >= 0 {
            by_item.entry(n.item_id.clone()).or_default().push(n);
        }
    }

    let mut to_delete: Vec<(String, i32)> = Vec::new();
    for (item_id, mut items) in by_item {
        if items.len() < 2 {
            continue;
        }
        items.sort_by_key(|n| n.idx);
        // Drop the rightmost — that one is kept.
        let len = items.len();
        for n in &items[..len - 1] {
            // Skip if has children (Weidner's exception).
            let has_kids = nodes.iter().any(|c| {
                // Sentinels point at us, real children point at us — both count.
                // (No-children means literally no row references this as parent.)
                // We approximate via: any row with parent_item_id == n.item_id AND
                //                              parent_idx == n.idx.
                // The load_nodes Node struct above doesn't carry parent fields;
                // we need the full row info. Inline a probe instead.
                let _ = c;
                false // placeholder; corrected below
            });
            if has_kids {
                continue;
            }
            to_delete.push((item_id.clone(), n.idx));
        }
    }

    if to_delete.is_empty() {
        return Ok(0);
    }

    // Re-check has_children per candidate before deleting (the Node struct here lacks
    // parent fields, so probe the table directly — cheap because tombstone-bearing
    // itemIds are usually small).
    let kids_sql = format!(
        "SELECT count(*) FROM \"{}\" WHERE row_pk = ? AND parentItemId = ? AND parentIdx = ?",
        escape_ident(backing)
    );
    let del_sql = format!(
        "DELETE FROM \"{}\" WHERE row_pk = ? AND itemId = ? AND idx = ?",
        escape_ident(backing)
    );

    let mut deleted = 0usize;
    for (item_id, idx) in &to_delete {
        // Has-children probe
        let kids_stmt = db
            .prepare_v2(&kids_sql)
            .map_err(|_| String::from("coalesce: prepare kids probe"))?;
        kids_stmt
            .bind_int64(1, row_pk)
            .map_err(|_| String::from("coalesce: bind row_pk"))?;
        kids_stmt
            .bind_text(2, item_id, Destructor::TRANSIENT)
            .map_err(|_| String::from("coalesce: bind itemId"))?;
        kids_stmt
            .bind_int(3, *idx)
            .map_err(|_| String::from("coalesce: bind idx"))?;
        let has_kids = if kids_stmt.step().map_err(|_| String::from("kids step"))?
            == ResultCode::ROW
        {
            kids_stmt.column_int(0) > 0
        } else {
            false
        };
        if has_kids {
            continue;
        }

        let del_stmt = db
            .prepare_v2(&del_sql)
            .map_err(|_| String::from("coalesce: prepare delete"))?;
        del_stmt
            .bind_int64(1, row_pk)
            .map_err(|_| String::from("coalesce: bind row_pk"))?;
        del_stmt
            .bind_text(2, item_id, Destructor::TRANSIENT)
            .map_err(|_| String::from("coalesce: bind itemId"))?;
        del_stmt
            .bind_int(3, *idx)
            .map_err(|_| String::from("coalesce: bind idx"))?;
        del_stmt
            .step()
            .map_err(|_| String::from("coalesce: delete step"))?;
        deleted += 1;
    }

    Ok(deleted)
}

fn update_row_content(
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
    let stmt = db.prepare_v2(&sql).map_err(|_| String::from("prepare cleanup update"))?;
    match content {
        Some(s) => stmt
            .bind_text(1, s, Destructor::TRANSIENT)
            .map_err(|_| String::from("bind content"))?,
        None => stmt.bind_null(1).map_err(|_| String::from("bind NULL"))?,
    };
    stmt.bind_int64(2, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    stmt.bind_text(3, item_id, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind itemId"))?;
    stmt.bind_int(4, idx)
        .map_err(|_| String::from("bind idx"))?;
    stmt.step()
        .map_err(|_| String::from("cleanup update step"))?;
    Ok(())
}
