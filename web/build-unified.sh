#!/usr/bin/env bash
# Rebuild web/vendor/unified.esm.js from the npm packages.
#
# Idempotent. Installs deps into a scratch dir, bundles via esbuild,
# writes the single ESM file the frontend imports. Run when you want
# to refresh markdown lib versions or recreate the vendored bundle.
#
# Bundle covers:
#   mdast-util-from-markdown  — md  → mdast
#   mdast-util-to-markdown    — mdast → md
#   mdast-util-to-hast        — mdast → hast
#   hast-util-to-html         — hast  → html
#   unist-util-visit          — mdast walker (re-exported for callers)
set -euo pipefail
cd "$(dirname "$0")"

SCRATCH=".bundle-tmp"
rm -rf "$SCRATCH"
mkdir "$SCRATCH"

cat > "$SCRATCH/package.json" <<'JSON'
{"name":"unified-bundle","private":true,"type":"module"}
JSON

cat > "$SCRATCH/entry.js" <<'JS'
export { fromMarkdown } from "mdast-util-from-markdown";
export { toMarkdown   } from "mdast-util-to-markdown";
export { toHast       } from "mdast-util-to-hast";
export { toHtml       } from "hast-util-to-html";
export { visit        } from "unist-util-visit";
JS

cd "$SCRATCH"
npm i --no-save --silent \
    mdast-util-from-markdown@2 \
    mdast-util-to-markdown@2 \
    mdast-util-to-hast@13 \
    hast-util-to-html@9 \
    unist-util-visit@5 \
    esbuild@0.20

./node_modules/.bin/esbuild entry.js \
    --bundle --format=esm --target=es2020 --minify \
    --outfile=../vendor/unified.esm.js

cd ..
rm -rf "$SCRATCH"

echo "==> wrote vendor/unified.esm.js"
wc -c vendor/unified.esm.js
