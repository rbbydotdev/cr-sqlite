//! Iterative Fugue β-flat walker that emits `(itemId, char)` tuples in
//! render order.
//!
//! Why duplicate text-crdt-fugue's walker? That walker emits chars only —
//! Peritext needs the itemId per char so anchor positions can be resolved.
//! Logic is otherwise identical; if we ever refactor, the shared module
//! would live in text-crdt-fugue.

extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use crsql_text_crdt_fugue::{backing_table_name, escape_ident, row_pk as fugue_row_pk};
use sqlite::{sqlite3, Connection, ResultCode};
use sqlite_nostd as sqlite;

const ROOT_ITEM: &str = "";
const ROOT_IDX: i32 = -2;
const DELETION_MARKER_PREFIX: &str = "DM_";

#[derive(Clone, Debug)]
struct Row {
    item_id: String,
    idx: i32,
    content: String,
    parent_item_id: String,
    parent_idx: i32,
    tombstoned: bool,
}

fn is_deletion_marker(row: &Row) -> bool {
    row.tombstoned && row.item_id.starts_with(DELETION_MARKER_PREFIX)
}

/// One visible char + its stable identity in the backing table.
///
/// Fugue β-flat compresses runs of consecutive characters into a single
/// row with content = run, idx = last char's abs index. So a char's
/// stable identity is `(item_id, idx)` where `idx` is its absolute
/// position-index within the row's content (matching the row's `idx`
/// column for the last char, `idx - len + 1` for the first).
///
/// Peritext anchors are (item_id, idx, side) — same triple used by the
/// paper's algorithm but adapted to multi-char rows.
pub struct Visible {
    pub item_id: String,
    pub idx: i32,
    pub ch: char,
}

/// Walk the Fugue backing rows for `(table, column, row_pk)` and produce
/// the visible character sequence in render order.
pub fn walk(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: &[u8],
) -> Result<Vec<Visible>, String> {
    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);
    let rows = load_rows(db, &backing_esc, row_pk)?;
    let by_parent = group_children_by_parent(&rows);

    let mut out: Vec<Visible> = Vec::new();
    walk_root_children(&by_parent, &mut out);
    Ok(out)
}

fn load_rows(
    db: *mut sqlite3,
    backing_esc: &str,
    row_pk: &[u8],
) -> Result<Vec<Row>, String> {
    let sql = format!(
        "SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned \
           FROM \"{}\" WHERE row_pk = ?",
        backing_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare load rows"))?;
    fugue_row_pk::bind(&stmt, 1, row_pk).map_err(|_| String::from("bind row_pk"))?;

    let mut rows = Vec::new();
    loop {
        match stmt.step().map_err(|_| String::from("step load rows"))? {
            ResultCode::ROW => {
                let content = match stmt.column_text(2) {
                    Ok(s) => String::from(s),
                    Err(_) => String::new(),
                };
                let parent_item_id = match stmt.column_text(3) {
                    Ok(s) => String::from(s),
                    Err(_) => String::new(),
                };
                rows.push(Row {
                    item_id: String::from(
                        stmt.column_text(0).map_err(|_| String::from("itemId"))?,
                    ),
                    idx: stmt.column_int(1),
                    content,
                    parent_item_id,
                    parent_idx: stmt.column_int(4),
                    tombstoned: stmt.column_int(5) != 0,
                });
            }
            _ => break,
        }
    }
    Ok(rows)
}

fn group_children_by_parent<'a>(rows: &'a [Row]) -> BTreeMap<&'a str, Vec<&'a Row>> {
    let mut by_parent: BTreeMap<&'a str, Vec<&'a Row>> = BTreeMap::new();
    for r in rows {
        by_parent
            .entry(r.parent_item_id.as_str())
            .or_default()
            .push(r);
    }
    for v in by_parent.values_mut() {
        v.sort_by(|a, b| {
            a.parent_idx
                .cmp(&b.parent_idx)
                .then_with(|| a.item_id.cmp(&b.item_id))
                .then_with(|| a.idx.cmp(&b.idx))
        });
    }
    by_parent
}

enum Todo<'a> {
    EmitChar(&'a str, i32, char), // (item_id, abs_idx, char)
    Walk(&'a Row),
}

fn walk_root_children<'a>(
    by_parent: &BTreeMap<&'a str, Vec<&'a Row>>,
    out: &mut Vec<Visible>,
) {
    let mut stack: Vec<Todo<'a>> = Vec::new();
    if let Some(kids) = by_parent.get(ROOT_ITEM) {
        for kid in kids.iter().filter(|r| r.parent_idx == ROOT_IDX).rev() {
            stack.push(Todo::Walk(*kid));
        }
    }
    while let Some(todo) = stack.pop() {
        match todo {
            Todo::EmitChar(iid, idx, c) => out.push(Visible {
                item_id: String::from(iid),
                idx,
                ch: c,
            }),
            Todo::Walk(node) => {
                let actions = expand_node(node, by_parent);
                for a in actions.into_iter().rev() {
                    stack.push(a);
                }
            }
        }
    }
}

fn expand_node<'a>(
    node: &'a Row,
    by_parent: &BTreeMap<&'a str, Vec<&'a Row>>,
) -> Vec<Todo<'a>> {
    let chars: Vec<char> = node.content.chars().collect();
    let kids = by_parent.get(node.item_id.as_str());
    let mut actions: Vec<Todo<'a>> = Vec::new();

    if chars.is_empty() {
        if let Some(kids_v) = kids {
            for kid in kids_v.iter().filter(|k| k.parent_idx == node.idx) {
                actions.push(Todo::Walk(*kid));
            }
        }
        return actions;
    }

    let n_chars = chars.len() as i32;
    let first_idx = node.idx - n_chars + 1;

    let mut covered_set: alloc::collections::BTreeSet<i32> =
        alloc::collections::BTreeSet::new();
    if let Some(kids_v) = kids {
        for kid in kids_v.iter() {
            if is_deletion_marker(kid)
                && kid.parent_idx >= first_idx
                && kid.parent_idx <= node.idx
            {
                let span = kid.content.chars().count() as i32;
                let start = (kid.parent_idx - span + 1).max(first_idx);
                let end = kid.parent_idx;
                for p in start..=end {
                    covered_set.insert(p);
                }
            }
        }
    }

    for (offset, ch) in chars.iter().enumerate() {
        let abs_idx = first_idx + (offset as i32);
        if !node.tombstoned && node.idx != -1 && !covered_set.contains(&abs_idx) {
            actions.push(Todo::EmitChar(node.item_id.as_str(), abs_idx, *ch));
        }
        if let Some(kids_v) = kids {
            for kid in kids_v
                .iter()
                .filter(|k| k.parent_idx == abs_idx && !is_deletion_marker(k))
            {
                actions.push(Todo::Walk(*kid));
            }
        }
    }
    actions
}
