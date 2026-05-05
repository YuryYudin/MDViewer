#!/usr/bin/env bash
# check-coverage.sh — gate per-directory line coverage from a coverage report.
#
# Usage:
#   check-coverage.sh <report-path> <threshold> [<dir-prefix>...]
#
# Modes:
#   - if <report-path> ends in `.lcov`, parse lcov SF/LF/LH triples
#   - else, treat <report-path> as a JaCoCo XML report directory
#     (Phase C7 wires this for the Android module)
#
# Behaviour:
#   - With no prefixes: reports a single "all" bucket totalling every SF
#     record in the lcov file. Used as the workspace-wide gate.
#   - With one or more prefixes: reports one line per prefix, summing the
#     LF/LH of every SF whose repo-relative path starts with that prefix.
#     SF paths are normalized to repo-relative — cargo-llvm-cov emits
#     absolute paths by default, so the workspace root is stripped before
#     prefix matching. This lets CI invoke the gate as
#       check-coverage.sh coverage.lcov 80 crates/mdviewer-core/
#     regardless of where the workspace lives on the runner.
#   - Empty bucket (no SF records match a prefix) is reported as "n/a"
#     and does NOT fail the gate. This avoids false negatives when a
#     prefix is renamed or deleted; the gate is for catching regressions,
#     not for asserting the prefix exists.
#   - Exit code = number of buckets that fell below threshold (0 = all
#     pass; >0 = at least one bucket regressed). Capped at 1 to match
#     conventional shell exit semantics.

set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "usage: check-coverage.sh <report-path> <threshold> [<dir-prefix>...]" >&2
    exit 2
fi

REPORT="$1"
THRESHOLD="$2"
shift 2
PREFIXES=("$@")

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$REPORT" == *.lcov ]]; then
    awk -v threshold="$THRESHOLD" \
        -v prefixes="${PREFIXES[*]:-}" \
        -v repo_root="$REPO_ROOT" '
        function normalize(path,    n) {
            # Strip the workspace root so relative + absolute SF paths
            # share a single matching key. Trailing slash preserved on
            # the prefix below.
            n = length(repo_root)
            if (substr(path, 1, n) == repo_root && substr(path, n + 1, 1) == "/") {
                return substr(path, n + 2)
            }
            return path
        }
        BEGIN {
            pn = 0
            if (length(prefixes) > 0) {
                pn = split(prefixes, p, " ")
            }
        }
        /^SF:/ { current = normalize(substr($0, 4)) }
        /^LF:/ { lf[current] = substr($0, 4) + 0 }
        /^LH:/ { lh[current] = substr($0, 4) + 0 }
        END {
            failures = 0
            if (pn == 0) {
                sum_lf = 0; sum_lh = 0
                for (f in lf) { sum_lf += lf[f]; sum_lh += lh[f] }
                if (sum_lf == 0) {
                    printf "all: n/a (0/0) threshold=%s\n", threshold
                } else {
                    pct = 100.0 * sum_lh / sum_lf
                    printf "all: %.1f%% (%d/%d) threshold=%s\n", pct, sum_lh, sum_lf, threshold
                    if (pct < threshold + 0) failures++
                }
            } else {
                for (i = 1; i <= pn; i++) {
                    sum_lf = 0; sum_lh = 0
                    for (f in lf) {
                        # Anchor the prefix to the start of the
                        # normalized path. Escape regex metacharacters
                        # that legitimately appear in directory names
                        # (`.` is the common one for hidden dirs).
                        pat = p[i]
                        gsub(/[.[\](){}+*?^$|\\]/, "\\\\&", pat)
                        if (f ~ ("^" pat)) { sum_lf += lf[f]; sum_lh += lh[f] }
                    }
                    if (sum_lf == 0) {
                        printf "%s: n/a (0/0) threshold=%s\n", p[i], threshold
                    } else {
                        pct = 100.0 * sum_lh / sum_lf
                        printf "%s: %.1f%% (%d/%d) threshold=%s\n", p[i], pct, sum_lh, sum_lf, threshold
                        if (pct < threshold + 0) failures++
                    }
                }
            }
            exit (failures > 0 ? 1 : 0)
        }
    ' "$REPORT"
else
    echo "JaCoCo mode wired in C7 (Android module coverage); not implemented yet" >&2
    exit 2
fi
