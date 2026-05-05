#!/usr/bin/env bash
# Self-test for scripts/check-coverage.sh.
#
# Builds tiny synthetic lcov files and asserts that:
#   - whole-tree mode (no prefixes) gates on the workspace total
#   - prefix mode gates per directory and reports each on its own line
#   - exit code is 0 when every gated bucket >= threshold, 1 otherwise
#   - paths are matched as repository-relative prefixes regardless of
#     whether SF: lines are absolute (cargo-llvm-cov default) or relative
#   - JaCoCo mode is reserved for Phase C and exits 2 with a clear note
#
# Usage: bash tests/scripts/check_coverage_test.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/check-coverage.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

assert() {
    local name="$1"
    local expected_exit="$2"
    local actual_exit="$3"
    local output="$4"
    local must_contain="${5:-}"

    if [[ "$expected_exit" != "$actual_exit" ]]; then
        echo "FAIL: $name — expected exit $expected_exit, got $actual_exit"
        echo "  output:"
        echo "$output" | sed 's/^/    /'
        FAIL=$((FAIL + 1))
        return
    fi
    if [[ -n "$must_contain" && "$output" != *"$must_contain"* ]]; then
        echo "FAIL: $name — output missing '$must_contain'"
        echo "  output:"
        echo "$output" | sed 's/^/    /'
        FAIL=$((FAIL + 1))
        return
    fi
    echo "PASS: $name"
    PASS=$((PASS + 1))
}

run() {
    # Run the script, capturing both stdout and exit code without
    # tripping `set -e` on the caller.
    local out
    out="$("$@" 2>&1)" && local rc=0 || local rc=$?
    printf '%s\n' "$out"
    return "$rc"
}

# ---------- Fixture 1: relative paths, mixed coverage ----------
cat >"$TMP/relative.lcov" <<'EOF'
SF:crates/mdviewer-core/src/anchor.rs
LF:100
LH:90
end_of_record
SF:crates/mdviewer-core/src/comments.rs
LF:100
LH:70
end_of_record
SF:src-tauri/src/main.rs
LF:50
LH:10
end_of_record
EOF

# Whole tree: (90 + 70 + 10) / (100 + 100 + 50) = 170/250 = 68% < 80
out="$(bash "$SCRIPT" "$TMP/relative.lcov" 80 2>&1)" && rc=0 || rc=$?
assert "whole-tree below threshold exits 1" 1 "$rc" "$out" "all: 68.0%"

# mdviewer-core only: 160/200 = 80% — exactly meets threshold (>=)
out="$(bash "$SCRIPT" "$TMP/relative.lcov" 80 crates/mdviewer-core/ 2>&1)" && rc=0 || rc=$?
assert "prefix at threshold exits 0" 0 "$rc" "$out" "crates/mdviewer-core/: 80.0%"

# mdviewer-core at 81% threshold should fail
out="$(bash "$SCRIPT" "$TMP/relative.lcov" 81 crates/mdviewer-core/ 2>&1)" && rc=0 || rc=$?
assert "prefix below threshold exits 1" 1 "$rc" "$out" "crates/mdviewer-core/: 80.0%"

# Multiple prefixes, one passes, one fails
out="$(bash "$SCRIPT" "$TMP/relative.lcov" 50 crates/mdviewer-core/ src-tauri/ 2>&1)" && rc=0 || rc=$?
assert "multi-prefix one fails exits 1" 1 "$rc" "$out" "src-tauri/: 20.0%"

# ---------- Fixture 2: absolute paths (matches cargo-llvm-cov default) ----------
cat >"$TMP/absolute.lcov" <<EOF
SF:$REPO_ROOT/crates/mdviewer-core/src/anchor.rs
LF:50
LH:45
end_of_record
SF:$REPO_ROOT/crates/mdviewer-core/src/comments.rs
LF:50
LH:40
end_of_record
EOF

# Total: 85/100 = 85% >= 80
out="$(bash "$SCRIPT" "$TMP/absolute.lcov" 80 crates/mdviewer-core/ 2>&1)" && rc=0 || rc=$?
assert "absolute SF paths normalize to prefix" 0 "$rc" "$out" "crates/mdviewer-core/: 85.0%"

# ---------- Fixture 3: empty / unmatched prefix ----------
cat >"$TMP/empty.lcov" <<'EOF'
SF:other/src/foo.rs
LF:10
LH:10
end_of_record
EOF

# Prefix with no matches: report 0/0 and pass (treated as N/A, >= threshold)
out="$(bash "$SCRIPT" "$TMP/empty.lcov" 80 crates/mdviewer-core/ 2>&1)" && rc=0 || rc=$?
assert "unmatched prefix passes (0/0 = N/A)" 0 "$rc" "$out" "crates/mdviewer-core/: n/a"

# ---------- Fixture 4: JaCoCo mode reserved for Phase C ----------
mkdir -p "$TMP/jacoco-report"
out="$(bash "$SCRIPT" "$TMP/jacoco-report" 80 2>&1)" && rc=0 || rc=$?
assert "JaCoCo mode exits 2" 2 "$rc" "$out" "JaCoCo"

# ---------- Summary ----------
echo
echo "Tests: $PASS passed, $FAIL failed"
exit "$FAIL"
