//! Canonical encoding for the parent-row primary key.
//!
//! A `RowPk` (=`Vec<u8>`) is the type-tagged byte form of whatever value the
//! caller passed as the row_pk argument: INTEGER, TEXT, or BLOB. Each variant
//! gets a leading tag byte so values of different SQL types never collide:
//!
//!   INTEGER  →  0x01 + 8 big-endian bytes (i64)
//!   TEXT     →  0x02 + UTF-8 bytes
//!   BLOB     →  0x03 + raw bytes
//!
//! Why a canonical Rust form when the backing column already stores natively?
//! Two reasons:
//!   * Cache keying — BTreeMap<(String, Vec<u8>), DocCache> needs an owned,
//!     hashable type. SQLite values aren't 'static.
//!   * Equality — same input value always produces the same bytes, so
//!     `Vec<u8>` equality is logical row equality.
//!
//! At the SQL boundary we decode the tag and dispatch to bind_int64 /
//! bind_text / bind_blob so the value lands in the backing table as the
//! caller's original SQL type. BLOB affinity on the column keeps it that
//! way (no coercion).

extern crate alloc;
use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use sqlite_nostd as sqlite;
use sqlite::{value, ColumnType, Destructor, ManagedStmt, ResultCode, Value};

pub(crate) const TAG_INT: u8 = 0x01;
pub(crate) const TAG_TEXT: u8 = 0x02;
pub(crate) const TAG_BLOB: u8 = 0x03;

/// Encode a sqlite3_value (from a UDF argument) into the canonical row_pk
/// form. Errors on NULL/REAL — primary keys can't be either.
pub(crate) fn from_value(v: *mut value) -> Result<Vec<u8>, String> {
    if v.is_null() {
        return Err(String::from("row_pk argument is null pointer"));
    }
    match v.value_type() {
        ColumnType::Integer => Ok(from_i64(v.int64())),
        ColumnType::Text => Ok(from_text(v.text())),
        ColumnType::Blob => Ok(from_blob(v.blob())),
        ColumnType::Null => Err(String::from("row_pk cannot be NULL")),
        ColumnType::Float => {
            Err(String::from("row_pk cannot be REAL — use INTEGER, TEXT, or BLOB"))
        }
    }
}

/// Encode a stmt column into the canonical form. Used when we read row_pk
/// back out of the backing table for cache refresh, etc.
#[allow(dead_code)]
pub(crate) fn from_column(stmt: &ManagedStmt, col: i32) -> Result<Vec<u8>, ResultCode> {
    match stmt.column_type(col)? {
        ColumnType::Integer => Ok(from_i64(stmt.column_int64(col))),
        ColumnType::Text => Ok(from_text(stmt.column_text(col)?)),
        ColumnType::Blob => Ok(from_blob(stmt.column_blob(col)?)),
        _ => Err(ResultCode::ERROR),
    }
}

pub(crate) fn from_i64(n: i64) -> Vec<u8> {
    let mut out = Vec::with_capacity(9);
    out.push(TAG_INT);
    out.extend_from_slice(&n.to_be_bytes());
    out
}

pub(crate) fn from_text(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() + 1);
    out.push(TAG_TEXT);
    out.extend_from_slice(bytes);
    out
}

pub(crate) fn from_blob(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len() + 1);
    out.push(TAG_BLOB);
    out.extend_from_slice(b);
    out
}

/// Bind a canonical row_pk to a prepared statement parameter, decoding the
/// tag and dispatching to the right typed bind so the value lands in the
/// backing table as INTEGER / TEXT / BLOB respectively.
pub(crate) fn bind(
    stmt: &ManagedStmt,
    idx: i32,
    pk: &[u8],
) -> Result<ResultCode, ResultCode> {
    if pk.is_empty() {
        return Err(ResultCode::ERROR);
    }
    match pk[0] {
        TAG_INT => {
            if pk.len() != 9 {
                return Err(ResultCode::ERROR);
            }
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&pk[1..9]);
            stmt.bind_int64(idx, i64::from_be_bytes(bytes))
        }
        TAG_TEXT => {
            let s = core::str::from_utf8(&pk[1..]).map_err(|_| ResultCode::ERROR)?;
            stmt.bind_text(idx, s, Destructor::TRANSIENT)
        }
        TAG_BLOB => stmt.bind_blob(idx, &pk[1..], Destructor::TRANSIENT),
        _ => Err(ResultCode::ERROR),
    }
}

/// Human-readable debug repr — used in error messages.
pub(crate) fn show(pk: &[u8]) -> String {
    if pk.is_empty() {
        return String::from("<empty>");
    }
    match pk[0] {
        TAG_INT if pk.len() == 9 => {
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&pk[1..9]);
            format!("int({})", i64::from_be_bytes(bytes))
        }
        TAG_TEXT => match core::str::from_utf8(&pk[1..]) {
            Ok(s) => format!("text({:?})", s),
            Err(_) => format!("text(<{} invalid bytes>)", pk.len() - 1),
        },
        TAG_BLOB => format!("blob({} bytes)", pk.len() - 1),
        t => format!("<unknown tag 0x{:02x}, {} bytes>", t, pk.len()),
    }
}

