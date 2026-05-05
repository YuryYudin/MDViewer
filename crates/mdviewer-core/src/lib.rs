//! mdviewer-core — anchor + comments + sidecar + render.
//!
//! Phase A populates this incrementally:
//! - A3: anchor, comments
//! - A4: auto_merge, sidecar_path
//! - A5: sidecar
//! - A6: document, assets/document.css

pub mod anchor;
pub mod auto_merge;
pub mod comments;
pub mod document;
pub mod sidecar_path;
