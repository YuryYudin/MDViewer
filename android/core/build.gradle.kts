// ---------------------------------------------------------------------------
// :core — UniFFI-bound JNI shim wrapped in an Android library.
//
// What this module does:
//   1. Drives `cargo ndk` via mozilla.rust-android-gradle to cross-compile
//      `crates/mdviewer-jni` into per-ABI shared objects (arm64-v8a,
//      armeabi-v7a, x86_64) packaged into the AAR's `jniLibs/` tree.
//   2. Runs `uniffi-bindgen` against `crates/mdviewer-core/src/mdviewer_core.udl`
//      to emit the generated Kotlin bindings under
//      `build/generated/uniffi/dev/mdviewer/core/mdviewer_core.kt`.
//   3. Builds a *host* (linux/x86_64 or darwin) copy of the same crate
//      so JVM unit tests on the developer's laptop can exercise the
//      bindings without needing an emulator. The host `.so` is staged
//      into `build/jniLibs-host/` and surfaced to the JVM via
//      `jna.library.path` so `Native.load("mdviewer_jni")` finds it.
//
// What's deliberately NOT here:
//   - x86 (32-bit) — the Play Store has refused 32-bit-only x86 since
//     2019; saving the cross-compile time and APK bloat is free.
//   - Resource processing / Compose plugin — `:core` is FFI plumbing
//     only; UI-side Composables live in `:app`.
//   - R8 / minification — `:app` is the only consumer and runs R8 on
//     the merged classpath; double-shrinking would just make stack
//     traces harder to read.
// ---------------------------------------------------------------------------

import java.io.File
import java.util.Properties

plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.mozilla.rust.android.gradle)
}

// ---------------------------------------------------------------------------
// NDK resolution — glob what's installed, fall back to a CI-tracked pin.
//
// AGP and the mozilla rust-android-gradle plugin both resolve the NDK via
// BaseExtension.ndkDirectory, which:
//   - if `ndkVersion` is set, looks for $ANDROID_HOME/ndk/<version>/.
//   - if `ndkVersion` is unset, falls back to AGP's compiled-in default
//     and IGNORES $ANDROID_NDK_HOME / $ANDROID_NDK_ROOT entirely.
//
// Two failure modes we have to thread between:
//
//   (a) Pinning an exact version (the pre-b189f8e state) forced every
//       contributor to download exactly that byte-identical NDK. NDK
//       releases churn quarterly and a stale pin ages badly: any
//       developer opening the project in Android Studio without that
//       exact version got "NDK is not installed" rather than building.
//
//   (b) Leaving `ndkVersion` unset (b189f8e's attempt) made AGP fall
//       back to its compiled-in default and ignore $ANDROID_NDK_HOME.
//       Whenever the runner image happened to ship a different NDK
//       (currently r29 preview, which AGP 8.5 rejects anyway), the
//       build failed regardless of how we set env vars.
//
// What works for both: glob $ANDROID_HOME/ndk/ ourselves, pick the
// highest-installed AGP-compatible NDK, and only fall back to a hard
// pin when nothing compatible is installed. CI installs r27.2.12479018
// explicitly so the glob picks that there. Locally, contributors who
// already have any NDK in the supported range build immediately; those
// who don't get Android Studio's standard "Install NDK <X>" prompt
// rather than an unhelpful "NDK is not installed" failure (because
// `ndkVersion` always ends up set to a specific version, and AS knows
// how to offer the SDK Manager install for an unset NDK).
//
// Bump `supportedNdkMajors` and `fallbackNdkVersion` together when
// bumping AGP — AGP release notes specify the supported NDK range. AGP
// 8.5 accepts r25 through r27; latest r27 GA is r27.2.12479018.
private val supportedNdkMajors = 25..27
private val fallbackNdkVersion = "27.2.12479018"

private fun resolveAndroidSdkRoot(rootProj: org.gradle.api.Project): String? {
    val env = System.getenv("ANDROID_HOME") ?: System.getenv("ANDROID_SDK_ROOT")
    if (env != null) return env
    val localProps = rootProj.file("local.properties")
    if (!localProps.exists()) return null
    val props = Properties()
    localProps.inputStream().use { props.load(it) }
    return props.getProperty("sdk.dir")
}

// Lex-sort key with each segment zero-padded so "27.2.12479018" sorts
// higher than "27.2.9519653" (10 chars vs 7 chars in last segment;
// raw string sort would put the shorter one ahead).
private fun ndkSortKey(name: String): String =
    name.split(".").joinToString(".") { it.padStart(10, '0') }

private fun pickInstalledNdk(sdkRoot: String?): String? {
    if (sdkRoot == null) return null
    val children = File(sdkRoot, "ndk").listFiles { f: File -> f.isDirectory }
        ?: return null
    return children
        .map { it.name }
        .filter { name ->
            val major = name.substringBefore(".").toIntOrNull() ?: -1
            major in supportedNdkMajors
        }
        .sortedBy { ndkSortKey(it) }
        .lastOrNull()
}

