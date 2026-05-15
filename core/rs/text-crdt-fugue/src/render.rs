extern crate alloc;
use alloc::collections::BTreeMap;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{args, context, sqlite3, Connection, Context, Destructor, ResultCode, Value};
use sqlite_nostd as sqlite;

use crate::util::{backing_table_name, escape_ident};

const ROOT_ITEM: &str = "";
const ROOT_IDX: i32 = -2;

/// Engine-reserved prefix for deletion-marker rows. A marker is a tombstoned
/// child whose `content` holds the deleted text and whose `parent_idx` is the
/// LAST char of the covered range in the parent. Markers carry no own content
/// in the render output — they just hide a span of their parent's chars.
const DELETION_MARKER_PREFIX: &str = "DM_";

fn is_deletion_marker(row: &Row) -> bool {
    row.tombstoned && row.item_id.starts_with(DELETION_MARKER_PREFIX)
}

#[derive(Clone, Debug)]
struct Row {
    item_id: String,
    idx: i32,
    content: String,
    parent_item_id: String,
    parent_idx: i32,
    tombstoned: bool,
}

/// Force-recompute the parent column for a single row_pk from the Fugue backing rows.
/// Called by fugue_insert/delete/cleanup at end-of-function (after their writes have
/// been bracketed by active-counter so per-row triggers were suppressed) and by
/// crsql_fugue_flush for explicit refresh paths.
pub(crate) fn rerender_parent_column(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: &[u8],
) -> Result<(), String> {
    let rendered = compute_render(db, table, column, row_pk)?;
    let pk_col = crate::registration::parent_pk_column(db, table)?;
    let sql = format!(
        "UPDATE \"{parent}\" SET \"{col}\" = ? WHERE \"{pk}\" = ?",
        parent = escape_ident(table),
        col = escape_ident(column),
        pk = escape_ident(&pk_col),
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare rerender"))?;
    stmt.bind_text(1, &rendered, Destructor::TRANSIENT)
        .map_err(|_| String::from("bind rendered"))?;
    crate::row_pk::bind(&stmt, 2, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;
    stmt.step().map_err(|_| String::from("rerender step"))?;
    Ok(())
}

/// SQL function `crsql_fugue_flush(table, col, row_pk)`: force a parent-column refresh
/// from the current backing-table state. Useful after applying sync changes via
/// `crsql_changes` (which bypass our `crsql_fugue_*` function entry points) on a
/// defer-mode column.
///
/// In eager-mode columns, calling flush is harmless but redundant — the AFTER INSERT/UPDATE
/// triggers have already kept the parent column fresh.
pub fn fugue_flush(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_fugue_flush requires 3 args: (table, column, row_pk)");
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = match crate::row_pk::from_value(arg_slice[2]) {
        Ok(pk) => pk,
        Err(msg) => {
            ctx.result_error(&msg);
            return;
        }
    };
    let db = ctx.db_handle();

    if let Err(msg) = rerender_parent_column(db, table, column, &row_pk) {
        ctx.result_error(&msg);
    }
}

/// SQL function `crsql_fugue_render(table, col, row_pk) → TEXT`.
///
/// Returns the current rendered text for a Fugue-backed column by walking the
/// backing table directly. Reads are O(text_length + rows × siblings) per render.
///
/// The materialized parent column is kept fresh by per-row triggers in transparent
/// mode (and the clock-untrack trigger prevents the body column from being shipped
/// as a CRR cell, so there is no longer a render-cascade), so most callers can use
/// `SELECT body FROM ...` directly. This function exists for tests, debugging, and
/// any caller that wants a guaranteed-fresh read without depending on triggers.
pub fn fugue_render(
    ctx: *mut context,
    argc: i32,
    argv: *mut *mut sqlite::value,
) {
    let arg_slice = args!(argc, argv);
    if arg_slice.len() != 3 {
        ctx.result_error("crsql_fugue_render requires 3 args: (table, column, row_pk)");
        return;
    }
    let table = arg_slice[0].text();
    let column = arg_slice[1].text();
    let row_pk = match crate::row_pk::from_value(arg_slice[2]) {
        Ok(pk) => pk,
        Err(msg) => {
            ctx.result_error(&msg);
            return;
        }
    };
    let db = ctx.db_handle();

    match compute_render(db, table, column, &row_pk) {
        Ok(s) => ctx.result_text_transient(&s),
        Err(msg) => ctx.result_error(&msg),
    }
}

/// β-flat procedural render. Loads all backing rows for `row_pk`, then walks the
/// Fugue tree in-order, interleaving mid-content children at their `parentIdx`
/// positions.
///
/// For canonical trees (every child has `parentIdx == parent.idx`, i.e. attaches
/// after the parent's last char), this produces the same output as the old
/// recursive-CTE renderer. For β-flat trees, where a child can attach inside a
/// multi-char parent's content range, it interleaves correctly — the CTE version
/// would silently drop such children because its join required exact-idx match.
fn compute_render(
    db: *mut sqlite3,
    table: &str,
    column: &str,
    row_pk: &[u8],
) -> Result<String, String> {
    let backing = backing_table_name(table, column);
    let backing_esc = escape_ident(&backing);

    let rows = load_rows(db, &backing_esc, row_pk)?;
    let by_parent = group_children_by_parent(&rows);

    let mut out = String::new();
    walk_root_children(&by_parent, &mut out);
    Ok(out)
}

/// SELECT every row for this doc — one round-trip rather than a recursive
/// per-edge join.
fn load_rows(db: *mut sqlite3, backing_esc: &str, row_pk: &[u8]) -> Result<Vec<Row>, String> {
    let sql = format!(
        "SELECT itemId, idx, content, parentItemId, parentIdx, tombstoned \
           FROM \"{}\" WHERE row_pk = ?",
        backing_esc
    );
    let stmt = db
        .prepare_v2(&sql)
        .map_err(|_| String::from("prepare load rows"))?;
    crate::row_pk::bind(&stmt, 1, row_pk)
        .map_err(|_| String::from("bind row_pk"))?;

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

/// Group rows by their `parent_item_id` so we can find children in O(1) per
/// parent during the walk. Within each group children are sorted by
/// (`parent_idx`, `item_id`, `idx`) so siblings at the same attachment position
/// emit in deterministic Fugue tie-break order.
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

/// One unit of pending work for the iterative walker. `Emit` pushes a char
/// onto the output; `Walk` expands a node into its own sequence of emits +
/// child-walks at the moment it's popped. The expansion is lazy so the
/// stack stays bounded — for the β-flat linear chain (each char's parent
/// is the previous char) the live stack holds at most 2 entries at a
/// time, instead of 1 native call frame per char.
///
/// Why this matters: β-flat documents of N visible chars produce a tree
/// of depth N. The previous recursive `walk_node` hit the OS thread stack
/// around N≈100k. With an explicit stack the limit becomes available
/// heap, which is gigabytes.
enum Todo<'a> {
    Emit(char),
    Walk(&'a Row),
}

fn walk_root_children<'a>(
    by_parent: &BTreeMap<&'a str, Vec<&'a Row>>,
    out: &mut String,
) {
    let mut stack: Vec<Todo<'a>> = Vec::new();
    if let Some(kids) = by_parent.get(ROOT_ITEM) {
        // Push in reverse so popping gives forward order.
        for kid in kids.iter().filter(|r| r.parent_idx == ROOT_IDX).rev() {
            stack.push(Todo::Walk(*kid));
        }
    }
    while let Some(todo) = stack.pop() {
        match todo {
            Todo::Emit(c) => out.push(c),
            Todo::Walk(node) => {
                let actions = expand_node(node, by_parent);
                for a in actions.into_iter().rev() {
                    stack.push(a);
                }
            }
        }
    }
}

/// Compute the action sequence for one node: at each absolute char position
/// covered by `node.content`, emit the char (if the node is visible and the
/// position isn't covered by a deletion marker), then queue child-walks
/// whose `parent_idx` lands on that position.
///
/// Deletion-marker children (β-flat partial-delete encoding) suppress
/// emission of the parent chars in the covered range. Markers are pre-
/// scanned before the char walk to build a `covered_positions` set.
///
/// Sentinel rows (`idx == -1`, used by Case-3 insertion logic) and other
/// empty-content rows have no chars to emit; the single visit position
/// becomes `node.idx` so children attached there still run.
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

    // Pre-scan markers to build the set of parent chars they cover. A
    // marker's `parent_idx` is the LAST covered position; its content
    // length is the span.
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
            actions.push(Todo::Emit(*ch));
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
