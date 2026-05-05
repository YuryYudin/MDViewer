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
//   - JaCoCo / coverage wiring — added in B5 once a representative
//     UI-side test exists to cover; instrumenting an empty module
//     just slows the green build down.
//   - Release signing — the release keystore comes from CI env vars
//     in E4. Hard-coding a release config now would either commit a
//     fake password (broken) or fail to load (broken differently).
// ---------------------------------------------------------------------------

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.compose.compiler)
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
            // JaCoCo wiring lands in B5.
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
    implementation(libs.documentfile)
    // AppAuth is pinned for v2 (cloud-comments OAuth flow). Kept on the
    // classpath so the API surface stabilizes against the resolved
    // version even though no code calls it in v1.
    implementation(libs.appauth)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation("org.jetbrains.kotlin:kotlin-test")
    testImplementation(libs.robolectric)

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
}
