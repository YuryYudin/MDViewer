// src-tauri/tests/drive_feature_flag.rs
//
// C5: pins the Phase 3 flip of `cloud.drive.feature_enabled` from `false`
// (A1's Phase-2 default — "feature is hidden, OAuth + Drive surfaces are
// guarded behind the flag while we build them out") to `true` (Phase 3 —
// "feature is on by default, users opt out by hand if they want the
// pre-Phase-3 behavior back"). The dedicated test file keeps drive tests
// grouped under `drive_*` per the existing convention (drive_settings.rs,
// drive_open_url.rs, drive_save_conflict.rs, etc.).
//
// Two contracts pinned here:
//
//   1. The new default is `true`. Every fresh install gets the Drive
//      surface unhidden without any per-user TOML edit.
//
//   2. A user who *explicitly* sets `feature_enabled = false` in their
//      settings.toml keeps that setting through the round trip. Without
//      this guarantee the kill-switch in `src-tauri/src/main.rs` would
//      have nothing to read — `serde(default)` would silently overwrite
//      the user's opt-out on next load.

use mdviewer_lib::settings::{drive_kill_switch_active, Settings};

#[test]
fn feature_enabled_default_true() {
    let s = Settings::default();
    assert!(
        s.cloud.drive.feature_enabled,
        "Phase 3 flips this to true — the Drive surface ships on by default",
    );
}

#[test]
fn explicit_user_override_to_false_is_preserved_through_round_trip() {
    // The user's settings.toml contains an explicit opt-out under
    // `[cloud.drive]`. Required top-level sections still need to be present
    // so the rest of the Settings struct deserializes cleanly — this is the
    // shape settings.toml takes after a normal first-launch write.
    //
    // The assertion below proves the explicit `false` survives despite
    // `serde(default)` on the field (which would otherwise paper over a
    // missing key with the new `true` default flipped in this task).
    let toml_in = r##"
[profile]
user_id = "kill-switch-user"
display_name = "Kill Switch"
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

[cloud.drive]
feature_enabled = false
"##;
    let s: Settings = toml::from_str(toml_in).expect("explicit user opt-out must parse");
    assert!(
        !s.cloud.drive.feature_enabled,
        "explicit user `feature_enabled = false` must be preserved as the kill-switch input",
    );
}

// The kill-switch helper is the predicate the IPC layer in
// `src-tauri/src/main.rs` consults at the top of `drive_connect` and
// `drive_open_url`. Returning `true` short-circuits those handlers with a
// user-friendly error — letting users disable the Drive surface from their
// settings.toml without us having to ship a UI toggle for it.
//
// The contract:
//   - Default settings → kill-switch inactive (Phase 3 default is `true`).
//   - Explicit `feature_enabled = false` → kill-switch ACTIVE; IPC handlers
//     refuse to launch the OAuth flow or open a Drive URL until the user
//     flips the flag back on.
#[test]
fn kill_switch_inactive_under_default_settings() {
    let s = Settings::default();
    assert!(
        !drive_kill_switch_active(&s),
        "fresh install must NOT trip the kill-switch — Drive surface is on by default",
    );
}

#[test]
fn kill_switch_active_when_user_opts_out() {
    let mut s = Settings::default();
    s.cloud.drive.feature_enabled = false;
    assert!(
        drive_kill_switch_active(&s),
        "explicit user opt-out must trip the kill-switch so drive_connect / drive_open_url can short-circuit",
    );
}
