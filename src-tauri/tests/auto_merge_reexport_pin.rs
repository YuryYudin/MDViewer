//! Pin: src-tauri::settings::AutoMergeMode is the same type as
//! mdviewer_core::auto_merge::AutoMergeMode (re-export, not duplicate).
//! Settings.toml deserialization continues to work.
//!
//! Why this is a pin and not a unit test: the desktop crate intentionally
//! re-exports the core enum (`pub use mdviewer_core::auto_merge::AutoMergeMode;`
//! in `src-tauri/src/settings.rs`) so that the on-disk Settings.toml shape
//! stays byte-identical after Phase A's anchor/comments/sidecar/render move
//! into `mdviewer-core`. If someone later "fixes" the re-export by reverting
//! to a duplicate desktop-side enum, downstream users' settings files would
//! still parse — but `mdviewer_core::sidecar` would no longer accept the
//! desktop's `AutoMergeMode` value as its policy parameter, breaking the
//! IPC layer at runtime. These three asserts catch that regression at
//! `cargo test` time.

use mdviewer_core::auto_merge::AutoMergeMode as CoreMode;
use mdviewer_lib::settings::AutoMergeMode as DesktopMode;
use serde::Deserialize;

#[test]
fn re_export_is_same_type() {
    // Type identity check via TypeId would be over-engineering; instead
    // assert that values cross the boundary unchanged. If `DesktopMode`
    // were a separate enum, this assignment would not compile.
    let core: CoreMode = CoreMode::Always;
    let desktop: DesktopMode = core; // succeeds only if same type
    assert!(matches!(desktop, DesktopMode::Always));
}

#[test]
fn parses_from_settings_toml_fixture() {
    #[derive(Deserialize)]
    struct CommentsBlock {
        auto_merge: DesktopMode,
    }

    let toml_str = r#"auto_merge = "always""#;
    let parsed: CommentsBlock = toml::from_str(toml_str).unwrap();
    assert!(matches!(parsed.auto_merge, DesktopMode::Always));
}

#[test]
fn parses_ask_and_manual_variants() {
    #[derive(Deserialize)]
    struct CommentsBlock {
        auto_merge: DesktopMode,
    }

    for (s, want) in [
        ("ask", DesktopMode::Ask),
        ("manual", DesktopMode::Manual),
    ] {
        let parsed: CommentsBlock =
            toml::from_str(&format!(r#"auto_merge = "{s}""#)).unwrap();
        assert_eq!(parsed.auto_merge, want);
    }
}
