#!/bin/bash
# TLC runner — invokes the TLA+ model checker against FugueOnCRSqlite.tla
# with reasonable defaults for our state-space size.
#
# Usage:
#   ./run-tlc.sh                              # default: 4 workers, 4G heap
#   ./run-tlc.sh -workers 8                   # pass-through args
#   WORKERS=8 HEAP=8G ./run-tlc.sh            # env overrides
#
# Outputs are written to ./tlc-output/ for inspection.

set -euo pipefail

cd "$(dirname "$0")"

JAVA="${JAVA:-/opt/homebrew/opt/openjdk/bin/java}"
TLA2TOOLS="${TLA2TOOLS:-./tools/tla2tools.jar}"
WORKERS="${WORKERS:-4}"
HEAP="${HEAP:-4G}"
SPEC="${SPEC:-FugueOnCRSqlite}"

if [[ ! -f "$TLA2TOOLS" ]]; then
  echo "tla2tools.jar not found at $TLA2TOOLS" >&2
  exit 1
fi
if [[ ! -f "$SPEC.tla" ]]; then
  echo "$SPEC.tla not found" >&2
  exit 1
fi
if [[ ! -f "$SPEC.cfg" ]]; then
  echo "$SPEC.cfg not found" >&2
  exit 1
fi

mkdir -p tlc-output
START=$(date +%s)

echo "TLC: spec=$SPEC.tla  cfg=$SPEC.cfg  workers=$WORKERS  heap=$HEAP"
echo "---"

"$JAVA" -Xmx"$HEAP" \
  -cp "$TLA2TOOLS" tlc2.TLC \
  -workers "$WORKERS" \
  -metadir tlc-output \
  -config "$SPEC.cfg" \
  -deadlock \
  "$@" \
  "$SPEC.tla"

EXIT=$?
ELAPSED=$(( $(date +%s) - START ))
echo "---"
echo "TLC finished in ${ELAPSED}s with exit $EXIT"
exit $EXIT
