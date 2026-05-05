//! Build script for mdviewer-core.
//!
//! Generates the UniFFI scaffolding (the `*_scaffolding.rs` source
//! `include_scaffolding!` pastes into `lib.rs`) when the `uniffi` feature
//! is enabled. Desktop builds (no `--features uniffi`) skip this entirely
//! — the build script returns immediately with no work done, and the
//! `uniffi_build` crate isn't even pulled in.
//!
//! ## Why the build script lives here, not in `mdviewer-jni`
//!
//! `include_scaffolding!` resolves its include path via the calling
//! crate's `OUT_DIR` env var. The macro expands inside `lib.rs` of THIS
//! crate, so the scaffolding has to land in *this* crate's `OUT_DIR`.
//! Having `mdviewer-jni`'s build script run instead would deposit the
//! scaffolding in the wrong directory, and `include_scaffolding!` would
//! fail with a confusing "file not found" message at compile time.

#[cfg(feature = "uniffi")]
fn generate() {
    // Re-run the build script when the UDL changes. Cheap and avoids
    // stale-scaffolding bugs during local development.
    println!("cargo:rerun-if-changed=src/mdviewer_core.udl");
    uniffi::generate_scaffolding("src/mdviewer_core.udl")
        .expect("UniFFI scaffolding generation failed");
}

#[cfg(not(feature = "uniffi"))]
fn generate() {
    // No-op on the desktop path. Cargo still strips `uniffi_build` from
    // the build because the optional `[build-dependencies]` entry is
    // gated behind the same feature.
}

fn main() {
    generate();
}
