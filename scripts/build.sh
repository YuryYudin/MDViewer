#!/usr/bin/env bash
# Build MDViewer release bundles for the current host platform.
#
# Usage:
#   ./scripts/build.sh [--skip-tests] [--debug] [--bundles dmg,msi,appimage,deb]
#
# Targets are tied to the host OS because each WebView (WKWebView /
# WebView2 / WebKitGTK) depends on libraries that only resolve on its
# native platform — cross-compilation isn't viable. For multi-platform
# release builds, push a v* tag and let .github/workflows/release.yml
# fan out to macOS / Windows / Linux runners.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---- Args ----
SKIP_TESTS=0
PROFILE_FLAG="--release"
EXPLICIT_BUNDLES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-tests)  SKIP_TESTS=1; shift ;;
    --debug)       PROFILE_FLAG="--debug"; shift ;;
    --bundles)     EXPLICIT_BUNDLES="$2"; shift 2 ;;
    --bundles=*)   EXPLICIT_BUNDLES="${1#*=}"; shift ;;
    -h|--help)
      sed -n '1,/^set -euo/p' "$0" | sed 's/^# //; s/^#//' | head -n -1
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---- Detect host platform → default bundle list ----
HOST="$(uname -s)"
case "$HOST" in
  Darwin)   DEFAULT_BUNDLES="dmg" ;;
  Linux)    DEFAULT_BUNDLES="appimage,deb,rpm" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) DEFAULT_BUNDLES="msi" ;;
  *)        echo "unsupported host: $HOST" >&2; exit 1 ;;
esac

BUNDLES="${EXPLICIT_BUNDLES:-$DEFAULT_BUNDLES}"

# ---- Pre-flight checks ----
echo "==> Host: $HOST · profile: ${PROFILE_FLAG#--} · bundles: $BUNDLES"

if ! command -v cargo >/dev/null; then
  echo "cargo not found — install Rust toolchain first" >&2
  exit 1
fi
if ! command -v node >/dev/null; then
  echo "node not found — install Node 18+ first" >&2
  exit 1
fi
if [[ ! -d node_modules ]]; then
  echo "==> Installing npm deps"
  npm ci
fi

# ---- Tests (unless explicitly skipped or in CI which runs its own) ----
if [[ "$SKIP_TESTS" == 0 && "${CI:-}" != "true" ]]; then
  echo "==> Running unit tests"
  npm run test --silent
  echo "==> Running Rust integration tests"
  (cd src-tauri && cargo test --quiet)
  # E2E is opt-in for local builds. It's slow (spawns a real WebView per
  # spec) and the bundle build itself doesn't depend on it; CI runs it
  # separately. Set RUN_E2E=1 to include it.
  if [[ "${RUN_E2E:-}" == "1" ]]; then
    echo "==> Running E2E suite"
    npm run test:e2e --silent
  fi
fi

# ---- Bundle ----
TAURI_ARGS=()
if [[ "$PROFILE_FLAG" == "--debug" ]]; then
  TAURI_ARGS+=(--debug)
fi
TAURI_ARGS+=(--bundles "$BUNDLES")

echo "==> tauri build ${TAURI_ARGS[*]}"
npm run tauri -- build "${TAURI_ARGS[@]}"

# ---- Report artifacts ----
PROFILE_DIR="release"
[[ "$PROFILE_FLAG" == "--debug" ]] && PROFILE_DIR="debug"
BUNDLE_ROOT="src-tauri/target/$PROFILE_DIR/bundle"

echo
echo "==> Artifacts in $BUNDLE_ROOT:"
if [[ -d "$BUNDLE_ROOT" ]]; then
  # Walk the bundle tree and report every produced installer/archive
  # along with its size. Resilient to Tauri version differences in
  # subdirectory names (dmg/macos/msi/nsis/deb/appimage/...).
  find "$BUNDLE_ROOT" -type f \
    \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.msi' \
       -o -name '*.exe' -o -name '*.AppImage' -o -name '*.deb' \
       -o -name '*.rpm' \) \
    -print0 \
  | while IFS= read -r -d '' f; do
      size=$(du -h "$f" | cut -f1)
      printf "  %-8s  %s\n" "$size" "$f"
    done
else
  echo "  (no bundle directory — tauri build may have failed)" >&2
  exit 1
fi

# Code signing left as a follow-up (see release.yml's TODO block):
# - macOS notarization needs APPLE_CERTIFICATE / APPLE_ID secrets.
# - Windows MSI needs an EV cert + SignTool.
# Unsigned local builds work for development and for sharing with
# trusting reviewers; users will see a Gatekeeper / SmartScreen prompt.
