git-deps = core/rs/sqlite-rs-embedded

.EXPORT_ALL_VARIABLES:
	CRSQLITE_NOPREBUILD = 1

all: crsqlite

$(git-deps):
	git submodule update --init --recursive


crsqlite: $(git-deps)
	cd core; \
	make loadable

clean:
	cd core && make clean

# ---------------------------------------------------------------------------
# WASM build (portable)
#
# Builds the β-flat fork as a WASM extension via vlcn's wa-sqlite wrapper.
# Outputs `web/vendor/crsqlite.{wasm,mjs}` which the browser demo loads.
#
# First run clones wa-sqlite into `.build-cache/` and pins it to a known
# commit. Subsequent runs reuse that checkout. The build itself happens in
# the wa-sqlite directory but compiles against OUR core (symlinked).
#
# Requirements:
#   * emcc (emscripten) on PATH      — `brew install emscripten`
#   * rustup with the pinned toolchain (auto-installed via rust-toolchain.toml)
#
# Usage:
#   make wasm         # build + copy outputs into web/vendor/
#   make wasm-clean   # remove .build-cache/ (next `make wasm` will reclone)
# ---------------------------------------------------------------------------

WA_SQLITE_REPO   = https://github.com/vlcn-io/wa-sqlite.git
WA_SQLITE_COMMIT = 232f21ae4b89972ca70f999554bb39a8ddc9a853
WA_SQLITE_DIR    = .build-cache/wa-sqlite
CORE_ABS         = $(abspath core)
WEB_VENDOR       = web/vendor

# Vendored sqlite amalgamation. wa-sqlite's Makefile normally curls the
# source tarball from sqlite.org/src/tarball/..., but that endpoint now
# returns HTML — and remote downloads aren't reproducible anyway. We
# ship the amalgamation zip in-tree and pre-populate wa-sqlite's
# `deps/version-3.45.0/{sqlite3.c,sqlite3.h}` before its build runs,
# which makes the curl recipe skip (output files already present).
SQLITE_VERSION   = version-3.45.0
SQLITE_ZIP       = core/deps/sqlite-amalgamation-3450000.zip
SQLITE_INNER     = sqlite-amalgamation-3450000
WA_SQLITE_DEPS   = $(WA_SQLITE_DIR)/deps/$(SQLITE_VERSION)

wasm: wasm-deps $(WA_SQLITE_DEPS)/sqlite3.c
	@echo "==> Building β-flat WASM via wa-sqlite ($(WA_SQLITE_COMMIT))"
	# wa-sqlite's `dist` target lists `deps` as a prerequisite but `deps` is
	# declared `.PHONY` with no recipe, so the sqlite tarball never gets
	# fetched on a clean clone. Run `crsqlite-extra` first to populate
	# `deps/$(SQLITE_VERSION)/sqlite3-extra.c`.
	cd $(WA_SQLITE_DIR) && $(MAKE) crsqlite-extra
	cd $(WA_SQLITE_DIR) && $(MAKE) dist
	@mkdir -p $(WEB_VENDOR)
	cp $(WA_SQLITE_DIR)/dist/crsqlite.wasm $(WEB_VENDOR)/crsqlite.wasm
	cp $(WA_SQLITE_DIR)/dist/crsqlite.mjs  $(WEB_VENDOR)/crsqlite.mjs
	@echo "==> Done. Outputs:"
	@ls -lh $(WEB_VENDOR)/crsqlite.wasm $(WEB_VENDOR)/crsqlite.mjs

# Extract the vendored amalgamation into wa-sqlite's expected deps dir.
# wa-sqlite's own recipe is gated on these files existing; pre-populating
# them is exactly the no-curl path.
$(WA_SQLITE_DEPS)/sqlite3.c: $(SQLITE_ZIP) | $(WA_SQLITE_DIR)/crsql
	@echo "==> Extracting vendored sqlite amalgamation into $(WA_SQLITE_DEPS)"
	@mkdir -p $(WA_SQLITE_DEPS)
	@unzip -o -q $(SQLITE_ZIP) -d $(WA_SQLITE_DIR)/.sqlite-amalg-tmp
	@cp $(WA_SQLITE_DIR)/.sqlite-amalg-tmp/$(SQLITE_INNER)/sqlite3.c    $(WA_SQLITE_DEPS)/sqlite3.c
	@cp $(WA_SQLITE_DIR)/.sqlite-amalg-tmp/$(SQLITE_INNER)/sqlite3.h    $(WA_SQLITE_DEPS)/sqlite3.h
	@cp $(WA_SQLITE_DIR)/.sqlite-amalg-tmp/$(SQLITE_INNER)/sqlite3ext.h $(WA_SQLITE_DEPS)/sqlite3ext.h
	@rm -rf $(WA_SQLITE_DIR)/.sqlite-amalg-tmp

wasm-deps: $(WA_SQLITE_DIR)/crsql
	@command -v emcc >/dev/null 2>&1 || { \
	    echo "ERROR: emcc not found on PATH."; \
	    echo "       Install with: brew install emscripten"; \
	    exit 1; \
	}
	@command -v rustup >/dev/null 2>&1 || { \
	    echo "ERROR: rustup not found on PATH."; \
	    echo "       Install from: https://rustup.rs"; \
	    exit 1; \
	}
	@rustup target add wasm32-unknown-emscripten --toolchain nightly-2023-10-05 >/dev/null

$(WA_SQLITE_DIR):
	@mkdir -p $(dir $(WA_SQLITE_DIR))
	@echo "==> Cloning wa-sqlite into $(WA_SQLITE_DIR)"
	git clone $(WA_SQLITE_REPO) $(WA_SQLITE_DIR)
	cd $(WA_SQLITE_DIR) && git checkout $(WA_SQLITE_COMMIT)

$(WA_SQLITE_DIR)/crsql: | $(WA_SQLITE_DIR)
	@echo "==> Linking $(WA_SQLITE_DIR)/crsql -> $(CORE_ABS)"
	ln -sfn $(CORE_ABS) $(WA_SQLITE_DIR)/crsql

wasm-clean:
	rm -rf $(WA_SQLITE_DIR)

.PHONY: crsqlite all clean wasm wasm-deps wasm-clean
