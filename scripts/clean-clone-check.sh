#!/usr/bin/env bash
# clean-clone-check — prove baton runs from a fresh clone: clone, install,
# test, lint, dry launcher. Usage: bash scripts/clean-clone-check.sh [scratch-dir]
# Prints "CLEAN-CLONE PASS tests=<n>" or "CLEAN-CLONE FAIL step=<step>".
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="${1:-${TMPDIR:-/tmp}}"
TS="$(date +%s)"
DEST="$SCRATCH/baton-clean-$TS"
LOG="$DEST.log"
fail() { echo "CLEAN-CLONE FAIL step=$1 (log: $LOG)"; tail -20 "$LOG" 2>/dev/null; exit 1; }

mkdir -p "$SCRATCH" || fail mkdir
echo "clone $SRC -> $DEST"
git clone -q "file://$SRC" "$DEST" > "$LOG" 2>&1 || fail clone
cd "$DEST" || fail cd

echo "npm ci"
if ! npm ci --no-audit --no-fund >> "$LOG" 2>&1; then
  if grep -q edgesOut "$LOG"; then
    echo "npm ci hit edgesOut; retrying with npx --yes npm@latest ci"
    npx --yes npm@latest ci --no-audit --no-fund >> "$LOG" 2>&1 || fail npm-ci
  else
    fail npm-ci
  fi
fi

echo "npm test"
npm test >> "$LOG" 2>&1 || fail npm-test
TESTS="$(grep -E '^ℹ tests [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$')"
PASS="$(grep -E '^ℹ pass [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$')"
FAILS="$(grep -E '^ℹ fail [0-9]+' "$LOG" | tail -1 | grep -oE '[0-9]+$')"
[ "${FAILS:-1}" = "0" ] || fail npm-test-fail
[ "${TESTS:-0}" = "${PASS:-x}" ] || fail npm-test-count

echo "npm run lint"
npm run lint >> "$LOG" 2>&1 || fail lint

echo "node bin/baton.mjs up --dry"
BATON_HOME="$DEST/.baton-home" node bin/baton.mjs up --dry >> "$LOG" 2>&1 || fail up-dry

echo "CLEAN-CLONE PASS tests=$TESTS"
