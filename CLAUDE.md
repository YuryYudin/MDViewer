# CLAUDE.md

Context for Claude sessions working in this repository. Read this before making changes.

## What this project is

MDViewer is a cross-platform markdown viewer with **collaborative commenting** in a sidecar JSON file. The unit of collaboration is **a folder** (no server, no account). Comments anchor to the source via W3C Web Annotation selectors so small prose edits don't orphan threads.

Two ship targets, one shared core:

- **Desktop** — Tauri 2 + TypeScript (Vite) + Rust. Source under `src/` (TS) and `src-tauri/` (Rust glue). Bundles to `.deb` / `.AppImage` / `.rpm` / `.msi` / `.dmg`.
- **Android** — Kotlin + Compose (Material 3) + Rust via UniFFI. Source under `android/`. Bundles to a sideloadable `.apk`. minSdk 26, compileSdk 34.

The Rust shared core lives in `crates/mdviewer-core`. The Android JNI shim lives in `crates/mdviewer-jni`. The desktop app re-exports from `mdviewer-core` via `src-tauri/`. **The same Rust code drives anchoring, render, sidecar IO, and CRDT merge on both platforms.**

## Repository layout

```
.
├── Cargo.toml                          # Rust workspace root
├── crates/
│   ├── mdviewer-core/                  # Platform-neutral Rust crate (anchor, comments, document, sidecar, sidecar_path)
│   │   ├── src/mdviewer_core.udl       # UniFFI interface (used by Android only)
│   │   ├── uniffi.toml                 # Kotlin codegen config (cdylib_name = "mdviewer_jni")
│   │   ├── build.rs                    # Generates UDL scaffolding when --features uniffi
│   │   └── assets/document.css         # Canonical renderer-target stylesheet (copied to Android assets)
│   └── mdviewer-jni/                   # crate-type=[staticlib, cdylib] — re-exports core for cargo-ndk
│       └── src/lib.rs                  # `pub use mdviewer_core::*;`
│
├── src-tauri/                          # Tauri 2 desktop app (Rust glue)
│   └── src/                            # tauri commands, menu, watcher; renderer re-exported from mdviewer-core
├── src/                                # TypeScript + Vite frontend (desktop renderer)
│
├── android/                            # Android Studio project root
│   ├── settings.gradle.kts             # Modules: :app, :core
│   ├── core/                           # AAR wrapping mdviewer-jni (cargo-ndk → per-ABI .so)
│   │   ├── build.gradle.kts            # cargo block + uniffiBindgen task; generates dev.mdviewer.core Kotlin bindings
│   │   └── src/main/AndroidManifest.xml
│   ├── app/                            # Compose application
│   │   ├── build.gradle.kts            # AGP, R8 release config, JaCoCo offline-instrumentation, copyCoreCss task
│   │   ├── proguard-rules.pro          # Keeps dev.mdviewer.core.** + JNA + AppAuth + @JavascriptInterface
│   │   └── src/
│   │       ├── main/kotlin/dev/mdviewer/
│   │       │   ├── MainActivity.kt, MdviewerApp.kt, Navigation.kt, IntentDispatcher.kt
│   │       │   ├── data/               # DataStore-backed Recents, ProfileStore, SettingsStore (each with *Api seam)
│   │       │   ├── saf/                # DocumentRepository, Sidecar, SidecarMirror, ShareIntents, SaveSidecarToSource
│   │       │   ├── render/             # MarkdownWebView (Compose AndroidView + WebView), SelectionBridge,
│   │       │   │                       # SelectionJsBridge, HighlightInjector, AssetLoaderFactory
│   │       │   └── ui/                 # All Compose screens + ViewModels + ViewModelFactories
│   │       ├── main/assets/            # selection-bridge.js, highlight-injector.js, document-host.html,
│   │       │                           # document.css (build-time copy from crates/mdviewer-core/assets/)
│   │       ├── test/                   # host-JVM unit tests (Robolectric @Config(sdk=33), JaCoCo offline)
│   │       └── androidTest/            # instrumented (emulator) — A1 e2e specs + helpers + render/saf integration
│   ├── keystore/README.md              # Release-keystore env-var contract
│   └── gradle/libs.versions.toml       # Version catalog
│
├── scripts/check-coverage.sh           # LCOV (Rust) + JaCoCo XML (Android) per-package threshold gate
├── docs/wireframes/                    # Design contracts — desktop and android/ subfolder
├── e2e/                                # WDIO desktop e2e (separate from android/ androidTest)
├── tests/                              # Vitest TS unit tests
├── .github/workflows/
│   ├── ci.yml                          # Desktop CI (build + vitest)
│   ├── coverage.yml                    # Rust workspace coverage gate (currently fails on glib-sys; pre-existing)
│   ├── android.yml                     # Android: cargo + Gradle + unit tests + JaCoCo + emulator (continue-on-error)
│   └── release.yml                     # Tag-triggered: 3 desktop bundles + Android signed APK + release-ready
└── .claude/tcoder/2026-05-05-mdviewer-android/   # Android orchestration plan + per-task completion notes + reviews
```

