//! Build script for mdviewer-jni.
//!
//! The actual UniFFI scaffolding generation lives in
//! `crates/mdviewer-core/build.rs` because `include_scaffolding!` resolves
//! its include path against the calling crate's `OUT_DIR` — and the macro
//! invocation lives in `mdviewer-core/src/lib.rs`. Splitting the build
//! script across crates would deposit the scaffolding in the wrong
//! `OUT_DIR` and the include would fail.
//!
//! What we DO need to do here:
//! - Tell Cargo to rebuild this crate when the UDL changes, so a
//!   developer editing `mdviewer_core.udl` doesn't have to remember to
//!   `touch` something in `mdviewer-jni` to trigger rebinding.
//! - Re-run on changes to the `uniffi.toml` (binding generation config),
//!   for the same reason.

fn main() {
    println!("cargo:rerun-if-changed=../mdviewer-core/src/mdviewer_core.udl");
    println!("cargo:rerun-if-changed=../mdviewer-core/uniffi.toml");
}
