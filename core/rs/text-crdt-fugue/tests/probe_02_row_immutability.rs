//! Probe 02 — row immutability monitor.
//!
//! Drives the built `crsqlite.dylib` (compiled with `--features debug-monitor`)
//! through a SQLite CLI host that supports both `load_extension` and
//! `sqlite3_preupdate_hook`. Exercises:
//!
//!   1. Legal `crsql_fugue_insert` — must NOT panic.
//!   2. Legal `crsql_fugue_delete` (tombstone flip 0→1) — must NOT panic.
//!   3. Direct illegal UPDATE on a backing-table row's `content` column —
//!      MUST panic with a clear message identifying table, row, columns, and
//!      old/new values. The dylib's panic_handler calls `abort()`, so the
//!      child sqlite3 process dies with signal SIGABRT (status 134/133/etc).
//!
//! ## Why a CLI subprocess
//!
//! The natural Rust path would be `rusqlite` + `libsqlite3-sys` with the
//! `preupdate_hook` feature, but newer versions of those crates pull in
//! transitive deps requiring Rust edition 2024 — incompatible with this
//! workspace's pinned `nightly-2023-10-05`. Rather than introduce a separate
//! toolchain pin (or a heavy build.rs that re-compiles sqlite3.c), we shell
//! out to a host SQLite CLI. The test discovers an acceptable CLI at runtime
//! and skips with a clear message when none is present.
//!
//! Discovery order:
//!   1. `LW_PROBE_SQLITE3` env override (explicit user pick).
//!   2. `/opt/homebrew/opt/sqlite/bin/sqlite3` (macOS / homebrew).
//!   3. `sqlite3` on PATH (only if its compile options include both
//!      `ENABLE_PREUPDATE_HOOK` and NOT `OMIT_LOAD_EXTENSION`).
//!
//! ## Dylib build prerequisite
//!
//! Run before `cargo test`:
//!
//! ```sh
//! cd core && make clean && make loadable debug_monitor_feature=,debug-monitor
//! ```
//!
//! Without that build the test will fail loudly explaining what to do.

use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const PANIC_TAG: &str = "[debug-monitor]";

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent() // rs
        .and_then(|p| p.parent()) // core
        .map(|p| p.to_path_buf())
        .expect("manifest must be under .../core/rs/text-crdt-fugue")
}

fn dylib_path() -> PathBuf {
    let ext = if cfg!(target_os = "macos") {
        "dylib"
    } else if cfg!(target_os = "windows") {
        "dll"
    } else {
        "so"
    };
    workspace_root().join("dist").join(format!("crsqlite.{ext}"))
}

/// Find an sqlite3 CLI capable of `load_extension` and `preupdate_hook`. Returns
/// `Err(msg)` if none is suitable, with an actionable hint.
fn discover_sqlite3() -> Result<PathBuf, String> {
    if let Ok(p) = env::var("LW_PROBE_SQLITE3") {
        let path = PathBuf::from(&p);
        if !path.exists() {
            return Err(format!(
                "LW_PROBE_SQLITE3 points at {p} which does not exist"
            ));
        }
        return Ok(path);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from("/opt/homebrew/opt/sqlite/bin/sqlite3"));
        candidates.push(PathBuf::from("/usr/local/opt/sqlite/bin/sqlite3"));
    }
    // PATH lookup last — many systems ship a stripped-down sqlite3.
    if let Ok(s) = env::var("PATH") {
        for dir in s.split(':') {
            let p = Path::new(dir).join("sqlite3");
            if p.exists() {
                candidates.push(p);
            }
        }
    }

    let mut errors = Vec::new();
    for c in &candidates {
        if !c.exists() {
            continue;
        }
        match sqlite3_has_required_features(c) {
            Ok(true) => return Ok(c.clone()),
            Ok(false) => errors.push(format!(
                "{} lacks required compile options (ENABLE_PREUPDATE_HOOK & !OMIT_LOAD_EXTENSION)",
                c.display()
            )),
            Err(e) => errors.push(format!("{}: {e}", c.display())),
        }
    }

    Err(format!(
        "no suitable sqlite3 CLI found. Tried:\n  {}\n\n\
         install homebrew sqlite (`brew install sqlite`) or set LW_PROBE_SQLITE3 \
         to a sqlite3 binary that has ENABLE_PREUPDATE_HOOK and supports \
         load_extension.",
        errors.join("\n  "),
    ))
}