## Tooling versions

- Rust: stable (any 1.75+). Workspace at root.
- Node.js: 20+, npm 10+
- Tauri: 2.11.x. Keep `@tauri-apps/api` major.minor matching the Rust crate (`tauri-action` validates this — see `package.json`).
- Android: AGP 8.5, Kotlin 2.0.0, Compose BOM 2024.06, Material 3, JaCoCo 0.8.12, UniFFI 0.28
- NDK: **no version pin**. AGP picks the highest-installed side-by-side NDK under `$ANDROID_HOME/ndk/`. CI installs the latest GA via `sdkmanager --list` discovery, NOT a hardcoded version. Don't reintroduce `ndkVersion = "..."` — it's exact-match-only and ages badly.
- cargo-ndk: required for Android. `cargo install cargo-ndk --locked` plus the three Android Rust targets.

## Run / build / test cheatsheet

### Desktop
```bash
npm install
npm run dev                                  # Vite + Tauri dev
npm run tauri build                          # Full bundle
npm test                                     # Vitest TS
cargo test --workspace --features uniffi     # Rust including UniFFI smoke
npm run test:e2e                             # WDIO desktop e2e (slow)
```

### Android
```bash
cd android
./gradlew :app:assembleDebug                 # Build debug APK
./gradlew :app:testDebugUnitTest             # Host-JVM unit tests (Robolectric)
./gradlew :app:testDebugUnitTestCoverage     # JaCoCo XML/HTML report
./gradlew :app:lintDebug                     # AGP lint
./gradlew :app:compileDebugAndroidTestKotlin # Verify androidTest compiles (no emulator needed)
./gradlew :app:connectedDebugAndroidTest     # Emulator e2e — A1 specs + render/saf integration
./gradlew :app:assembleRelease               # Signed release APK (requires the four ANDROID_RELEASE_* env vars)
```

### Coverage gate
```bash
./scripts/check-coverage.sh \
  android/app/build/reports/jacoco/testDebugUnitTestCoverage.xml \
  80 ui saf data render
# All four packages must clear 80% line coverage.
```

## Critical conventions

### `mdviewer-core` is the single source of truth
- All anchoring, render, sidecar IO, CRDT logic lives in `crates/mdviewer-core`.
- Desktop and Android both consume it. The desktop reaches it directly (`pub use mdviewer_core::document::*;`); Android reaches it through `mdviewer-jni`'s UniFFI bindings (`dev.mdviewer.core.*`).
- **Never duplicate logic in Kotlin or TypeScript.** If a behavior already lives in `mdviewer-core`, extend that crate and re-expose, don't reimplement.
- `document.css` is canonical at `crates/mdviewer-core/assets/document.css`. Android's `app/src/main/assets/document.css` is a build-time copy via the Gradle `copyCoreCss` task; don't hand-edit the Android copy. The desktop frontend imports the canonical file via Vite.

