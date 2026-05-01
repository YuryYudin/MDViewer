// src-tauri/tests/drive_settings.rs
use mdviewer_lib::settings::{BackendMode, ChangeEvent, Settings, SettingsStore};
use tempfile::TempDir;

#[test]
fn cloud_drive_defaults_are_quiet() {
    // 2025-05-01: reverted to opt-in. `feature_enabled` defaults to false
    // again; the user has to expand Settings → Drive → Advanced and click
    // Enable to see the Connect surface. Most users (including those who
    // can't get a Google Cloud OAuth client_id from their corporate IT)
    // never see the Drive API surface at all and rely on the local
    // sidecar with watcher-driven auto-reload.
    let s = Settings::default();
    assert!(!s.cloud.drive.feature_enabled);
    assert!(!s.cloud.drive.connected);
    assert_eq!(s.cloud.drive.backend_mode, BackendMode::Auto);
    assert_eq!(s.cloud.drive.poll_interval_active_secs, 5);
    assert_eq!(s.cloud.drive.poll_interval_unfocused_secs, 10);
    assert!(s.cloud.drive.account_email.is_none());
    assert!(s.cloud.drive.custom_oauth_client_id.is_none());
}

#[test]
fn cloud_drive_round_trips_through_toml() {
    let mut s = Settings::default();
    s.cloud.drive.feature_enabled = true;
    s.cloud.drive.connected = true;
    s.cloud.drive.account_email = Some("alice@example.com".into());
    s.cloud.drive.backend_mode = BackendMode::AlwaysDrive;
    s.cloud.drive.custom_oauth_client_id = Some("999.apps.googleusercontent.com".into());
    let serialized = toml::to_string(&s).unwrap();
    let parsed: Settings = toml::from_str(&serialized).unwrap();
    assert_eq!(
        parsed.cloud.drive.account_email.as_deref(),
        Some("alice@example.com")
    );
    assert_eq!(parsed.cloud.drive.backend_mode, BackendMode::AlwaysDrive);
    assert_eq!(
        parsed.cloud.drive.custom_oauth_client_id.as_deref(),
        Some("999.apps.googleusercontent.com")
    );
}

#[test]
fn legacy_settings_toml_loads_without_cloud_section() {
    let legacy = r##"
[profile]
user_id = "legacy-user"
display_name = "Legacy"
color = "#888888"

[appearance]
theme = "follow_system"
font_size_px = 14
line_height = 150
density = "comfortable"

[editor]
default_open_mode = "view"
auto_save = true
auto_save_debounce_ms = 750
external_change_behavior = "ask"
syntax_highlighting = true
mermaid_enabled = true
show_whitespace = false
word_wrap = true

[comments]
auto_merge = "always"
reattachment_confidence = 75
sidecar_pattern = "{name}.md.comments.json"
show_resolved = false

[advanced]
verbose_logs = false

[shortcuts]
"##;
    let parsed: Settings = toml::from_str(legacy).expect("legacy TOML must still parse");
    // 2025-05-01: with the opt-in revert, a legacy settings.toml without
    // `[cloud.drive]` picks up the new `false` default — users who never
    // touched the Drive integration stay on the local-sidecar default.
    assert!(!parsed.cloud.drive.feature_enabled);
}

// Mutating ONLY a `cloud.drive.*` field must produce `Some(ChangeEvent::Cloud)`
// from `diff_event` so `update()` writes to disk and emits a typed event.
// Before this fix, `diff_event` skipped the cloud branch entirely, returning
// None for cloud-only changes — which short-circuited the disk-write path,
// so toggles like BYO client_id, the connect flag, account_email, and the
// detect-toast suppression bit were silently lost on restart.
#[test]
fn cloud_only_change_emits_cloud_event() {
    let tmp = TempDir::new().unwrap();
    let store = SettingsStore::open(tmp.path()).unwrap();
    let rx = store.subscribe();

    // 2025-05-01: opt-in revert flipped default back to `false`, so the
    // meaningful state change is now flipping to `true` (user opting in
    // via Settings → Drive → Advanced → Enable). Either direction
    // exercises the same `diff_event` path.
    store
        .update(|s| s.cloud.drive.feature_enabled = true)
        .unwrap();
    let event = rx.try_recv().expect("cloud-only change must emit an event");
    assert!(matches!(event, ChangeEvent::Cloud));

    // BYO OAuth client id is the most regression-prone field — exercise it too.
    store
        .update(|s| {
            s.cloud.drive.custom_oauth_client_id =
                Some("123.apps.googleusercontent.com".into())
        })
        .unwrap();
    assert!(matches!(rx.try_recv().unwrap(), ChangeEvent::Cloud));
}

// Round-trip: cloud-only mutations must persist to settings.toml on disk.
// Reopening the store from the same directory must surface the changed
// values — proves the disk-write path is reached when only `cloud` differs.
#[test]
fn cloud_only_change_round_trips_to_disk() {
    let tmp = TempDir::new().unwrap();
    {
        let store = SettingsStore::open(tmp.path()).unwrap();
        store
            .update(|s| {
                // C5 flipped the default to `true`. Set the kill-switch
                // value explicitly so the round-trip assertion below proves
                // the *assignment* persisted (not just that the default
                // came back) — regression guard against `set_settings`
                // accidentally overwriting `cloud.drive` with the default.
                s.cloud.drive.feature_enabled = false;
                s.cloud.drive.account_email = Some("bob@example.com".into());
                s.cloud.drive.custom_oauth_client_id =
                    Some("999.apps.googleusercontent.com".into());
                s.cloud.drive.detect_toast_suppressed = true;
            })
            .unwrap();
    }

    let reopened = SettingsStore::open(tmp.path()).unwrap();
    let s = reopened.get();
    assert!(!s.cloud.drive.feature_enabled);
    assert_eq!(s.cloud.drive.account_email.as_deref(), Some("bob@example.com"));
    assert_eq!(
        s.cloud.drive.custom_oauth_client_id.as_deref(),
        Some("999.apps.googleusercontent.com")
    );
    assert!(s.cloud.drive.detect_toast_suppressed);
}
