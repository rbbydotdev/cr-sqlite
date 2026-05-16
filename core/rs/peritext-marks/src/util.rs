extern crate alloc;
use alloc::string::String;

/// Reserved sentinel itemIds used to anchor marks at the very start or
/// very end of a document. Encoded as TEXT itemIds with a leading sigil
/// that's invalid for any Fugue-generated itemId, so they never collide.
pub const ANCHOR_START: &str = "\u{0001}__peritext_start__";
pub const ANCHOR_END: &str = "\u{0001}__peritext_end__";

pub const SIDE_BEFORE: i64 = 0;
pub const SIDE_AFTER: i64 = 1;

/// `__crsql_peritext_{table}_{column}_marks` — the CRR op-log for marks.
pub fn marks_table_name(table: &str, column: &str) -> String {
    let mut s = String::from("__crsql_peritext_");
    s.push_str(table);
    s.push('_');
    s.push_str(column);
    s.push_str("_marks");
    s
}

/// `__crsql_peritext_meta` — single shared metadata table keyed by
/// (table, column). Holds the additive-mark-name list for each
/// registered column. One table for the whole DB; not per-column.
pub const META_TABLE: &str = "__crsql_peritext_meta";

/// Validate that a string is safe to embed in an identifier name.
/// Used for the parent table/column names that get pasted into the
/// marks table name + trigger names.
pub fn validate_ident(s: &str, label: &str) -> Result<(), String> {
    if s.is_empty() {
        let mut msg = String::from(label);
        msg.push_str(" must be non-empty");
        return Err(msg);
    }
    for c in s.chars() {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            let mut msg = String::from(label);
            msg.push_str(" may only contain ASCII letters, digits, and underscores");
            return Err(msg);
        }
    }
    Ok(())
}
