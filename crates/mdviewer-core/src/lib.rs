//! mdviewer-core — anchor + comments + sidecar + render.
//!
//! Phase A populates this incrementally:
//! - A3: anchor, comments
//! - A4: auto_merge, sidecar_path
//! - A5: sidecar
//! - A6: document, assets/document.css
//!
//! Phase B layers UniFFI on top:
//! - B1: `uniffi` cargo feature gates `uniffi_bindings` + scaffolding emit.
//!   The desktop build deliberately does NOT enable this feature so its
//!   binary stays free of UniFFI's runtime + procmacro overhead. The
//!   Android shim crate (`mdviewer-jni`) pulls us with `features =
//!   ["uniffi"]` so cargo-ndk emits an `.so` consumable by Kotlin.

// UniFFI 0.28's generated scaffolding emits `///` doc comments followed
// by blank lines (cosmetic in the generator; fixed in 0.29+). The lint
// only fires when the `uniffi` feature is on, but a crate-level allow
// costs nothing on desktop builds and avoids the macro-attribute
// "unused_attributes" warning that an inner allow on the macro line
// triggers.
#![allow(clippy::empty_line_after_doc_comments)]

pub mod anchor;
pub mod auto_merge;
pub mod comments;
pub mod document;
pub mod sidecar;
pub mod sidecar_path;

// Surface the UniFFI wrappers as a regular module so `cargo test
// -p mdviewer-jni` can poke them directly. The wrappers are the bodies
// the scaffolding dispatches to; `include_scaffolding!` below stitches
// them to the generated `_UniFFILib` symbols Kotlin will dlopen.
#[cfg(feature = "uniffi")]
pub mod uniffi_bindings;

// The generated scaffolding refers to the UDL types by their bare names
// (e.g. `RenderResult`, `CommentsStoreHandle`, `CoreError`) — it expands
// at this exact include point and resolves identifiers against the
// surrounding scope. Re-export the wrappers from `uniffi_bindings` so
// those names are visible to the macro expansion below.
//
// D1 grew the surface with `create_thread` / `post_reply` /
// `resolve_thread` / `unresolve_thread` / `merge_stores` plus
// `NewThread` / `NewComment` dictionaries — every name the
// scaffolding sees here must match the UDL.
#[cfg(feature = "uniffi")]
use crate::uniffi_bindings::{
    create_thread, load_sidecar_bytes, merge_stores, post_reply, render_markdown, resolve_anchor,
    resolve_thread, save_sidecar_bytes, sidecar_filename, unresolve_thread, Anchor, Comment,
    CommentsStoreHandle, CoreError, NewComment, NewThread, RenderOptions, RenderResult,
    ResolveOutcome, SrcSpan, Thread,
};

// `include_scaffolding!` hands UniFFI's macro the path stem of the UDL
// file (`mdviewer_core` -> `mdviewer_core.udl`). The macro must run in
// the SAME crate as the UDL — moving it into `mdviewer-jni` would break
// the symbol path the generated Kotlin bindings expect. The build script
// (`build.rs` in this crate, gated by `CARGO_FEATURE_UNIFFI`) produces
// the scaffolding sources at build time; this macro pastes them into the
// crate that owns the UDL.
#[cfg(feature = "uniffi")]
uniffi::include_scaffolding!("mdviewer_core");
