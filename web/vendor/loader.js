// Custom minimal loader for our β-flat crsqlite.wasm.
//
// Replaces the @vlcn.io/crsqlite-wasm@0.16.0 + @vlcn.io/wa-sqlite@0.22.0
// bundled wrapper because that wrapper has hard-coded assumptions about a
// specific wa-sqlite commit's exports — incompatible with the wasm we build
// locally from this fork.
//
// Surface area is exactly what `app.js` needs:
//   initWasm(locateWasm) → { open(path) → { exec, execA, close } }
//
// Implementation talks to the emscripten Module directly via ccall/cwrap.
// All calls are `async: true` because the wasm is built with `-s ASYNCIFY`.

import Module from "./crsqlite.mjs";

const SQLITE_ROW = 100;
const SQLITE_DONE = 101;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;

const COL_INTEGER = 1;
const COL_FLOAT = 2;
const COL_TEXT = 3;
const COL_BLOB = 4;
const COL_NULL = 5;

export async function initWasm(locateWasm) {
  const mod = await Module({
    locateFile: (file) => locateWasm(file),
  });
  return { open: (path) => openDb(mod, path) };
}

async function openDb(mod, path) {
  const pathBytes = mod.lengthBytesUTF8(path) + 1;
  const pathPtr = mod._malloc(pathBytes);
  mod.stringToUTF8(path, pathPtr, pathBytes);

  const ppDb = mod._malloc(4);
  const rc = await mod.ccall(
    "sqlite3_open_v2",
    "number",
    ["number", "number", "number", "number"],
    [pathPtr, ppDb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, 0],
    { async: true },
  );
  mod._free(pathPtr);
  if (rc !== 0) {
    mod._free(ppDb);
    throw new SQLiteError(`sqlite3_open_v2 failed: rc=${rc}`);
  }
  const db = mod.getValue(ppDb, "i32");
  mod._free(ppDb);

  return {
    exec: async (sql, params) => {
      await runSql(mod, db, sql, params, /*collectRows=*/ false);
    },
    execA: async (sql, params) =>
      runSql(mod, db, sql, params, /*collectRows=*/ true),
    close: async () => {
      await mod.ccall(
        "sqlite3_close",
        "number",
        ["number"],
        [db],
        { async: true },
      );
    },
  };
}

