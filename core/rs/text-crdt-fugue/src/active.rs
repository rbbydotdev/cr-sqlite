extern crate alloc;
use alloc::string::String;
use sqlite::{sqlite3, Connection};
use sqlite_nostd as sqlite;

/// Increment the per-connection "active fugue function" counter. While counter > 0,
/// per-row render triggers on backing tables are suppressed via their `WHEN` clause,
/// so a single fugue_* call doing N row mutations doesn't pay N renders.
///
/// The counter survives across nested calls (e.g. fugue_cleanup invoked from fugue_insert)
/// so each call must pair its enter/exit.
pub(crate) fn enter(db: *mut sqlite3) -> Result<(), String> {
    db.exec_safe("UPDATE __crsql_fugue_active SET counter = counter + 1 WHERE id = 1")
        .map_err(|_| String::from("failed to bump active counter"))?;
    Ok(())
}

pub(crate) fn exit(db: *mut sqlite3) -> Result<(), String> {
    db.exec_safe("UPDATE __crsql_fugue_active SET counter = counter - 1 WHERE id = 1")
        .map_err(|_| String::from("failed to decrement active counter"))?;
    Ok(())
}

/// Run a closure with the counter bumped. Exit is called even if the body fails,
/// matching SQL transaction-savepoint semantics.
pub(crate) fn with_active<T>(
    db: *mut sqlite3,
    f: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    enter(db)?;
    let res = f();
    let exit_res = exit(db);
    // Bubble up the body's result first; exit-failure shouldn't mask it.
    let val = res?;
    exit_res?;
    Ok(val)
}
