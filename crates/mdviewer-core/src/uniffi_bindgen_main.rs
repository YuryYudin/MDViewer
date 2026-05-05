//! `uniffi-bindgen` host binary.
//!
//! Built only when the `uniffi` feature is on; the desktop build never
//! compiles this file because the optional `uniffi` dep isn't pulled in.
//!
//! The Android Gradle module (`:core`) invokes this binary against
//! `src/mdviewer_core.udl` to emit the generated Kotlin bindings under
//! `android/core/build/generated/uniffi/dev/mdviewer/core/mdviewer_core.kt`.
//! Keeping the bindgen entry point inside `mdviewer-core` (rather than
//! shelling out to a separately-installed `uniffi-bindgen` crate) pins
//! the bindgen version to the same `Cargo.lock` resolution as the
//! scaffolding generator, which prevents binding/scaffold drift.
fn main() {
    uniffi::uniffi_bindgen_main()
}
