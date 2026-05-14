extern crate alloc;
use alloc::string::String;

pub fn escape_ident(ident: &str) -> String {
    ident.replace('"', "\"\"")
}

/// Name of the Fugue backing table for a (parent_table, column) pair.
pub fn backing_table_name(table: &str, column: &str) -> String {
    let mut s = String::from("__crsql_fugue_");
    s.push_str(table);
    s.push('_');
    s.push_str(column);
    s
}