fn sqlite3_has_required_features(bin: &Path) -> Result<bool, String> {
    let out = Command::new(bin)
        .arg(":memory:")
        .arg("PRAGMA compile_options")
        .output()
        .map_err(|e| format!("could not run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "exit {:?}, stderr: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let txt = String::from_utf8_lossy(&out.stdout);
    let has_preupdate = txt.lines().any(|l| l.trim() == "ENABLE_PREUPDATE_HOOK");
    let omits_load = txt.lines().any(|l| l.trim() == "OMIT_LOAD_EXTENSION");
    Ok(has_preupdate && !omits_load)
}

/// Run `sql` against the host sqlite3 CLI; returns the captured Output (so
/// callers can inspect status + stderr).
fn run_sql(sqlite3_bin: &Path, dylib: &Path, sql: &str) -> Output {
    // `.load` must NOT share an argument with SQL — the CLI parses the next
    // token as an entry-point name. Pass it via `-cmd` separately, then the
    // SQL via a second positional argument.
    let dylib_stem = {
        let s = dylib.to_string_lossy();
        match s.rsplit_once('.') {
            Some((stem, _ext)) => stem.to_string(),
            None => s.to_string(),
        }
    };
    Command::new(sqlite3_bin)
        .arg(":memory:")
        .arg("-cmd")
        .arg(format!(".load {dylib_stem}"))
        .arg(sql)
        .output()
        .expect("run sqlite3 subprocess")
}

fn assert_dylib_built() {
    let p = dylib_path();
    assert!(
        p.exists(),
        "missing built dylib at {}.\n\nBuild it first:\n  \
         cd core && make clean && make loadable debug_monitor_feature=,debug-monitor",
        p.display()
    );
}

fn host() -> Option<PathBuf> {
    match discover_sqlite3() {
        Ok(p) => Some(p),
        Err(msg) => {
            // Print to stderr so `cargo test -- --nocapture` shows the reason.
            eprintln!("[probe_02 SKIP] {msg}");
            None
        }
    }
}

/// Standard setup statements: install monitor, create CRR, register fugue
/// column, insert the parent row.
const SETUP_SQL: &str = "\
SELECT crsql_fugue_install_monitor();\n\
CREATE TABLE notes (id INTEGER PRIMARY KEY NOT NULL, body TEXT);\n\
SELECT crsql_as_crr('notes');\n\
SELECT crsql_as_text_crdt('notes', 'body');\n\
INSERT INTO notes (id, body) VALUES (1, '');";

fn assert_clean_run(out: &Output, what: &str) {
    if !out.status.success() {
        panic!(
            "{what} failed unexpectedly.\n  status: {:?}\n  stdout:\n{}\n  stderr:\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !combined.contains(PANIC_TAG),
        "{what} unexpectedly tripped the monitor.\n  output:\n{combined}",
    );
}

#[test]
fn legal_insert_does_not_panic() {
    assert_dylib_built();
    let Some(bin) = host() else { return };
    let dylib = dylib_path();
    let out = run_sql(
        &bin,
        &dylib,
        &format!(
            "{SETUP_SQL}\nSELECT crsql_fugue_insert('notes','body',1,0,'a');\nSELECT crsql_finalize();"
        ),
    );
    assert_clean_run(&out, "legal insert");
}

#[test]
fn legal_delete_does_not_panic() {
    assert_dylib_built();
    let Some(bin) = host() else { return };
    let dylib = dylib_path();
    let out = run_sql(
        &bin,
        &dylib,
        &format!(
            "{SETUP_SQL}\n\
             SELECT crsql_fugue_insert('notes','body',1,0,'x');\n\
             SELECT crsql_fugue_delete('notes','body',1,0,1);\n\
             SELECT crsql_finalize();"
        ),
    );
    assert_clean_run(&out, "legal tombstone delete");
}

#[test]
fn illegal_content_update_panics_with_clear_message() {
    assert_dylib_built();
    let Some(bin) = host() else { return };
    let dylib = dylib_path();
    let out = run_sql(
        &bin,
        &dylib,
        &format!(
            "{SETUP_SQL}\n\
             SELECT crsql_fugue_insert('notes','body',1,0,'a');\n\
             -- The mutation the monitor must catch: change content of an\n\
             -- existing backing row to something else.\n\
             UPDATE __crsql_fugue_notes_body SET content = 'ZZZ' WHERE row_pk = 1;\n\
             SELECT 'unreachable';"
        ),
    );

    // The dylib aborts → process exits with a signal-derived non-zero status.
    assert!(
        !out.status.success(),
        "expected sqlite3 to abort after the illegal UPDATE, got success.\n\
         stdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        combined.contains(PANIC_TAG),
        "child output should contain monitor panic tag {PANIC_TAG}.\n\
         output:\n{combined}",
    );
    assert!(
        combined.contains("row immutability"),
        "panic should mention `row immutability`. output:\n{combined}",
    );
    assert!(
        combined.contains("__crsql_fugue_notes_body"),
        "panic should name the offending backing table. output:\n{combined}",
    );
    assert!(
        combined.contains("content"),
        "panic should name the changed column. output:\n{combined}",
    );
    assert!(
        combined.contains("\"a\"") && combined.contains("\"ZZZ\""),
        "panic should show OLD and NEW values. output:\n{combined}",
    );
    // The marker that ANY post-UPDATE statement runs would mean the abort
    // didn't fire.
    assert!(
        !combined.contains("unreachable"),
        "post-UPDATE statement ran; abort did not happen. output:\n{combined}",
    );
}
