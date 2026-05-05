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
//   - Release signing — the release keystore comes from CI env vars
//     in E4. Hard-coding a release config now would either commit a
//     fake password (broken) or fail to load (broken differently).
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
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // signingConfig wired in E4 from env vars.
        }
    }

    buildFeatures {
        compose = true
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
    // AppAuth is pinned for v2 (cloud-comments OAuth flow). Kept on the
    // classpath so the API surface stabilizes against the resolved
    // version even though no code calls it in v1.
    implementation(libs.appauth)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation(libs.robolectric)
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

    val coverageExcludes = listOf(
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

    val mainJavaClasses = fileTree(
        layout.buildDirectory.dir("intermediates/javac/debug/classes"),
    ) { exclude(coverageExcludes) }
    val mainKotlinClasses = fileTree(
        layout.buildDirectory.dir("tmp/kotlin-classes/debug"),
    ) { exclude(coverageExcludes) }

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
