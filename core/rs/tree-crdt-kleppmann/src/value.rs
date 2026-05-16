extern crate alloc;
use alloc::string::String;
use alloc::vec::Vec;
use sqlite::{value, ColumnType, Destructor, ManagedStmt, ResultCode, Stmt, Value};
use sqlite_nostd as sqlite;

/// Storage-class-preserving snapshot of a SQLite value, owned by Rust.
///
/// We need this because the tree CRDT must shuttle opaque user values
/// (node_ids, parents, meta) through Rust between SELECTs and INSERTs.
/// The sqlite3_value pointers themselves are owned by the statement step
/// and invalidated on the next step, so we have to copy out.
///
/// Equality is strict on storage class — Int(42) != Text("42"). The CRDT
/// uses this only to decide self-parent (node_id == new_parent) which must
/// reject silently, so strictness is what we want.
#[derive(Clone, Debug, PartialEq)]
pub enum OwnedValue {
    Null,
    Int(i64),
    Float(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl OwnedValue {
    pub fn from_value(v: *mut value) -> Self {
        if v.is_null() {
            return OwnedValue::Null;
        }
        match v.value_type() {
            ColumnType::Null => OwnedValue::Null,
            ColumnType::Integer => OwnedValue::Int(v.int64()),
            ColumnType::Float => OwnedValue::Float(v.double()),
            ColumnType::Text => OwnedValue::Text(String::from(v.text())),
            ColumnType::Blob => OwnedValue::Blob(Vec::from(v.blob())),
        }
    }

    pub fn from_column(stmt: &ManagedStmt, col: i32) -> Result<Self, ResultCode> {
        match stmt.column_type(col)? {
            ColumnType::Null => Ok(OwnedValue::Null),
            ColumnType::Integer => Ok(OwnedValue::Int(stmt.column_int64(col))),
            ColumnType::Float => Ok(OwnedValue::Float(stmt.column_double(col))),
            ColumnType::Text => Ok(OwnedValue::Text(String::from(stmt.column_text(col)?))),
            ColumnType::Blob => Ok(OwnedValue::Blob(Vec::from(stmt.column_blob(col)?))),
        }
    }

    pub fn bind(&self, stmt: &ManagedStmt, idx: i32) -> Result<ResultCode, ResultCode> {
        match self {
            OwnedValue::Null => stmt.bind_null(idx),
            OwnedValue::Int(n) => stmt.bind_int64(idx, *n),
            // ManagedStmt has no direct bind_double — go through the
            // Stmt trait on the inner *mut stmt.
            OwnedValue::Float(f) => stmt.stmt.bind_double(idx, *f),
            OwnedValue::Text(s) => stmt.bind_text(idx, s, Destructor::TRANSIENT),
            OwnedValue::Blob(b) => stmt.bind_blob(idx, b, Destructor::TRANSIENT),
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, OwnedValue::Null)
    }
}
