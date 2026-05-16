extern crate alloc;
use alloc::string::String;

pub fn escape_ident(ident: &str) -> String {
    ident.replace('"', "\"\"")
}

pub fn escape_sql_lit(s: &str) -> String {
    s.replace('\'', "''")
}

/// `{name}__tree_ops` — CRDT-replicated raw moves.
pub fn ops_table(name: &str) -> String {
    let mut s = String::from(name);
    s.push_str("__tree_ops");
    s
}

/// `{name}__tree_log` — local-only apply-time snapshot.
pub fn log_table(name: &str) -> String {
    let mut s = String::from(name);
    s.push_str("__tree_log");
    s
}

/// `{name}__tree_state` — materialized current parent-of relation.
pub fn state_table(name: &str) -> String {
    let mut s = String::from(name);
    s.push_str("__tree_state");
    s
}

/// Validate a registered tree name. Conservative: identifier chars only.
/// Keeps double-quote escaping pure-defensive; rejects anything we wouldn't
/// want auto-substituted into table names + index names.
pub fn validate_tree_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err(String::from("tree name must be non-empty"));
    }
    if name.len() > 64 {
        return Err(String::from("tree name must be <= 64 chars"));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(String::from(
            "tree name must start with an ASCII letter or underscore",
        ));
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return Err(String::from(
                "tree name may only contain ASCII letters, digits, and underscores",
            ));
        }
    }
    Ok(())
}
