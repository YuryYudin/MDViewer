// src-tauri/tests/drive_settings.rs
use mdviewer_lib::settings::{BackendMode, Settings};

#[test]
fn cloud_drive_defaults_are_quiet() {
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
    assert!(!parsed.cloud.drive.feature_enabled);
}
