extern crate alloc;
use alloc::string::String;

/// Well-known sentinel IDs.
pub const ROOT_HEX: &str = "01";   // → X'01'
pub const TRASH_HEX: &str = "ff";  // → X'ff'

/// SQL string literal escape (single-quote double).
pub fn esc_lit(s: &str) -> String {
    s.replace('\'', "''")
}
