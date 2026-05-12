use mdviewer_lib::settings::{
    AutoMergeMode, ExternalChangeBehavior, SettingsStore, Theme,
};
use tempfile::TempDir;

fn store() -> (SettingsStore, TempDir) {
    let tmp = TempDir::new().unwrap();
    let store = SettingsStore::open(tmp.path()).unwrap();
    (store, tmp)
}

#[test]
fn defaults_match_design() {
    let (store, _tmp) = store();
    let s = store.get();
    assert_eq!(s.appearance.theme, Theme::FollowSystem);
    assert_eq!(s.appearance.font_size_px, 14);
    // A.3 (WYSIWYG editing, Phase 1): fresh installs default to "render"
    // (the new editable render surface). Legacy "view" / "edit" values are
    // migrated reader-side — covered by tests/settings_migration.rs.
    assert_eq!(s.editor.default_open_mode, "render");
    assert!(!s.editor.render_readonly);
    assert!(s.editor.auto_save);
    assert_eq!(s.editor.auto_save_debounce_ms, 750);
    assert_eq!(s.editor.external_change_behavior, ExternalChangeBehavior::Ask);
    assert!(s.editor.syntax_highlighting);
    assert!(s.editor.mermaid_enabled);
    assert_eq!(s.comments.auto_merge, AutoMergeMode::Always);
    assert_eq!(s.comments.reattachment_confidence, 75);
    assert_eq!(s.comments.sidecar_pattern, "{name}.md.comments.json");
    assert!(s.profile.user_id.len() >= 8); // generated stable UUID
    assert_eq!(s.profile.display_name, "");
    assert!(!s.shortcuts.is_empty());
    assert!(s.advanced.sync_provider.is_none());
}

#[test]
fn round_trips_through_disk() {
    let (store, tmp) = store();
    store.update(|s| {
        s.profile.display_name = "Carol".into();
        s.profile.color = "#00aa88".into();
        s.appearance.theme = Theme::Dark;
        s.comments.reattachment_confidence = 80;
    }).unwrap();

    let reopened = SettingsStore::open(tmp.path()).unwrap();
    let s = reopened.get();
    assert_eq!(s.profile.display_name, "Carol");
    assert_eq!(s.profile.color, "#00aa88");
    assert_eq!(s.appearance.theme, Theme::Dark);
    assert_eq!(s.comments.reattachment_confidence, 80);
}

#[test]
fn change_events_are_emitted() {
    let (store, _tmp) = store();
    let rx = store.subscribe();

    store.update(|s| s.appearance.theme = Theme::Dark).unwrap();
    let event = rx.try_recv().unwrap();
    assert!(matches!(event, mdviewer_lib::settings::ChangeEvent::Appearance));
}

#[test]
fn invalid_confidence_is_clamped() {
    let (store, _tmp) = store();
    store.update(|s| s.comments.reattachment_confidence = 150).unwrap();
    assert_eq!(store.get().comments.reattachment_confidence, 100);

    store.update(|s| s.comments.reattachment_confidence = 0).unwrap();
    assert_eq!(store.get().comments.reattachment_confidence, 1);
}

// Each diff_event branch must produce its own typed event so subscribers
// can route updates to the right UI subsystem (the design's Settings page
// has six sections — Profile / Appearance / Editor / Comments / Shortcuts
// / Advanced — each rendered independently). Cover the remaining branches
// (Editor, Profile, Advanced, Shortcuts) so a regression in `diff_event`
// can't silently route, e.g., an Editor change as a Comments change.
#[test]
fn change_events_cover_all_sections() {
    use mdviewer_lib::settings::ChangeEvent;

    let (store, _tmp) = store();
    let rx = store.subscribe();

    store.update(|s| s.profile.display_name = "Dee".into()).unwrap();
    assert!(matches!(rx.try_recv().unwrap(), ChangeEvent::Profile));

    store.update(|s| s.editor.word_wrap = false).unwrap();
    assert!(matches!(rx.try_recv().unwrap(), ChangeEvent::Editor));

    store.update(|s| s.advanced.verbose_logs = true).unwrap();
    assert!(matches!(rx.try_recv().unwrap(), ChangeEvent::Advanced));

    store.update(|s| { s.shortcuts.insert("custom".into(), "Mod+X".into()); }).unwrap();
    assert!(matches!(rx.try_recv().unwrap(), ChangeEvent::Shortcuts));

    // No change → no event emitted.
    store.update(|_| {}).unwrap();
    assert!(rx.try_recv().is_err());
}

// Corrupt TOML on disk must fall back to defaults (open should not panic
// or error on a hand-edited file with bad syntax — defaults preserve
// usability and the next `update` rewrites the file cleanly).
#[test]
fn corrupt_settings_file_falls_back_to_defaults() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("settings.toml");
    std::fs::write(&path, "this = is = not valid toml ===\n").unwrap();

    let store = SettingsStore::open(tmp.path()).unwrap();
    let s = store.get();
    assert_eq!(s.appearance.theme, Theme::FollowSystem);
    assert_eq!(s.comments.reattachment_confidence, 75);
}

// Default shortcuts must include every canonical action the UI references
// (action names are the contract between this store and src/keymap.ts in
// A9). Pin the full set so accidental renames here surface as a test
// failure, not a silent UX regression.
#[test]
fn default_shortcuts_cover_canonical_actions() {
    let (store, _tmp) = store();
    let s = store.get();
    for action in [
        "open_file",
        "save_file",
        "toggle_edit",
        "close_tab",
        "comment_on_selection",
        "toggle_sidebar",
        "resolve_thread",
        "toggle_dark",
        "open_settings",
    ] {
        let combo = s.shortcuts.get(action).expect(action);
        assert!(combo.starts_with("Mod+"), "{action} should use Mod+ prefix");
    }
}