### UniFFI surface
- Defined in `crates/mdviewer-core/src/mdviewer_core.udl`. Add new functions/dictionaries there, then expose Kotlin wrappers in `crates/mdviewer-core/src/uniffi_bindings.rs`.
- `cdylib_name = "mdviewer_jni"` in `uniffi.toml` — the generated Kotlin's `Native.load(...)` looks for `libmdviewer_jni.so`, NOT the default `libuniffi_<namespace>.so`. Don't change this without also renaming the cdylib.
- `android_cleaner = true` — generated bindings reference `android.os.Build`. Host-JVM tests therefore need Robolectric `@Config(sdk = [33])` to load the bindings; plain JUnit fails.
- The `uniffi-bindgen` host bin lives in `mdviewer-core` (gated behind the `cli` feature). Bindgen version must match scaffolding version exactly — Cargo.lock pinning is the contract.

### A1 e2e specs are immutable
The 10 instrumented spec files in `android/app/src/androidTest/kotlin/dev/mdviewer/e2e/*.kt` were checked in at commit `ec92c68` as the design contract — they must drive implementation, not the other way around. **Do not modify them.** Helpers under `e2e/helpers/` are fine to evolve. The `android.yml` workflow has an A1 guard that fails the job if the count drops below 10.

### Coverage uses JaCoCo offline instrumentation
- AGP's default `enableUnitTestCoverage` uses an on-the-fly `-javaagent` that Robolectric's SandboxClassLoader bypasses, so probes never fire — the standard config reports 0% on every Robolectric-tested package.
- We solve this with the `jacocoOfflineInstrument` Gradle task in `android/app/build.gradle.kts`: probes are baked into the bytecode at build time. The on-the-fly agent is disabled in the same place; don't re-enable it.
- Two exclude lists matter (`instrumentationExcludes` vs `reportOnlyExcludes`). Generated/test classes go in `instrumentationExcludes` (kept off the classpath entirely). Production-only adapters that wrap real Android-framework surfaces (`DocumentFileTreeAccess`, `DocumentFileNode`, `MarkdownWebView`, `SelectionWebView`) go in `reportOnlyExcludes` — they MUST stay on the runtime classpath because other production code transitively loads them; they only come out of the report's denominator.

### Test seams (`*Api` interfaces)
- `RecentsApi`, `DocumentRepositoryApi`, `SidecarApi`, `ProfileStoreApi` are minimal interfaces extracted in front of the concrete classes. ViewModels and screens depend on the interfaces; tests inject in-memory fakes; production uses the real classes (which all take a `Context` and so are awkward in host-JVM tests).
- When adding a new collaborator to a ViewModel, follow the same pattern: extract an interface, have the production class implement it, name the fake `Fake<X>` and put it in `app/src/test/kotlin/dev/mdviewer/ui/Fakes.kt` (or alongside the test that needs it).

### Stores share file-keyed singletons
`Recents`, `ProfileStore`, `SettingsStore` all wrap a `DataStore<Preferences>`. DataStore enforces "one active store per file path per process" — instantiating two against the same prefs file throws `IllegalStateException` at first read. The store classes memoize the underlying `DataStore` keyed by `prefsName`. Tests pass unique `prefsName` values (e.g. `settings-vm-${System.nanoTime()}`) so they don't collide.

### Channel-not-SharedFlow for one-shot snackbars
`DocumentViewModel.snackbarMessage` is a `Channel<String>(UNLIMITED).receiveAsFlow()`. SharedFlow has timing edge cases under `runTest` — values can land before a collector subscribes and disappear. Channels deliver every value to the next collector regardless of subscription order, which is what snackbar UX requires (a second tap producing the same message must surface a fresh toast).

### Comment-flow surfaces are mounted in DocumentScreen
`ThreadOverlay` (D4 container), `ThreadSheet` (D5), `CommentsListSheet` (D6) are all mounted in `android/app/src/main/kotlin/dev/mdviewer/ui/DocumentScreen.kt` (E7 wiring). The `ThreadSheetViewModelFactory` lives at the bottom of `DocumentScreen.kt` (intentionally not in `ViewModelFactories.kt`) because the per-document `SaveContext` changes shape on every open and a `ViewModelStore`-cached factory would carry stale fields. The `sidecarPattern` flows through from `SettingsStore.sidecarPattern` so a customized pattern lands in the same file the next reload reads from.

