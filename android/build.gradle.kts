plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.compose.compiler) apply false
    // Phase C1 introduced kotlinx-serialization for DataStore round-tripping.
    // Declared root-level (`apply false`) so subprojects opt in explicitly —
    // :core's UniFFI bindings don't need it, only :app does today.
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.mozilla.rust.android.gradle) apply false
}
