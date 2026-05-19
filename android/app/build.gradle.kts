// ---------------------------------------------------------------------------
// :app — single-activity Compose host wired against the :core AAR.
//
// What this module does:
//   1. Builds the user-facing APK (`app-debug.apk` under
//      `app/build/outputs/apk/debug/`) signed with the committed debug
//      keystore at `android/keystore/debug.keystore` so install-on-device
//      and ADB-pulls work without per-developer signing setup.
//   2. Pulls the UniFFI Kotlin facade in via `implementation(project(":core"))`
//      — the AAR carries the per-ABI `.so` files plus the generated
//      `dev.mdviewer.core` bindings, so the app code can call
//      `renderMarkdown(...)` directly with no JNI boilerplate.
//   3. Hosts the Compose Navigation graph (placeholder destinations
//      stub'd here; real screens land in Phase C-E). MainActivity is
//      `singleTask` so ACTION_VIEW intents from Drive / file managers
//      reuse the existing process instead of stacking duplicate hosts.
//
// What's deliberately NOT here:
//   - `mozilla.rust.android.gradle` — that plugin only belongs on :core
//     where the cargo-ndk fan-out happens. Applying it here would
//     trigger a redundant Rust build whenever we touched UI code.
//
// Release signing (E4):
//   - The release keystore is supplied as `ANDROID_RELEASE_KEYSTORE_BASE64`
//     in CI; the build decodes it into `app/build/release-keystore.jks`,
//     signs the APK with the `ANDROID_RELEASE_KEY_*` env vars, and runs
//     the `cleanupReleaseKeystore` finalizer so the tmp file is deleted
//     on success AND failure. If the env var is missing the build falls
//     back to debug signing (with a warning) so local `assembleRelease`
//     still works for shrinker / lint verification.
//
// JaCoCo wiring (added in B5):
//   - `enableUnitTestCoverage` and `enableAndroidTestCoverage` are debug-only.
//     Instrumenting release inflates the APK without producing useful data
//     (release runs ship to users, not test suites).
//   - The custom `testDebugUnitTestCoverage` JacocoReport task aggregates
//     the unit-test execution data into XML+HTML reports under
//     `build/reports/jacoco/`. Phase C7 layers the per-package threshold
//     gate on top of this task; B5 only proves the report is produced.
// ---------------------------------------------------------------------------

// E4: explicit import — fully-qualified `java.util.Base64` doesn't resolve
// inside Kotlin DSL build scripts at the call site (the script's package
// scope shadows `java.util` for top-level lookups). The import keeps the
// release signing block readable and matches the style used elsewhere
// in this script for `JacocoTaskExtension` etc.
import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
    // C1: enables `@Serializable` codegen for the DataStore-backed stores
    // under `dev.mdviewer.data.*`. The plugin emits per-class serializers at
    // compile time so JSON round-trips on persisted RecentEntry / Profile
    // payloads don't fall back to reflection (which is slower and would
    // require shrinker rules in release builds).
    alias(libs.plugins.kotlin.serialization)
    jacoco
}

jacoco {
    // Pin the tool version so AGP's bundled JaCoCo (which can drift between
    // AGP releases) doesn't silently change the report XML schema underneath
    // the C7 coverage gate. 0.8.12 is the first release with full Java 21
    // support — keeps us forward-compatible if the toolchain bumps.
    toolVersion = "0.8.12"
}