## CI status (as of v0.3.3)

| Workflow | Status | Notes |
| --- | --- | --- |
| `ci.yml` (desktop CI) | green | Vitest + cargo test |
| `coverage.yml` (Rust workspace coverage) | red, **pre-existing** | Fails on glib-sys; runner image lacks `libgtk-3-dev`. Out of scope for the Android work; was failing before Phase B-E too. |
| `android.yml` | green at workflow level | Build + unit tests passes; the emulator instrumented job is `continue-on-error: true` because the A1 e2e specs land RED-by-design until every screen-mount lands. |
| `release.yml` | green | Builds 3 desktop bundles + signed Android APK on tag push, uploads as draft release. |

## Common pitfalls (real ones we've already hit)

- **Don't pin `ndkVersion`.** AGP only accepts exact matches; any contributor with a slightly different NDK gets a hard fail. Drop the pin; let AGP pick the highest-installed.
- **Don't pin Tauri JS deps too loosely.** Tauri's `tauri-action` validates that `@tauri-apps/api` and the Rust `tauri` crate match on major.minor. We hit this when the JS lockfile resolved to 2.10.1 against 2.11.0 Rust.
- **Don't use `MutableSharedFlow` for one-shot UI events** (snackbars, navigation) under `runTest`. Channel-backed flows are reliable; SharedFlow's timing edge cases waste hours.
- **Don't enable JS in `MarkdownWebView` outside the `bridge != null` path.** That branch is the SelectionBridge wiring; turning JS on globally widens the attack surface.
- **Don't reach into SAF persistence directly.** Always go through `Sidecar`/`SidecarApi`. The `Sidecar.save()` path orchestrates DocumentFile-tree write or app-private mirror write per `SafCapability` — bypassing it leaks state between tiers.
- **Don't change A1 e2e specs.** See above.
- **Don't introduce a `MutableSharedFlow.replay` to "fix" tests.** It papers over a real timing bug. Use Channel.

## Where to look for context on a specific topic

- **Why is the Rust workspace structured this way?** `.claude/tcoder/2026-05-05-mdviewer-android/phase-a/` (Phase A completion notes, especially A6 on the document.rs split).
- **How does Android open a Drive doc?** `IntentDispatcher.kt` → `DocumentRepository.kt`. C2's completion notes for the SafCapability rationale.
- **How does the comment thread persist?** `Sidecar.kt` (Android), or `crates/mdviewer-core/src/sidecar.rs`. C3's completion notes for the two-tier rationale.
- **How does the WebView talk to Compose?** `SelectionBridge.kt` + `selection-bridge.js`. D2's completion notes for the JS-bridge crash-on-throw rule.
- **How does highlight injection survive recreate?** `HighlightInjector.kt` + `highlight-injector.js` + D8's `resolve_anchor` UDL surface. D8's completion notes for the orphan-flag flow.
- **How is the release built?** `.github/workflows/release.yml` + `android/app/build.gradle.kts` (release signingConfigs + R8). E4's completion notes for the keystore env-var contract.

## When in doubt

- Coverage gate fails locally? Run `./gradlew :app:testDebugUnitTestCoverage --rerun-tasks` (Gradle build cache can stale-pass).
- ManifestGoldenTest fails after a manifest edit? Regenerate via `aapt2 dump xmltree app/build/outputs/apk/debug/app-debug.apk --file AndroidManifest.xml`, extract the MainActivity section (matches `ManifestGoldenTest.extractMainActivitySection`), overwrite `android/app/src/test/resources/manifest-goldens.xml`.
- Local emulator absent — instrumented tests skipped. CI runs them. Don't try to make them green locally without an emulator.
- Adding a new package under `dev.mdviewer.*`? Add it to the C7 coverage gate's package list in `android.yml`'s "Coverage gate" step.
