// #!~ Phase 6 perf: each insert loads ALL nodes for the row_pk and walks the tree linearly.
// For 1000 random-position inserts on a growing doc this is O(n²) and observed ~100ms/op
// after a few hundred rows. Fix paths: (a) maintain a render-cache keyed by row_pk version,
// (b) navigate with indexed queries instead of full load, (c) implement Case 1 extension to
// keep row count bounded. Gate-met cases (10K paste, 100 sequential keystrokes) stay fast.
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
/// #!~ Phase 6: implement Case 1 (extend our own most-recent run) for fewer rows
/// #!~ Phase 4: revisit Case 3 for correctness under concurrent merge
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

    match perform_insert(db, table, column, row_pk, position, text) {
        Ok(n) => ctx.result_int(n as i32),
        Err(msg) => ctx.result_error(&msg),
    }
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

    // Load all nodes for this row_pk (Phase 2: full load is fine; a doc has tens to hundreds of rows).
    // #!~ Phase 6: switch to a cursor-based walk if profiling shows quadratic
    let mut nodes = load_nodes(db, &backing, row_pk)
        .map_err(|_| format!("failed to load fugue nodes for row_pk={}", row_pk))?;

    // Walk to find neighbors. If position is strictly INSIDE a run (mid-run), split it first.
    let mut split_writes = 0usize;
    let (left, right) = match find_neighbors_or_split(&nodes, position) {
        NeighborLookup::Boundary { left, right } => (left, right),
        NeighborLookup::MidRun {
            entry_item_id,
            entry_idx,
            split_offset,
            parent_item_id,
            parent_idx,
        } => {
            // Split the entry row at `split_offset`. Existing row keeps its idx and becomes the
            // RIGHT half (preserving any children attached to the original idx). A new row is
            // INSERTed for the LEFT half with a fresh idx in (logical) original-item-position space.
            let entry = nodes
                .iter()
                .find(|n| n.item_id == entry_item_id && n.idx == entry_idx)
                .ok_or_else(|| String::from("internal: split entry not found"))?;
            let content = entry
                .content
                .clone()
                .ok_or_else(|| String::from("internal: split entry has no content"))?;
            let chars: Vec<char> = content.chars().collect();
            let l_text: String = chars.iter().take(split_offset).collect();
            let r_text: String = chars.iter().skip(split_offset).collect();
            // a = entry_idx - len + 1 (first index occupied by this entry's content)
            let a = entry_idx - (chars.len() as i32) + 1;
            let left_new_idx = a + (split_offset as i32) - 1;

            // UPDATE existing: content = right half
            update_row_content(db, &backing, row_pk, &entry_item_id, entry_idx, Some(&r_text))?;
            // INSERT new left half (same itemId, new idx, same parent)
            insert_node(
                db,
                &backing,
                row_pk,
                &entry_item_id,
                left_new_idx,
                Some(&l_text),
                &parent_item_id,
                parent_idx,
                /*or_ignore=*/ false,
            )
            .map_err(|_| String::from("failed to insert split left half"))?;
            split_writes = 2;

            // Update in-memory snapshot to reflect the split, so subsequent has_children logic is correct.
            // Mutate existing entry's content; push new left row.
            for n in nodes.iter_mut() {
                if n.item_id == entry_item_id && n.idx == entry_idx {
                    n.content = Some(r_text.clone());
                }
            }
            nodes.push(Node {
                item_id: entry_item_id.clone(),
                idx: left_new_idx,
                content: Some(l_text),
                parent_item_id: parent_item_id.clone(),
                parent_idx,
            });

            (
                Some(NodeRef {
                    item_id: entry_item_id.clone(),
                    idx: left_new_idx,
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
            let r_node = nodes
                .iter()
                .find(|n| n.item_id == rn.item_id && n.idx == rn.idx)
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
                            .find(|n| n.item_id == r.item_id && n.idx == r.idx)
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
                        // determined by item-id hex. #!~ Phase 6: walk to the deepest-rightmost
                        // descendant for stable end-of-doc append.
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
        entry_idx: i32,
        /// 0-based offset within the entry's content where the new content should land.
        split_offset: usize,
        parent_item_id: String,
        parent_idx: i32,
    },
}

fn find_neighbors_or_split(nodes: &[Node], position: i32) -> NeighborLookup {
    use alloc::collections::BTreeMap;
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

    let mut visible: Vec<&Node> = Vec::new();
    let mut stack: Vec<(String, i32)> = Vec::new();
    stack.push((String::new(), -2));
    walk_visible(&children, &mut stack, &mut visible);

    let mut consumed = 0i32;
    let mut left: Option<NodeRef> = None;
    for n in &visible {
        let len = n.content.as_ref().map(|s| s.chars().count() as i32).unwrap_or(0);
        if consumed >= position {
            return NeighborLookup::Boundary {
                left,
                right: Some(NodeRef {
                    item_id: n.item_id.clone(),
                    idx: n.idx,
                }),
            };
        }
        if consumed + len <= position {
            // entirely before — current becomes left
            left = Some(NodeRef {
                item_id: n.item_id.clone(),
                idx: n.idx,
            });
            consumed += len;
            continue;
        }
        // position strictly inside this run: consumed < position < consumed + len
        let split_offset = (position - consumed) as usize;
        return NeighborLookup::MidRun {
            entry_item_id: n.item_id.clone(),
            entry_idx: n.idx,
            split_offset,
            parent_item_id: n.parent_item_id.clone(),
            parent_idx: n.parent_idx,
        };
    }
    // Walked past everything — position is at/past end of doc.
    NeighborLookup::Boundary { left, right: None }
}

fn walk_visible<'a>(
    children: &alloc::collections::BTreeMap<(String, i32), Vec<&'a Node>>,
    stack: &mut Vec<(String, i32)>,
    out: &mut Vec<&'a Node>,
) {
    let Some(top) = stack.last().cloned() else {
        return;
    };
    if let Some(kids) = children.get(&top) {
        for kid in kids {
            let is_sentinel = kid.idx == -1;
            let is_tombstone = kid.content.is_none();
            if !is_sentinel && !is_tombstone {
                if let Some(s) = &kid.content {
                    if !s.is_empty() {
                        out.push(kid);
                    }
                }
            }
            stack.push((kid.item_id.clone(), kid.idx));
            walk_visible(children, stack, out);
            stack.pop();
        }
    }
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
    let stmt = db.prepare_v2(&sql).map_err(|_| String::from("prepare update"))?;
    match content {
        Some(s) => stmt.bind_text(1, s, Destructor::TRANSIENT).map_err(|_| String::from("bind content"))?,
        None => stmt.bind_null(1).map_err(|_| String::from("bind NULL"))?,
    };
    stmt.bind_int64(2, row_pk).map_err(|_| String::from("bind row_pk"))?;
    stmt.bind_text(3, item_id, Destructor::TRANSIENT).map_err(|_| String::from("bind itemId"))?;
    stmt.bind_int(4, idx).map_err(|_| String::from("bind idx"))?;
    stmt.step().map_err(|_| String::from("update step"))?;
    Ok(())
}

fn load_nodes(db: *mut sqlite3, backing: &str, row_pk: i64) -> Result<Vec<Node>, ResultCode> {
    let sql = format!(
        "SELECT itemId, idx, content, parentItemId, parentIdx \
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
        });
    }
    Ok(out)
}