android {
    namespace = "dev.mdviewer.core"
    compileSdk = 34

    ndkVersion = pickInstalledNdk(resolveAndroidSdkRoot(rootProject))
        ?: fallbackNdkVersion

    defaultConfig {
        minSdk = 26
        // ABI fan-out: cargo-ndk emits these targets, AGP packages them
        // under jniLibs/<abi>/ inside the AAR. Keep this list in sync
        // with the `cargo { targets = ... }` block below — drift causes
        // either a missing ABI at install time or wasted build cycles
        // for an ABI that never ships.
        ndk {
            abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
        }
        consumerProguardFiles("proguard-rules.pro")
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            // R8 runs on the :app module against the merged classpath;
            // shrinking here would only delay the inevitable and burn
            // build time on every :core change.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The UniFFI codegen task lands its Kotlin output under
    // build/generated/uniffi/dev/mdviewer/core/. Pointing the main source
    // set at that directory means `kotlinCompile` picks up the bindings
    // without an extra wiring layer; the `dependsOn` further down keeps
    // the Kotlin compile waiting on bindgen.
    sourceSets["main"].kotlin.srcDir(layout.buildDirectory.dir("generated/uniffi"))

    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric pulls heavy resources — give the test JVM enough
        // headroom that a cold run on CI doesn't OOM mid-classload.
        unitTests.all {
            it.maxHeapSize = "2g"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

// ---------------------------------------------------------------------------
// Cargo-ndk configuration. The plugin shells out to `cargo ndk -t <abi>...
// build` against `crates/mdviewer-jni/`, which transitively pulls in
// `mdviewer-core` with the `uniffi` feature on (declared in that crate's
// Cargo.toml `[dependencies]`). The result is one `.so` per ABI under
// `target/<rust-triple>/release/libmdviewer_jni.so`; the plugin then
// stages those into AGP's jniLibs input set.
// ---------------------------------------------------------------------------
cargo {
    module = "../../crates/mdviewer-jni"
    libname = "mdviewer_jni"
    // Plugin alias names: arm64 -> aarch64-linux-android,
    // arm -> armv7-linux-androideabi, x86_64 -> x86_64-linux-android.
    targets = listOf("arm64", "arm", "x86_64")
    profile = "release"
    targetIncludes = arrayOf("libmdviewer_jni.so")
    // The Cargo workspace at `<repo>/Cargo.toml` puts every crate's
    // build artifacts under `<repo>/target/`. Without this override
    // the plugin would look under `crates/mdviewer-jni/target/`
    // (its `module` arg) and find nothing — copying zero `.so` files
    // into rustJniLibs and producing an empty AAR.
    targetDirectory = "../../target"

    // Most modern Linux distros only ship `python3`, not `python`.
    // The plugin's linker wrapper shells out to `${pythonCommand}`;
    // pinning it to `python3` keeps Ubuntu 22.04+ runners building
    // without needing a `python-is-python3` symlink package.
    pythonCommand = "python3"
}

// ---------------------------------------------------------------------------
// Python 3.13 removed the `pipes` stdlib module (PEP 594). The
// rust-android-gradle 0.9.4 linker wrapper still does `import pipes`
// and calls `pipes.quote`, so on Homebrew Python 3.13+ the link step
// dies with `ModuleNotFoundError: No module named 'pipes'`. The plugin
// is unmaintained — no fixed release exists.
//
// `pipes.quote` was just an alias for `shlex.quote` since Python 3.3,
// so rewriting the import is a behavior-preserving fix. We patch the
// freshly-generated file every time `generateLinkerWrapper` runs.
// Idempotent: re-running on an already-patched file is a no-op.
// ---------------------------------------------------------------------------
rootProject.tasks.matching { it.name == "generateLinkerWrapper" }.configureEach {
    doLast {
        val py = rootProject.layout.buildDirectory
            .file("linker-wrapper/linker-wrapper.py").get().asFile
        if (py.exists()) {
            val before = py.readText()
            val after = before.replace("import pipes", "import shlex as pipes")
            if (before != after) py.writeText(after)
        }
    }
}

// ---------------------------------------------------------------------------
// UniFFI Kotlin codegen. Invokes the `uniffi-bindgen` host bin we
// expose from `crates/mdviewer-core/Cargo.toml` so the bindgen version
// stays pinned to the same Cargo.lock resolution as the scaffolding
// generator (a version mismatch between the two ends with cryptic
// "wrong number of arguments" failures at runtime).
// ---------------------------------------------------------------------------
val uniffiOutDir = layout.buildDirectory.dir("generated/uniffi")
val coreCrateDir = file("../../crates/mdviewer-core")
val udlFile = coreCrateDir.resolve("src/mdviewer_core.udl")
val uniffiToml = coreCrateDir.resolve("uniffi.toml")

val uniffiBindgen = tasks.register<Exec>("uniffiBindgen") {
    group = "uniffi"
    description = "Generate Kotlin bindings from mdviewer_core.udl"

    inputs.file(udlFile)
    inputs.file(uniffiToml)
    outputs.dir(uniffiOutDir)

    workingDir = rootProject.projectDir.parentFile
    commandLine(
        "cargo", "run",
        "--manifest-path", "crates/mdviewer-core/Cargo.toml",
        "--features", "uniffi",
        "--bin", "uniffi-bindgen",
        "--quiet",
        "--",
        "generate", udlFile.absolutePath,
        "--language", "kotlin",
        "--out-dir", uniffiOutDir.get().asFile.absolutePath,
        "--config", uniffiToml.absolutePath,
        // ktlint isn't on the host; disabling auto-format suppresses a
        // noisy warning without affecting correctness (the bindings
        // compile fine without prettification).
        "--no-format",
    )
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    dependsOn(uniffiBindgen)
}

// AGP's preBuild aggregates everything that has to happen before any
// per-variant tasks; hooking cargoBuild here means assembleDebug /
// assembleRelease both pick up the ABI .so files automatically.
tasks.matching { it.name == "preBuild" }.configureEach {
    dependsOn("cargoBuild")
}

// ---------------------------------------------------------------------------
// Host-side libmdviewer_jni for JVM unit tests.
//
// The cross-compiled Android `.so` files in `target/<triple>/release/`
// are ELF binaries linked against the Android C runtime; the developer's
// JVM can't dlopen them. We run a separate plain `cargo build --release
// -p mdviewer-jni --features uniffi` whose output goes to `target/release/`
// — that one is host-native and JNA-loadable.
//
// The output directory is staged at `build/jniLibs-host/` so we have a
// stable path to feed `jna.library.path` regardless of where Cargo
// chose to put `target/` (workspace root vs. crate root).
// ---------------------------------------------------------------------------
val workspaceRoot = rootProject.projectDir.parentFile
val hostLibName: String = when {
    org.gradle.internal.os.OperatingSystem.current().isLinux -> "libmdviewer_jni.so"
    org.gradle.internal.os.OperatingSystem.current().isMacOsX -> "libmdviewer_jni.dylib"
    org.gradle.internal.os.OperatingSystem.current().isWindows -> "mdviewer_jni.dll"
    else -> error("Unsupported host OS for JVM unit tests")
}
val hostLibStagingDir = layout.buildDirectory.dir("jniLibs-host")

val cargoHostBuild = tasks.register<Exec>("cargoHostBuild") {
    group = "rust"
    description = "Build a host-native libmdviewer_jni for JVM unit tests"

    workingDir = workspaceRoot
    commandLine(
        "cargo", "build",
        "--release",
        "-p", "mdviewer-jni",
        "--features", "mdviewer-core/uniffi",
    )

    // Treat every Rust source under the two FFI crates as input so a
    // change to wrapper code or the UDL re-runs this. Keeping inputs
    // narrow (don't sweep the whole workspace) avoids re-running on
    // unrelated edits to e.g. src-tauri.
    inputs.dir(coreCrateDir.resolve("src"))
    inputs.dir(workspaceRoot.resolve("crates/mdviewer-jni/src"))
    inputs.file(coreCrateDir.resolve("Cargo.toml"))
    inputs.file(workspaceRoot.resolve("crates/mdviewer-jni/Cargo.toml"))
    outputs.file(workspaceRoot.resolve("target/release/$hostLibName"))
}

val stageHostLib = tasks.register<Copy>("stageHostLib") {
    group = "rust"
    description = "Copy the host-native libmdviewer_jni into the test JNA path"
    dependsOn(cargoHostBuild)
    from(workspaceRoot.resolve("target/release/$hostLibName"))
    into(hostLibStagingDir)
}

// Wire the host build into every JVM unit-test task variant. The
// `withType<Test>` form catches `testDebugUnitTest`, `testReleaseUnitTest`,
// and any future variants without us having to keep an explicit list.
tasks.withType<Test>().configureEach {
    dependsOn(stageHostLib)
    doFirst {
        // JNA prepends jna.library.path to its dlopen search list, so
        // `Native.load("mdviewer_jni", ...)` resolves to our staged
        // host binary rather than wandering off into /usr/lib.
        systemProperty("jna.library.path", hostLibStagingDir.get().asFile.absolutePath)
    }
}

// ---------------------------------------------------------------------------
// Dependencies. Keep this minimal: anything beyond JNA + the Android
// support shim leaks into every consumer of the AAR.
// ---------------------------------------------------------------------------
dependencies {
    // Android support classes referenced by the generated bindings
    // (Build.VERSION_CODES, RequiresApi).
    implementation(libs.core.ktx)
    implementation("androidx.annotation:annotation:1.8.0")
    // UniFFI's Kotlin runtime is pure JNA; pinning the AAR variant
    // keeps R8 / multidex happy on Android.
    implementation("net.java.dev.jna:jna:5.14.0@aar")

    testImplementation(libs.junit)
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    // Robolectric provides shadow android.os.Build / SDK_INT so the
    // generated bindings (which use those for cleaner-strategy
    // selection under `android_cleaner = true`) load on a host JVM.
    testImplementation(libs.robolectric)
    // The non-AAR JNA jar is what JVM tests actually load; the AAR
    // variant is unpacked only on Android.
    testImplementation("net.java.dev.jna:jna:5.14.0")
}