android {
    namespace = "dev.mdviewer"
    compileSdk = 34

    defaultConfig {
        applicationId = "dev.mdviewer"
        minSdk = 26
        targetSdk = 34
        // versionCode tracks CI run number so successive uploads are
        // monotonically increasing; local dev builds get `1`. Keep this
        // in sync with the equivalent block in any future release flavor.
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        // versionName follows `git describe --tags`. The fallback covers
        // shallow clones (CI without tags fetched) and brand-new repos
        // with no tag yet — both produce a clean `0.0.0-dev` rather than
        // crashing the configuration phase.
        versionName = runCatching {
            providers.exec {
                commandLine("git", "describe", "--tags", "--abbrev=0")
                isIgnoreExitValue = true
            }.standardOutput.asText.get().trim()
        }.getOrNull()?.takeIf { it.isNotEmpty() } ?: "0.0.0-dev"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // AppAuth's library manifest declares a RedirectUriReceiverActivity
        // whose <data android:scheme="${appAuthRedirectScheme}"> placeholder
        // must resolve at merge time. v1 doesn't perform any OAuth flows
        // (cloud comments arrive in v2) but we keep the dependency pinned
        // so the resolved version stays under our control. A stub scheme
        // satisfies the merger; it is never registered with any IdP.
        manifestPlaceholders["appAuthRedirectScheme"] = "dev.mdviewer.unused"
    }

    signingConfigs {
        // The debug keystore is committed at android/keystore/debug.keystore.
        // It's the standard Android default-debug keystore — anyone holding
        // it can sign as `androiddebugkey`, but that grants nothing beyond
        // `adb install` parity with Android Studio's auto-generated key.
        getByName("debug") {
            storeFile = file("../keystore/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        // Release signing is sourced from CI secrets at build time. The
        // base64-encoded keystore is decoded into a tmp file under
        // `app/build/release-keystore.jks`, used to sign the APK, and
        // deleted by the `cleanupReleaseKeystore` finalizer below
        // (runs on assembleRelease success AND failure). If the env
        // vars are missing we fall back to debug signing so local
        // `./gradlew :app:assembleRelease` doesn't blow up on
        // configuration — the resulting APK is signed with an obviously
        // non-production cert and can never be confused for a release.
        create("release") {
            val ksB64 = System.getenv("ANDROID_RELEASE_KEYSTORE_BASE64")
            if (!ksB64.isNullOrBlank()) {
                // Use the MIME decoder, not the strict RFC 4648 decoder
                // (`Base64.getDecoder()`). `base64 mdviewer-release.jks`
                // emits a 76-char-wrapped output by default on macOS/Linux,
                // and those embedded newlines survive into a GitHub secret.
                // The strict decoder rejects whitespace with
                // `IllegalArgumentException: Input byte array has incorrect
                // ending byte` — caught us once on v0.4.11. MIME decoder
                // ignores CR/LF and is RFC-compliant for our use case.
                val tmp = layout.buildDirectory.file("release-keystore.jks").get().asFile.apply {
                    parentFile.mkdirs()
                    writeBytes(Base64.getMimeDecoder().decode(ksB64))
                }
                storeFile = tmp
                storePassword = System.getenv("ANDROID_RELEASE_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_RELEASE_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
            } else {
                // Guard against the v0.4.2–v0.4.9 footgun: if a release task is
                // requested on CI and the secret isn't wired, FAIL LOUDLY rather
                // than silently fall back to the committed debug keystore.
                // Firebase App Distribution's AppTester refuses to install APKs
                // signed with the well-known default Android Studio debug cert
                // (SHA-1 3b0439cf… — identical across every developer's machine
                // worldwide, so the cert grants no provenance). Local
                // `assembleRelease` without CI=true keeps the debug fallback so
                // contributors can still smoke a release build locally.
                val isCi = System.getenv("CI") == "true" ||
                    System.getenv("GITHUB_ACTIONS") == "true"
                val wantsRelease = gradle.startParameter.taskNames.any {
                    it.contains("Release", ignoreCase = true)
                }
                if (isCi && wantsRelease) {
                    throw GradleException(
                        "ANDROID_RELEASE_KEYSTORE_BASE64 is empty in a CI release " +
                            "build. Refusing to fall back to the committed debug " +
                            "keystore — Firebase App Distribution rejects APKs " +
                            "signed with the default Android Studio debug cert. " +
                            "Provision the four ANDROID_RELEASE_* secrets in the " +
                            "firebase-distribution environment.",
                    )
                }
                logger.warn(
                    "ANDROID_RELEASE_KEYSTORE_BASE64 not set — release build will " +
                        "fall back to debug signing. CI must export the release " +
                        "keystore env vars; this branch is for local builds only.",
                )
                storeFile = file("../keystore/debug.keystore")
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
    }

    buildTypes {
        debug {
            signingConfig = signingConfigs.getByName("debug")
            // JVM unit-test coverage: instruments classes when the
            // `testDebugUnitTest` task runs so JaCoCo can emit an .exec.
            enableUnitTestCoverage = true
            // Instrumented coverage: AGP merges per-test coverage from
            // `connectedDebugAndroidTest` runs into an emulator-side .ec
            // that the same JacocoReport task can pick up later.
            enableAndroidTestCoverage = true
        }
        release {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        // The smoke test uses Robolectric to satisfy the `:core` bindings'
        // android.os.Build references; without resources enabled
        // Robolectric blows up on classload.
        unitTests.isIncludeAndroidResources = true
        // `isReturnDefaultValues = true` makes Android-system stubs return
        // sensible zero/empty defaults instead of throwing
        // RuntimeException("Stub!"). With JaCoCo's instrumentation enabled
        // the stub paths get touched at coverage-collection time, so a
        // throwing default would fail the harness before any user code ran.
        unitTests.isReturnDefaultValues = true
        unitTests.all {
            it.maxHeapSize = "2g"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // The :core AAR carries the UniFFI bindings + per-ABI Rust .so files.
    // Everything in dev.mdviewer.core is reachable transitively via this
    // single line; no direct dependency on JNA or the Rust crates here.
    implementation(project(":core"))

    implementation(libs.core.ktx)
    implementation(libs.appcompat)
    implementation(libs.activity.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.navigation.compose)
    implementation(libs.datastore.preferences)
    // C1: JSON encoder/decoder for the DataStore-backed Recents +
    // ProfileStore + SettingsStore round-tripping. The kotlinx-serialization
    // Gradle plugin (declared above) generates the per-class serializers at
    // compile time; this dep ships the JSON format implementation those
    // generated serializers delegate to.
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.documentfile)
    // C4: WebViewAssetLoader. Lets us serve bundled assets (the shared
    // document.css, document-host.html, and the future selection-bridge.js)
    // under https://appassets.androidplatform.net/assets/ so relative
    // stylesheet hrefs resolve from inside the WebView. The asset loader
    // is the *only* legal way to ship CSS into the WebView in this app —
    // file:// access is disabled for security (see MarkdownWebView.kt).
    implementation(libs.webkit)
    // AppAuth is pinned for v2 (cloud-comments OAuth flow). Kept on the
    // classpath so the API surface stabilizes against the resolved
    // version even though no code calls it in v1.
    implementation(libs.appauth)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation(libs.robolectric)
    // C7: Robolectric loads classes through its own SandboxClassLoader,
    // bypassing the JaCoCo `-javaagent` instrumentation that AGP wires in
    // when `enableUnitTestCoverage = true`. The result is that every
    // class touched only by Robolectric tests reports 0% coverage even
    // though the tests demonstrably execute it. Switching to OFFLINE
    // instrumentation (see the `jacocoOfflineInstrument` task below)
    // bakes the JaCoCo probes into the .class files at build time, so
    // they fire regardless of whose classloader sees the bytes. The
    // runtime jar dependency below provides `org.jacoco.agent.rt`, the
    // tiny in-process probe collector that the offline-instrumented
    // bytecode references.
    testRuntimeOnly("org.jacoco:org.jacoco.agent:0.8.12:runtime")
    // C3: tests under dev.mdviewer.saf.Sidecar* exercise the UniFFI-bound
    // `loadSidecarBytes`/`saveSidecarBytes`/`sidecarFilename` helpers from
    // :core on the host JVM. The :core AAR carries the generated Kotlin
    // bindings + JNA runtime, but `Native.load("mdviewer_jni")` itself
    // needs the *host*-built `libmdviewer_jni.so` on the JNA search
    // path. We pull in the non-AAR JNA jar here (same trick :core uses
    // for its UniffiSmokeTest) and the gradle wiring below stages the
    // host library + sets `jna.library.path` for every JVM unit test
    // variant in this module.
    testImplementation("net.java.dev.jna:jna:5.14.0")
    // C1: `runTest` + StandardTestDispatcher for exercising the DataStore-
    // backed stores against a real preferences file under a Robolectric
    // Application context. The host-JVM dispatchers in coroutines-test let
    // us assert suspend writes complete deterministically without an
    // emulator.
    testImplementation(libs.kotlinx.coroutines.test)
    // ApplicationProvider.getApplicationContext() ships in androidx.test.core
    // and is the canonical way to obtain a Context inside a Robolectric
    // unit test. Pulled in alongside the AndroidJUnit4 runner from
    // androidx.test.ext:junit so the `@RunWith(AndroidJUnit4::class)` test
    // classes resolve their imports.
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    // D4: host-JVM Compose UI test rule for SelectionPopoverTest. The
    // `createComposeRule()` factory needs the BOM-resolved
    // `ui-test-junit4` artifact at unit-test compile + runtime, plus the
    // `ui-test-manifest` artifact at runtime to satisfy
    // ComponentActivity lookup inside Robolectric's host-JVM
    // sandbox. Without `ui-test-manifest`, `setContent` blows up at
    // first composition complaining the test activity is not
    // declared in any AndroidManifest reachable from the test's
    // classloader. Both artifacts inherit their version from the
    // Compose BOM the same way the main-source compose deps do.
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    // `ui-test-manifest` MUST go on `debugImplementation` (not
    // `testImplementation`). The artifact is a tiny AAR whose only job
    // is to ship a manifest declaring `androidx.activity.ComponentActivity`
    // so Robolectric's `ActivityScenario.launch(ComponentActivity::class)`
    // call inside `createComposeRule()` can resolve the launching intent.
    // Manifest merging only applies to build-type source sets — putting
    // this on `testImplementation` produces zero merged entries and the
    // tests fail with `Unable to resolve activity for Intent { ... cmp=
    // dev.mdviewer/androidx.activity.ComponentActivity }`.
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.rules)
    // Compose-UI test artifacts inherit their version from the BOM the
    // same way main-source compose deps do; without re-pulling the BOM
    // here Gradle can't resolve compose-ui-test-junit4 (the libs catalog
    // entry deliberately has no `version` so the BOM controls drift).
    androidTestImplementation(platform(libs.compose.bom))
    androidTestImplementation(libs.compose.ui.test.junit4)
    // Compose's createAndroidComposeRule needs an Activity-aware test
    // manifest helper at runtime. The e2e specs created in A1 reference
    // this transitively via ComposeTestRule.
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    // The OpenViaInAppPickerTest spec from A1 stubs the system file picker
    // via Espresso's intent recording. Kept narrow — only the picker spec
    // uses Intents; the Drive ACTION_VIEW spec deliberately avoids it so
    // the manifest filter from B4 stays the failure surface.
    androidTestImplementation("androidx.test.espresso:espresso-intents:3.6.1")
}

// ---------------------------------------------------------------------------
// Host-native libmdviewer_jni for :app JVM unit tests (C3+).
//
// :core already builds + stages the host library at
// `core/build/jniLibs-host/libmdviewer_jni.{so,dylib,dll}` so its
// UniffiSmokeTest can run on a developer's laptop without an emulator.
// :app reuses that same staged artifact rather than re-running cargo:
// the build is idempotent across modules and the host .so is identical.
//
// We hook every `:app:test*UnitTest` task to depend on `:core:stageHostLib`
// and set `jna.library.path` to the same staging dir so JNA's
// `Native.load("mdviewer_jni")` resolves before falling back to
// `/usr/lib` — mirrors the wiring in `core/build.gradle.kts`.
// ---------------------------------------------------------------------------
val coreHostLibDir = project(":core").layout.buildDirectory.dir("jniLibs-host")

tasks.withType<Test>().configureEach {
    dependsOn(":core:stageHostLib")
    doFirst {
        systemProperty("jna.library.path", coreHostLibDir.get().asFile.absolutePath)
    }
}

// ---------------------------------------------------------------------------
// Host-JVM unit tests are a debug-variant-only contract. The Compose UI
// tests rely on `androidx.compose.ui:ui-test-manifest` which is wired via
// `debugImplementation` (see the long comment in the dependencies block)
// because manifest merging only happens on build-type source sets. Running
// `:app:testReleaseUnitTest` therefore fails ~50 UI tests with
// `Unable to resolve activity for Intent { ... cmp=
// dev.mdviewer/androidx.activity.ComponentActivity }` — the activity
// declaration is simply absent from the release manifest by design.
//
// `./gradlew build` aggregates `check`, which would fan out to both
// variants and fail every time. Disable the release-variant unit test
// task so `build` stays green on the documented debug-only flow without
// pretending the release variant has working host-JVM tests.
// ---------------------------------------------------------------------------
tasks.matching { it.name == "testReleaseUnitTest" }.configureEach {
    enabled = false
}

// ---------------------------------------------------------------------------
// JacocoReport aggregator (B5).
//
// AGP's `enableUnitTestCoverage` instruments classes and emits a per-test
// `.exec` under `build/outputs/unit_test_code_coverage/debugUnitTest/`. By
// itself that's a binary blob — the JacocoReport task below turns it into
// human-readable XML+HTML.
//
// We point `classDirectories` at BOTH the Java javac output and the Kotlin
// compiler's intermediate output because Android projects mix the two and
// JaCoCo's instrumenter only sees the bytecode it's pointed at. Excluding
// generated R/BuildConfig/databinding classes keeps the denominator honest
// — those are not project code and shouldn't drag the coverage % down.
//
// The C7 task adds a per-package threshold gate on top of this report. B5
// stops at "report exists, exit 0".
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// JaCoCo coverage shared config (B5 + C7).
//
// `coverageExcludes` is referenced in two places:
//   1. The offline-instrumentation task below — we must NOT instrument R/
//      BuildConfig/test classes; instrumenting tests inflates coverage to
//      100% trivially.
//   2. The JacocoReport aggregator — the report's `classDirectories` view
//      must apply the same exclusions so the denominator matches what was
//      instrumented.
// Pulled out as a top-level val so a future excludes drift between the two
// is impossible.
// ---------------------------------------------------------------------------
// Generated / non-project classes that should never be instrumented and
// should never count toward coverage. Tests are excluded so a 100%-self-
// covering test class doesn't inflate the denominator.
val instrumentationExcludes = listOf(
    "**/R.class",
    "**/R$*.class",
    "**/BuildConfig.*",
    "**/Manifest*.*",
    "**/*Test*.*",
    "android/**/*.*",
    "**/databinding/**/*.*",
    "**/dagger/**/*.*",
    "**/hilt_aggregated_deps/**",
    "**/*_Hilt*.*",
    "**/*Hilt*Module*.*",
)

// Production-only adapters that ARE instrumented and shipped to the runtime
// classpath (other production code instantiates them) but are stripped from
// the JacocoReport's `classDirectories` view because Robolectric cannot
// host their underlying Android-framework surfaces. Excluding them from
// instrumentation entirely would break the runtime classpath; excluding
// them from the report just keeps the denominator honest about what host-
// JVM tests can realistically reach.
val reportOnlyExcludes = listOf(
    // SAF adapters that wrap `androidx.documentfile`. They exist as a
    // seam (see `Sidecar.kt`) so unit tests can inject in-memory fakes;
    // running them on host-JVM would require a genuine DocumentsContract
    // provider, which Robolectric does not ship. C3's tests cover
    // Sidecar through `FakeTreeNode` instead.
    "**/saf/DocumentFileNode*.*",
    "**/saf/DocumentFileTreeAccess*.*",
    // MarkdownWebView is a Compose AndroidView wrapping a real WebView;
    // WebView's classes throw immediately under Robolectric. C4's
    // instrumented test under `androidTest/` covers the screen path on
    // an emulator.
    "**/render/MarkdownWebView*.*",
    // D2: SelectionWebView intercepts startActionMode to swap in our
    // SuppressingActionModeCallback. Same Robolectric/WebView limitation.
    // The instrumented test under `androidTest/render/` exercises the
    // ActionMode override path on an emulator.
    "**/render/SelectionWebView*.*",
)

val coverageExcludes = instrumentationExcludes + reportOnlyExcludes

// ---------------------------------------------------------------------------
// jacocoOfflineInstrument (C7) — the fix for Robolectric's coverage gap.
//
// Robolectric's `SandboxClassLoader` redefines every class it loads to
// rewrite Android-system stubs at load time. The JVM `-javaagent` JaCoCo
// agent that AGP wires in via `enableUnitTestCoverage = true` only
// transforms classes loaded by the *system* classloader; everything
// Robolectric loads bypasses the agent and ends up with zero probes.
//
// Offline instrumentation sidesteps this entirely: we ask JaCoCo to
// rewrite the .class files on disk before tests run, baking the probes
// into the bytecode. Then *any* classloader that reads the file —
// including Robolectric's — sees the instrumented version, and the
// runtime probe collector (`org.jacoco.agent.rt`) records the hits at
// test time without needing a JVM-level agent.
//
// This task uses the JaCoCo Ant `Instrument` task; the Ant tasks ship
// inside the `org.jacoco.ant` jar that the Gradle JaCoCo plugin already
// pulls onto the buildscript classpath via the configuration named
// `jacocoAnt`. We delegate to ant via `ant.invokeMethod("instrument")`
// rather than wiring up the Java class directly so the task self-resolves
// the toolVersion JaCoCo we pinned above (0.8.12) without us having to
// thread a dep through configurations.
// ---------------------------------------------------------------------------
val jacocoInstrumentedDir =
    layout.buildDirectory.dir("intermediates/jacoco-instrumented-classes/debug")

val jacocoOfflineInstrument by tasks.registering {
    group = "verification"
    description = "Offline-instruments :app's debug classes for Robolectric coverage."

    dependsOn("compileDebugKotlin", "compileDebugJavaWithJavac")

    val javaClasses = layout.buildDirectory.dir("intermediates/javac/debug/classes")
    val kotlinClasses = layout.buildDirectory.dir("tmp/kotlin-classes/debug")
    val outDir = jacocoInstrumentedDir

    // Track input as a FileTree (not inputs.dir) so a missing source root
    // is treated as "no inputs" rather than a hard validation failure.
    // Java-free Kotlin modules and vice-versa are both legitimate states
    // for AGP intermediate outputs; the Ant task below short-circuits when
    // a root is absent.
    inputs.files(
        fileTree(kotlinClasses) { include("**/*.class") },
        fileTree(javaClasses) { include("**/*.class") },
    ).withPropertyName("classRoots")
    outputs.dir(outDir).withPropertyName("instrumentedClasses")

    // Resolve the JaCoCo Ant tasks at configuration time so the Ant taskdef
    // call below picks the same 0.8.12 toolVersion the report uses.
    val jacocoAntCfg = configurations["jacocoAnt"]
    inputs.files(jacocoAntCfg).withPropertyName("jacocoAnt")

    // Only generated/non-project classes are dropped from instrumentation;
    // the report-only excludes (DocumentFileTreeAccess, MarkdownWebView,
    // SelectionWebView) MUST stay on the classpath because production
    // code transitively loads them (Sidecar -> DocumentFileTreeAccess,
    // MarkdownWebView -> SelectionWebView). The JacocoReport task below
    // applies the full `coverageExcludes` to its denominator.
    val excludesCopy = instrumentationExcludes
    doLast {
        val outRoot = outDir.get().asFile
        outRoot.deleteRecursively()
        outRoot.mkdirs()

        ant.withGroovyBuilder {
            "taskdef"(
                "name" to "jacocoInstrument",
                "classname" to "org.jacoco.ant.InstrumentTask",
                "classpath" to jacocoAntCfg.asPath,
            )
        }

        // Run the JaCoCo Ant `instrument` task once per source root. Both
        // root paths are optional — Kotlin-only modules have no javac
        // output and vice-versa — so we skip absent dirs to keep the task
        // idempotent against trimmed builds.
        listOf(kotlinClasses.get().asFile, javaClasses.get().asFile).forEach { src ->
            if (!src.exists()) return@forEach
            ant.withGroovyBuilder {
                "jacocoInstrument"("destdir" to outRoot) {
                    "fileset"("dir" to src) {
                        "include"("name" to "**/*.class")
                        excludesCopy.forEach { pattern ->
                            "exclude"("name" to pattern)
                        }
                    }
                }
            }
        }
    }
}

// Wire the unit-test task to consume the offline-instrumented classes
// instead of the originals. We:
//   * Disable the on-the-fly JaCoCo agent (the source of the Robolectric
//     gap) so it doesn't double-instrument and produce mismatched probe
//     IDs that JaCoCo would then fail to aggregate.
//   * Set `jacoco-agent.destfile` so the runtime probe collector writes
//     its `.exec` to a path the JacocoReport task below picks up. The
//     "output=file" mode avoids the TCP listener default that would
//     hang the test JVM on shutdown.
//   * Prepend the instrumented classes dir to the test classpath so
//     class resolution prefers the rewritten bytecode.
// AGP creates the per-variant `testDebugUnitTest` task lazily (well after
// the build script's top-level `evaluate` finishes), so referencing it by
// name at config time would be too eager. The `tasks.withType<Test>` view
// is created up-front and matches AGP's task as soon as it lands; we
// guard with the name check so the wiring only applies to the debug unit-
// test variant (and not, say, a future testReleaseUnitTest).
val instrumentedClassesProvider = jacocoInstrumentedDir
val execFileProvider = layout.buildDirectory.file(
    "outputs/unit_test_code_coverage/debugUnitTest/testDebugUnitTest.exec",
)

tasks.withType<Test>().configureEach {
    if (name != "testDebugUnitTest") return@configureEach

    dependsOn(jacocoOfflineInstrument)

    // Ditch the on-the-fly agent — it's the proximate cause of the 0%
    // Robolectric reports. Keeping it on alongside offline instrumentation
    // would emit two probe sets and double-count on the merge.
    extensions.configure(JacocoTaskExtension::class) {
        isEnabled = false
    }

    doFirst {
        // Make sure the parent dir exists; the runtime collector won't
        // mkdir on its own and would silently emit nothing if the path
        // is missing.
        execFileProvider.get().asFile.parentFile.mkdirs()

        systemProperty(
            "jacoco-agent.destfile",
            execFileProvider.get().asFile.absolutePath,
        )
        systemProperty("jacoco-agent.output", "file")
        systemProperty("jacoco-agent.dumponexit", "true")

        // Replace AGP's bundled-runtime-classes jar with the offline-
        // instrumented dir on the test classpath. AGP's
        // `bundleDebugClassesToRuntimeJar` task packages :app's compiled
        // classes into one fat jar
        // (`runtime_app_classes_jar/.../classes.jar`) and that jar — not
        // the raw class outputs — is what AGP threads onto the unit-test
        // runtime classpath. Simply *prepending* the instrumented dir
        // doesn't help: the classloader is happy with whichever copy it
        // sees first only when the names disagree, and our instrumented
        // classes share the same FQNs as the jar's, so JVM merge order
        // picks the bundled-jar version on most runs (depends on URL
        // ordering).
        //
        // The fix is to filter the bundled jar OUT of the classpath and
        // add our instrumented dir back in its place. The classpath is
        // otherwise the same — third-party deps (Kotlin stdlib, Compose,
        // AppAuth, etc.) remain unchanged because we only filter the file
        // whose path matches the AGP bundle marker.
        //
        // Done in `doFirst` rather than at configuration time because AGP
        // wires the classpath value AFTER `configureEach` returns; an
        // earlier reassignment is silently overwritten.
        classpath = files(instrumentedClassesProvider) +
            classpath.filter { f ->
                !f.absolutePath.contains("runtime_app_classes_jar")
            }
    }
}

tasks.register<JacocoReport>("testDebugUnitTestCoverage") {
    group = "verification"
    description = "Generates JaCoCo XML+HTML coverage from testDebugUnitTest."

    dependsOn("testDebugUnitTest")

    reports {
        xml.required.set(true)
        html.required.set(true)
        html.outputLocation.set(
            layout.buildDirectory.dir("reports/jacoco/testDebugUnitTestCoverage"),
        )
        xml.outputLocation.set(
            layout.buildDirectory.file("reports/jacoco/testDebugUnitTestCoverage.xml"),
        )
    }

    val mainJavaClasses = fileTree(
        layout.buildDirectory.dir("intermediates/javac/debug/classes"),
    ) { exclude(coverageExcludes) }
    val mainKotlinClasses = fileTree(
        layout.buildDirectory.dir("tmp/kotlin-classes/debug"),
    ) { exclude(coverageExcludes) }

    // The report MUST point at the *original* (non-instrumented) classes,
    // not the offline-instrumented copies. JaCoCo uses the original class
    // bytecode + the .exec probe IDs to compute coverage; pointing at the
    // instrumented copies would either double-count or miss the line
    // tables entirely.
    classDirectories.setFrom(files(mainJavaClasses, mainKotlinClasses))
    sourceDirectories.setFrom(files("src/main/kotlin", "src/main/java"))
    executionData.setFrom(
        fileTree(layout.buildDirectory).include(
            // AGP 8.x writes here when `enableUnitTestCoverage = true`.
            "outputs/unit_test_code_coverage/debugUnitTest/testDebugUnitTest.exec",
            // Older AGP path; kept as a fallback so the report still
            // generates if the layout regresses on a toolchain bump.
            "jacoco/testDebugUnitTest.exec",
        ),
    )
}

// ---------------------------------------------------------------------------
// copyCoreCss (C4) — single-source the rendered-document stylesheet.
//
// The canonical `document.css` lives at `crates/mdviewer-core/assets/` so
// desktop and Android render with byte-identical CSS. Rather than commit a
// duplicate copy under `app/src/main/assets/`, we copy at build time. The
// task is wired before `preBuild` so every Gradle invocation (assembleDebug,
// connectedDebugAndroidTest, IDE sync, etc.) refreshes the asset before AGP
// merges it into the APK.
//
// Why `rootProject.file("../crates/...")`:
//   - `rootProject` here is the `android/` Gradle root (declared in
//     settings.gradle.kts). `../crates/...` walks one level up to the
//     repository root, then into the workspace crate. This keeps the path
//     stable across worktrees and CI checkouts where `android/` is always
//     the gradle root regardless of where the repo lives on disk.
//
// Why we don't bake the CSS into a Kotlin string constant:
//   - Two source-of-truth files would drift the moment someone edited the
//     desktop stylesheet without remembering to mirror the change. The
//     "shared CSS asset" rule from the design doc depends on this task.
// ---------------------------------------------------------------------------
val copyCoreCss by tasks.registering(Copy::class) {
    description = "Copies crates/mdviewer-core/assets/document.css into app assets."
    group = "build"
    from(rootProject.file("../crates/mdviewer-core/assets/document.css"))
    into(layout.projectDirectory.dir("src/main/assets"))
}

tasks.named("preBuild") { dependsOn(copyCoreCss) }

// ---------------------------------------------------------------------------
// Release keystore cleanup (E4).
//
// The release signingConfig above decodes ANDROID_RELEASE_KEYSTORE_BASE64
// into `app/build/release-keystore.jks`. Once `assembleRelease` finishes —
// success OR failure — the tmp file MUST be deleted so a leaked keystore
// from a failed build never lingers on a CI worker (security incident
// otherwise: anyone with shell access could harvest it from the workspace
// before the next checkout cleared it).
//
// `finalizedBy` is the canonical Gradle pattern for this: a finalizer
// runs whether the finalized task succeeded, failed, or was skipped. A
// plain `doLast { ... }` only fires on success and would leak the
// keystore on any signing/lint/R8 failure, which is the exact regime
// we're trying to harden against.
// ---------------------------------------------------------------------------
val releaseKeystoreTmp = layout.buildDirectory.file("release-keystore.jks")

val cleanupReleaseKeystore by tasks.registering {
    description = "Deletes the temp release keystore decoded from " +
        "ANDROID_RELEASE_KEYSTORE_BASE64 — runs on success AND failure."
    doLast {
        val tmp = releaseKeystoreTmp.get().asFile
        if (tmp.exists()) {
            tmp.delete()
            logger.lifecycle("Deleted release keystore tmp: ${tmp.absolutePath}")
        }
    }
}

// AGP creates `assembleRelease` lazily during its `afterEvaluate` callback,
// so referencing it via `tasks.named(...)` at top level fails at config
// time with "Task not found". `tasks.matching` returns a live view that
// finalizesBy gets wired into as soon as AGP registers the task.
tasks.matching { it.name == "assembleRelease" }.configureEach {
    finalizedBy(cleanupReleaseKeystore)
}