async function runSql(mod, db, sql, params, collectRows) {
  const sqlBytes = mod.lengthBytesUTF8(sql) + 1;
  const sqlPtr = mod._malloc(sqlBytes);
  mod.stringToUTF8(sql, sqlPtr, sqlBytes);

  const ppStmt = mod._malloc(4);
  const prc = await mod.ccall(
    "sqlite3_prepare_v2",
    "number",
    ["number", "number", "number", "number", "number"],
    [db, sqlPtr, -1, ppStmt, 0],
    { async: true },
  );
  mod._free(sqlPtr);
  if (prc !== 0) {
    mod._free(ppStmt);
    throw await sqliteError(mod, db, `prepare failed (rc=${prc}) for: ${sql}`);
  }
  const stmt = mod.getValue(ppStmt, "i32");
  mod._free(ppStmt);

  // Bind positional parameters. `?` placeholders in the SQL line up with
  // `params[0..]`. sqlite3_bind_* indexes are 1-based.
  if (params && params.length) {
    for (let i = 0; i < params.length; i++) {
      const idx = i + 1;
      const v = params[i];
      let bindRc;
      if (v === null || v === undefined) {
        bindRc = mod._sqlite3_bind_null(stmt, idx);
      } else if (typeof v === "number") {
        if (Number.isInteger(v)) {
          bindRc = mod._sqlite3_bind_int(stmt, idx, v);
        } else {
          bindRc = mod._sqlite3_bind_double(stmt, idx, v);
        }
      } else if (typeof v === "boolean") {
        bindRc = mod._sqlite3_bind_int(stmt, idx, v ? 1 : 0);
      } else if (typeof v === "string") {
        const bytes = mod.lengthBytesUTF8(v) + 1;
        const ptr = mod._malloc(bytes);
        mod.stringToUTF8(v, ptr, bytes);
        // SQLITE_TRANSIENT (-1 cast to pointer) tells SQLite to copy the
        // bytes; we free `ptr` immediately after.
        bindRc = mod._sqlite3_bind_text(stmt, idx, ptr, bytes - 1, -1);
        mod._free(ptr);
      } else if (v instanceof Uint8Array) {
        const ptr = mod._malloc(v.length);
        // Our wa-sqlite build doesn't export HEAPU8, so write bytes via
        // setValue. Blobs in this demo are small (site_ids 16 bytes, etc.);
        // the per-byte cost is negligible.
        for (let k = 0; k < v.length; k++) {
          mod.setValue(ptr + k, v[k], "i8");
        }
        // SQLITE_TRANSIENT = -1 → SQLite copies the bytes.
        bindRc = mod._sqlite3_bind_blob(stmt, idx, ptr, v.length, -1);
        mod._free(ptr);
      } else if (typeof v === "bigint") {
        // Best effort: pass via int64 if available, else truncate.
        bindRc = mod._sqlite3_bind_int64
          ? mod._sqlite3_bind_int64(stmt, idx, v)
          : mod._sqlite3_bind_int(stmt, idx, Number(v));
      } else {
        await mod.ccall("sqlite3_finalize", "number", ["number"], [stmt], {
          async: true,
        });
        throw new SQLiteError(
          `bind param[${i}] has unsupported type: ${typeof v}`,
        );
      }
      if (bindRc !== 0) {
        const err = await sqliteError(
          mod,
          db,
          `bind param[${i}] failed (rc=${bindRc})`,
        );
        await mod.ccall("sqlite3_finalize", "number", ["number"], [stmt], {
          async: true,
        });
        throw err;
      }
    }
  }

  const rows = collectRows ? [] : undefined;
  try {
    while (true) {
      const src = await mod.ccall(
        "sqlite3_step",
        "number",
        ["number"],
        [stmt],
        { async: true },
      );
      if (src === SQLITE_DONE) break;
      if (src !== SQLITE_ROW) {
        throw await sqliteError(mod, db, `step failed (rc=${src})`);
      }
      if (!collectRows) continue;
      const colCount = mod._sqlite3_column_count(stmt);
      const row = new Array(colCount);
      for (let i = 0; i < colCount; i++) {
        row[i] = readColumn(mod, stmt, i);
      }
      rows.push(row);
    }
  } finally {
    await mod.ccall(
      "sqlite3_finalize",
      "number",
      ["number"],
      [stmt],
      { async: true },
    );
  }
  return rows;
}

function readColumn(mod, stmt, i) {
  const type = mod._sqlite3_column_type(stmt, i);
  switch (type) {
    case COL_INTEGER:
      // 32-bit accessor; the demo's queries stay within INT32 range
      // (db_version, col_version, idx counters, tombstoned booleans).
      return mod._sqlite3_column_int(stmt, i);
    case COL_FLOAT:
      return mod._sqlite3_column_double(stmt, i);
    case COL_TEXT: {
      const ptr = mod._sqlite3_column_text(stmt, i);
      return mod.UTF8ToString(ptr);
    }
    case COL_BLOB: {
      const ptr = mod._sqlite3_column_blob(stmt, i);
      const len = mod._sqlite3_column_bytes(stmt, i);
      // Read byte-by-byte via getValue since HEAPU8 isn't exported.
      // getValue 'i8' returns signed; mask to unsigned for Uint8Array.
      const out = new Uint8Array(len);
      for (let k = 0; k < len; k++) {
        out[k] = mod.getValue(ptr + k, "i8") & 0xff;
      }
      return out;
    }
    case COL_NULL:
    default:
      return null;
  }
}

async function sqliteError(mod, db, prefix) {
  const msgPtr = mod._sqlite3_errmsg(db);
  const msg = msgPtr ? mod.UTF8ToString(msgPtr) : "(no message)";
  return new SQLiteError(`${prefix}: ${msg}`);
}

class SQLiteError extends Error {
  constructor(message) {
    super(message);
    this.name = "SQLiteError";
  }
}
