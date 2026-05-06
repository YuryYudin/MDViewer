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
    # JaCoCo XML mode (C7). The report path can be either a path to the
    # JaCoCo XML file directly, or a directory containing one (we pick the
    # first .xml found in that case so the script gates equally well
    # against `app/build/reports/jacoco/foo.xml` and against the report
    # directory `app/build/reports/jacoco/foo/`).
    #
    # The Python parser below sums per-package LINE counters from
    # `<sourcefile>` entries, matching each package against the user-
    # supplied `dir-prefix` arguments. A package matches a prefix when
    # the prefix is a *segment suffix* of the package's dotted name —
    # `saf` matches `dev.mdviewer.saf` but not `dev.mdviewer.unsafe`. Any
    # package that doesn't match a prefix is ignored, so unrelated package
    # output (e.g. `dev.mdviewer.ui` while gating `saf,data,render`) does
    # not pollute the reported numbers.
    #
    # Why Python: JaCoCo XML is small (a few hundred KB even for large
    # modules) and the parser is six lines of `xml.etree`. Awking the XML
    # would require a custom tag-state machine since `<sourcefile>` /
    # `<counter>` is hierarchical; not worth the lines.
    XML="$REPORT"
    if [[ -d "$REPORT" ]]; then
        XML=$(find "$REPORT" -name "*.xml" -type f | head -n1)
    fi

    if [[ -z "$XML" || ! -f "$XML" ]]; then
        echo "JaCoCo XML report not found at $REPORT" >&2
        exit 2
    fi

    python3 - "$XML" "$THRESHOLD" "${PREFIXES[@]:-}" <<'PY'
import sys, xml.etree.ElementTree as ET
xml_path, threshold = sys.argv[1], int(sys.argv[2])
prefixes = [p for p in sys.argv[3:] if p]
root = ET.parse(xml_path).getroot()
totals = {p: [0, 0] for p in prefixes} if prefixes else {"all": [0, 0]}
for pkg in root.findall(".//package"):
    pkg_name = pkg.get("name", "").replace("/", ".")
    for sf in pkg.findall("./sourcefile"):
        ctr = sf.find("./counter[@type='LINE']")
        if ctr is None:
            continue
        missed = int(ctr.get("missed", 0))
        covered = int(ctr.get("covered", 0))
        if not prefixes:
            totals["all"][0] += missed
            totals["all"][1] += covered
        else:
            for p in prefixes:
                # Match by segment-suffix: prefix `saf` matches package
                # `dev.mdviewer.saf` but not `dev.mdviewer.unsafe`. We
                # accept three forms so callers can pass either a leaf
                # segment (`saf`) or a fully-qualified name fragment
                # (`mdviewer.saf`). The `.{p}.` clause catches mid-tree
                # packages like `dev.mdviewer.saf.internal` if those ever
                # land.
                if (
                    pkg_name == p
                    or pkg_name.endswith(f".{p}")
                    or f".{p}." in pkg_name
                ):
                    totals[p][0] += missed
                    totals[p][1] += covered
failures = 0
for k, (m, c) in totals.items():
    pct = 100.0 * c / (m + c) if (m + c) > 0 else 0
    if (m + c) == 0:
        print(f"{k}: n/a (0/0) threshold={threshold}")
    else:
        print(f"{k}: {pct:.1f}% ({c}/{m+c}) threshold={threshold}")
        if pct < threshold:
            failures += 1
sys.exit(1 if failures > 0 else 0)
PY
fi