/// Walk the Fugue tree in render order; return (left, right) neighbor refs around `position`.
///
/// `position` is 0-based rendered char offset. `position = 0` → no left, right is first visible.
/// `position >= total_chars` → left is last visible, no right.
fn find_neighbors_at(nodes: &[Node], position: i32) -> (Option<NodeRef>, Option<NodeRef>) {
    // Build children index: parent (item_id, idx) -> Vec<&Node>
    // Iterate roots (parent = "" / -2) in (itemId, idx) order, recurse depth-first.
    let visible = render_order(nodes);

    // Each visible entry is (NodeRef, char_count). Walk accumulating offsets.
    let mut consumed = 0i32;
    let mut left: Option<NodeRef> = None;
    for (node, len) in &visible {
        if consumed + *len > position {
            // The target position falls inside this run. For Fugue inserts, the relevant neighbors
            // are still (this-run-or-prior, this-run). #!~ Phase 6: split runs mid-content for
            // mid-run inserts. For Phase 2 we treat mid-run inserts as if at the start of this run.
            return (left, Some(node.clone()));
        }
        consumed += len;
        left = Some(node.clone());
    }
    (left, None) // position is at/past end of doc
}

/// Visible nodes in tree-walk order. Returns (ref, content.chars().count()) tuples.
fn render_order(nodes: &[Node]) -> Vec<(NodeRef, i32)> {
    // children index
    use alloc::collections::BTreeMap;
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

    let mut out = Vec::new();
    let mut stack: Vec<(String, i32)> = Vec::new();
    stack.push((String::new(), -2)); // root
    walk(&children, &mut stack, &mut out);
    out
}

fn walk(
    children: &alloc::collections::BTreeMap<(String, i32), Vec<&Node>>,
    stack: &mut Vec<(String, i32)>,
    out: &mut Vec<(NodeRef, i32)>,
) {
    let Some(top) = stack.last().cloned() else {
        return;
    };
    if let Some(kids) = children.get(&top) {
        for kid in kids {
            // skip sentinels in the *visible* projection (still recurse into their subtree)
            let is_sentinel = kid.idx == -1;
            let is_tombstone = kid.content.is_none();
            if !is_sentinel && !is_tombstone {
                let chars = kid.content.as_ref().map(|s| s.chars().count() as i32).unwrap_or(0);
                if chars > 0 {
                    out.push((
                        NodeRef {
                            item_id: kid.item_id.clone(),
                            idx: kid.idx,
                        },
                        chars,
                    ));
                }
            }
            stack.push((kid.item_id.clone(), kid.idx));
            walk(children, stack, out);
            stack.pop();
        }
    }
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
/// Site prefix lets future Case-1 extension recognize "our" items.
///
/// #!~ Phase 6: tighten to {site}.{monotonic_counter} for ordering stability
fn fresh_item_id(db: *mut sqlite3) -> Result<String, ResultCode> {
    let stmt = db.prepare_v2(
        "SELECT lower(hex(crsql_site_id())) || '_' || lower(hex(randomblob(6)))",
    )?;
    stmt.step()?;
    Ok(String::from(stmt.column_text(0)?))
}
