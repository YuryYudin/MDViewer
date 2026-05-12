//! Settings store with TOML persistence and change-event channel.
//!
//! The store lives at `<app_config_dir>/settings.toml` and is loaded on
//! startup. All writes go through `update`, which clones the current
//! snapshot, applies the closure, clamps invalid ranges, persists to disk,
//! and emits a typed [`ChangeEvent`] to all subscribers.
//!
//! Change events use `std::sync::mpsc` channels (runtime-agnostic) instead
//! of tokio's broadcast channel so the store works without a tokio runtime
//! and so the file watcher (B2) can plug into the same event stream from a
//! native worker thread.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

// A4: `AutoMergeMode` lives in `mdviewer-core` so the shared sidecar
// merge code can take the policy as a parameter without depending on
// the desktop's larger `Settings` struct. Re-exported here so existing
// `crate::settings::AutoMergeMode` paths (sidecar.rs, main.rs IPC handlers,
// integration tests) keep compiling. The serde shape stays
// `#[serde(rename_all = "snake_case")]` on the core enum, so settings.toml
// round-trips remain byte-identical.
pub use mdviewer_core::auto_merge::AutoMergeMode;
// `std::sync::mpsc` is unbounded but single-consumer; for a fan-out we keep a
// Vec<Sender> behind a Mutex and emit by cloning the event to each subscriber.
// This avoids tokio's broadcast and works without any async runtime.

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Light,
    Dark,
    FollowSystem,
}

/// Sub-variant applied on top of the dark theme. `Pure` is the default —
/// near-black background, warm grey panels (the look the user picked from
/// the wireframe round). `Cool` shifts the dark palette slightly bluish,
/// closer to a code-editor feel. Inert when the active theme is `Light`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS, Default)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum DarkVariant {
    #[default]
    Pure,
    Cool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ExternalChangeBehavior {
    Ask,
    Reload,
    Ignore,
}

// `AutoMergeMode` re-exported from `mdviewer_core::auto_merge` at the top
// of this file. Local enum removed in A4.
//
// `AutoMergeModeTs` is a thin desktop-side mirror used purely for TypeScript
// codegen. We can't `#[derive(ts_rs::TS)]` on the core enum (orphan rules
// would force `mdviewer-core` to depend on `ts-rs`, which is desktop-only
// per the design). The wrapper keeps the TS shape byte-identical to before
// the move — `export type AutoMergeMode = "always" | "ask" | "manual";` —
// via `#[ts(rename = "AutoMergeMode")]`. The `CommentsSettings.auto_merge`
// field uses `#[ts(as = "AutoMergeModeTs")]` so ts-rs resolves the import
// without needing the foreign enum to implement `TS`.
//
// Pinned by `auto_merge_ts_wrapper_matches_core_variants` in this file's
// test module: any future variant added to `AutoMergeMode` must also be
// added here, and round-trips between the two enums via `From` impls.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, rename = "AutoMergeMode")]
#[serde(rename_all = "snake_case")]
pub enum AutoMergeModeTs {
    Always,
    Ask,
    Manual,
}

impl From<AutoMergeMode> for AutoMergeModeTs {
    fn from(m: AutoMergeMode) -> Self {
        match m {
            AutoMergeMode::Always => AutoMergeModeTs::Always,
            AutoMergeMode::Ask => AutoMergeModeTs::Ask,
            AutoMergeMode::Manual => AutoMergeModeTs::Manual,
        }
    }
}

impl From<AutoMergeModeTs> for AutoMergeMode {
    fn from(m: AutoMergeModeTs) -> Self {
        match m {
            AutoMergeModeTs::Always => AutoMergeMode::Always,
            AutoMergeModeTs::Ask => AutoMergeMode::Ask,
            AutoMergeModeTs::Manual => AutoMergeMode::Manual,
        }
    }
}

/// What MDViewer should do when the app launches.
///
/// `Clean` (default) — boot to the StartPage with no tabs open. Most
/// users expect this; matches the v0.1.0 behavior.
///
/// `Restore` — re-open every tab that was open at the previous shutdown,
/// re-activating the same tab. Backed by `<data_dir>/session.json`,
/// which Workspace updates eagerly on every open / close so a crash
/// doesn't lose the state. The Settings.ts dropdown writes this field.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS, Default)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum StartupMode {
    #[default]
    Clean,
    Restore,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct ProfileSettings {
    pub user_id: String,
    pub display_name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct AppearanceSettings {
    pub theme: Theme,
    pub font_size_px: u16,
    pub line_height: u16, // 100..=200 percentage
    pub density: String,  // "compact" | "comfortable" | "spacious"
    /// Startup behavior — "clean" (boot empty) or "restore" (re-open
    /// previously open tabs). `serde(default)` so settings.toml files
    /// written by older app versions (no startup_mode key) deserialize
    /// without error and pick up the safe default.
    #[serde(default)]
    pub startup_mode: StartupMode,
    /// Sub-variant for the dark palette. Defaults to `Pure` (near-black);
    /// `Cool` is a slightly bluish alternative. `serde(default)` keeps
    /// older settings.toml files (without this key) loading cleanly.
    #[serde(default)]
    pub dark_variant: DarkVariant,
}

/// A.3 (WYSIWYG editing, Phase 1): `default_open_mode` now lives in the
/// `{ "render" | "raw" }` space; the legacy `{ "view" | "edit" }` values
/// are accepted on read via the custom `Deserialize` impl below (which
/// silently rewrites them in-memory, behaviour-preservingly). The writer
/// (derived `Serialize`) ALWAYS emits the new values — the next
/// user-initiated `setSettings` flushes the migrated value to disk.
///
/// `render_readonly` (Phase 1) opt-out: defaults to `false` for fresh
/// installs; the deserializer flips it to `true` when it encounters a
/// legacy `"view"` value (the user's effective surface was non-editable
/// pre-WYSIWYG and the migration must preserve that until the user
/// explicitly turns the toggle off).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct EditorSettings {
    pub default_open_mode: String, // "render" | "raw" (legacy "view" / "edit" silently mapped on read)
    pub auto_save: bool,
    pub auto_save_debounce_ms: u32,
    pub external_change_behavior: ExternalChangeBehavior,
    pub syntax_highlighting: bool,
    pub mermaid_enabled: bool,
    pub show_whitespace: bool,
    pub word_wrap: bool,
    /// Phase 1 opt-out: when `true`, the render surface is non-editable.
    /// Fresh installs get `false` (editable render is the new default).
    /// The reader-side migration flips this to `true` for users whose
    /// pre-WYSIWYG `default_open_mode` was `"view"`.
    #[serde(default)]
    pub render_readonly: bool,
}

impl Default for EditorSettings {
    /// Fresh-install defaults. Emits `"render"` and `render_readonly = false`
    /// DIRECTLY — fresh installs MUST NOT pass through the legacy-value
    /// migration code path in `Deserialize`.
    fn default() -> Self {
        EditorSettings {
            default_open_mode: "render".into(),
            auto_save: true,
            auto_save_debounce_ms: 750,
            external_change_behavior: ExternalChangeBehavior::Ask,
            syntax_highlighting: true,
            mermaid_enabled: true,
            show_whitespace: false,
            word_wrap: true,
            render_readonly: false,
        }
    }
}

/// Reader-side migration for `editor.default_open_mode`.
///
/// We deserialize through a private mirror struct that lets us inspect both
/// `default_open_mode` and `render_readonly` together, then apply the
/// behaviour-preserving rewrites from Key Decision 7 of the WYSIWYG design:
///
///   - `"view"` → `("render", render_readonly=true)` — the pre-WYSIWYG
///     "view" surface was non-editable, so migrating to plain "render"
///     would silently make the document editable. Flipping
///     `render_readonly = true` preserves the effective behaviour until
///     the user explicitly opts in to editing (via the Settings toggle).
///   - `"edit"` → `"raw"` — both are editable; no companion-field flip
///     needed. We preserve whatever `render_readonly` the user supplied.
///   - `"render"` / `"raw"` → pass through unchanged (steady state).
///   - Any other value → pass through unchanged (forward-compat for
///     unknown future values + typo tolerance; the frontend's TS union
///     narrows acceptable values for the UI).
///
/// The migration is reader-only: we never rewrite settings.toml from
/// `SettingsStore::open()`. The new values land on disk only when the
/// user issues their next IPC-driven `setSettings` (which flows through
/// `update()` and re-serializes the in-memory snapshot — whose
/// `default_open_mode` will already carry the migrated value).
impl<'de> Deserialize<'de> for EditorSettings {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct RawEditorSettings {
            default_open_mode: String,
            auto_save: bool,
            auto_save_debounce_ms: u32,
            external_change_behavior: ExternalChangeBehavior,
            syntax_highlighting: bool,
            mermaid_enabled: bool,
            show_whitespace: bool,
            word_wrap: bool,
            #[serde(default)]
            render_readonly: bool,
        }

        let raw = RawEditorSettings::deserialize(deserializer)?;
        let (default_open_mode, render_readonly) = match raw.default_open_mode.as_str() {
            // Behaviour-preserving migration: "view" was the read-only
            // surface, so we set render_readonly = true as we map to
            // "render". This is the SOLE place where the deserializer
            // flips render_readonly from its serde default — the user's
            // explicit `render_readonly = true` on a non-"view" mode
            // passes through untouched (see the `"edit"` branch).
            "view" => ("render".to_string(), true),
            // "edit" was editable; "raw" is editable. No companion flip;
            // the user's render_readonly choice (if any) is preserved.
            "edit" => ("raw".to_string(), raw.render_readonly),
            // Steady-state values and unknown future values pass through.
            other => (other.to_string(), raw.render_readonly),
        };

        Ok(EditorSettings {
            default_open_mode,
            auto_save: raw.auto_save,
            auto_save_debounce_ms: raw.auto_save_debounce_ms,
            external_change_behavior: raw.external_change_behavior,
            syntax_highlighting: raw.syntax_highlighting,
            mermaid_enabled: raw.mermaid_enabled,
            show_whitespace: raw.show_whitespace,
            word_wrap: raw.word_wrap,
            render_readonly,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct CommentsSettings {
    // `AutoMergeMode` is the foreign re-export from `mdviewer_core::auto_merge`,
    // so we can't `derive(TS)` on it directly. `#[ts(as = "AutoMergeModeTs")]`
    // tells ts-rs to use the desktop wrapper's name when emitting the import
    // for this field, keeping the generated `import type { AutoMergeMode }`
    // line identical to before the A4 extraction.
    #[ts(as = "AutoMergeModeTs")]
    pub auto_merge: AutoMergeMode,
    pub reattachment_confidence: u8, // 1..=100
    pub sidecar_pattern: String,     // "{name}.md.comments.json"
    pub show_resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct AdvancedSettings {
    pub sync_provider: Option<String>, // reserved; inert in v1
    pub verbose_logs: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS, Default)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum BackendMode {
    #[default]
    Auto,
    AlwaysSidecar,
    AlwaysDrive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct DriveSettings {
    #[serde(default)]
    pub feature_enabled: bool,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub account_email: Option<String>,
    #[serde(default)]
    pub backend_mode: BackendMode,
    #[serde(default = "default_active_poll")]
    pub poll_interval_active_secs: u64,
    #[serde(default = "default_unfocused_poll")]
    pub poll_interval_unfocused_secs: u64,
    #[serde(default)]
    pub custom_oauth_client_id: Option<String>,
    /// C2: once the user successfully connects to Drive for the first time,
    /// this flips to `true` to globally suppress the Drive-detect toast on
    /// future opens. Declared here in A1 so C2 (which only modifies frontend
    /// + doc_prefs files) can rely on the field already existing.
    #[serde(default)]
    pub detect_toast_suppressed: bool,
}

fn default_active_poll() -> u64 {
    5
}
fn default_unfocused_poll() -> u64 {
    10
}

impl Default for DriveSettings {
    fn default() -> Self {
        Self {
            // C5 (Phase 3): the Drive integration ships on by default.
            // Reverted to opt-in (2025-05-01): Drive API integration
            // requires the user to obtain a Google Cloud OAuth client_id
            // (Console project, Drive API enable, OAuth consent screen
            // setup, etc.) which many corporate users can't do without IT
            // approval. Default behavior is now: local sidecar (.md.comments.json)
            // with auto-reload-on-external-change. The user can opt in to
            // the full Drive API integration via Settings → Drive → Advanced.
            feature_enabled: false,
            connected: false,
            account_email: None,
            backend_mode: BackendMode::Auto,
            poll_interval_active_secs: 5,
            poll_interval_unfocused_secs: 10,
            custom_oauth_client_id: None,
            detect_toast_suppressed: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct CloudSettings {
    #[serde(default)]
    pub drive: DriveSettings,
}

/// C5: user-facing kill-switch predicate. The IPC layer in
/// `src-tauri/src/main.rs` consults this at the top of `drive_connect` and
/// `drive_open_url`; a `true` return short-circuits those handlers with a
/// human-readable error so users can disable the Drive surface from their
/// `settings.toml` without us shipping a dedicated UI toggle.
///
/// Phase 3 flipped `feature_enabled` to `true` by default — the predicate
/// is purely for the explicit-opt-out path. Anything we read here must
/// survive `serde(default)` (covered by
/// `explicit_user_override_to_false_is_preserved_through_round_trip` in
/// the dedicated `drive_feature_flag.rs` integration test).
pub fn drive_kill_switch_active(s: &Settings) -> bool {
    !s.cloud.drive.feature_enabled
}

/// One-time onboarding nudges. Today the only field is the CLI-installer
/// prompt tracker, but future first-run UX (welcome tour, tip-of-the-day
/// toggles, etc.) belongs here too.
///
/// `cli_install_prompt_seen_for` stores a *prompt-version* string rather
/// than a bool so a future release can re-prompt by bumping
/// `CURRENT_CLI_INSTALL_PROMPT_VERSION` (e.g. if we change the symlink
/// path or want to nag users who declined a year ago to reconsider). An
/// empty string means "never asked" — that's what every existing user
/// will deserialize to thanks to `#[serde(default)]`, so the current
/// release's first launch shows the prompt automatically.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct OnboardingState {
    #[serde(default)]
    pub cli_install_prompt_seen_for: String,
}

/// Bump this when we want every user to see the CLI-install prompt
/// again on their next launch. Keeping the constant in code (rather than
/// auto-derived from `Cargo.toml::version`) means a routine version bump
/// doesn't accidentally re-nag users — only an explicit edit here does.
pub const CURRENT_CLI_INSTALL_PROMPT_VERSION: &str = "v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct Settings {
    pub profile: ProfileSettings,
    pub appearance: AppearanceSettings,
    pub editor: EditorSettings,
    pub comments: CommentsSettings,
    pub advanced: AdvancedSettings,
    pub shortcuts: BTreeMap<String, String>, // action → keybinding
    #[serde(default)]
    pub cloud: CloudSettings,
    #[serde(default)]
    pub onboarding: OnboardingState,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            profile: ProfileSettings {
                user_id: generate_user_id(),
                display_name: String::new(),
                color: "#888888".into(),
            },
            appearance: AppearanceSettings {
                theme: Theme::FollowSystem,
                font_size_px: 14,
                line_height: 150,
                density: "comfortable".into(),
                startup_mode: StartupMode::default(),
                dark_variant: DarkVariant::default(),
            },
            // A.3: delegate to `EditorSettings::default()` so the
            // "render"/render_readonly=false fresh-install pair lives in
            // exactly one place. Crucially, this path does NOT pass
            // through the legacy-value reader migration — `Default::default`
            // is a direct struct literal, not a serde deserialize.
            editor: EditorSettings::default(),
            comments: CommentsSettings {
                auto_merge: AutoMergeMode::Always,
                reattachment_confidence: 75,
                sidecar_pattern: "{name}.md.comments.json".into(),
                show_resolved: false,
            },
            advanced: AdvancedSettings {
                sync_provider: None,
                verbose_logs: false,
            },
            shortcuts: default_shortcuts(),
            cloud: CloudSettings::default(),
            onboarding: OnboardingState::default(),
        }
    }
}

fn default_shortcuts() -> BTreeMap<String, String> {
    // Action keys here MUST match the Action union in src/keymap.ts (A9).
    // Combos use the canonical token "Mod" for the platform meta key (Cmd on
    // macOS, Ctrl elsewhere); A9's keymap normalizes both sides to the same
    // form before lookup.
    let mut m = BTreeMap::new();
    m.insert("open_file".into(), "Mod+O".into());
    m.insert("save_file".into(), "Mod+S".into());
    m.insert("toggle_edit".into(), "Mod+E".into());
    m.insert("close_tab".into(), "Mod+W".into());
    m.insert("comment_on_selection".into(), "Mod+Shift+M".into());
    m.insert("toggle_sidebar".into(), "Mod+Shift+S".into());
    m.insert("resolve_thread".into(), "Mod+Shift+R".into());
    m.insert("toggle_dark".into(), "Mod+Shift+D".into());
    m.insert("open_settings".into(), "Mod+,".into());
    // Font-zoom defaults — universal browser-zoom accelerators. The TS
    // keymap folds shifted-symbol keys back to their unshifted form so
    // `Cmd+Shift+=` (the natural physical press for `+`) also matches `Mod+=`.
    m.insert("font_increase".into(), "Mod+=".into());
    m.insert("font_decrease".into(), "Mod+-".into());
    m.insert("font_reset".into(), "Mod+0".into());
    m
}

fn generate_user_id() -> String {
    // Simple non-cryptographic ID. Real UUID lib is overkill here.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("user-{:x}", nanos)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeEvent {
    Profile,
    Appearance,
    Editor,
    Comments,
    Advanced,
    Shortcuts,
    Cloud,
    Onboarding,
}

pub struct SettingsStore {
    inner: Arc<RwLock<Settings>>,
    path: PathBuf,
    // Fan-out subscribers via std::sync::mpsc — runtime-agnostic. Each
    // subscriber gets its own channel; emit clones the event to each one.
    subs: Mutex<Vec<std::sync::mpsc::Sender<ChangeEvent>>>,
}

impl SettingsStore {
    /// Open (or create) the settings store rooted at `data_dir`. The TOML
    /// file is created with default values if it doesn't exist; if it exists
    /// but fails to parse, defaults are used (corrupt file is preserved on
    /// disk but not overwritten until the next `update`).
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("create data dir")?;
        let path = data_dir.join("settings.toml");
        let mut settings: Settings = if path.exists() {
            let bytes = std::fs::read_to_string(&path).context("read settings.toml")?;
            toml::from_str(&bytes).unwrap_or_default()
        } else {
            let s = Settings::default();
            std::fs::write(&path, toml::to_string_pretty(&s)?)?;
            s
        };
        // Defense-in-depth merge: every default shortcut not explicitly set
        // in the user's settings.toml gets filled with its built-in value.
        // Without this, an empty `[shortcuts]` block (or one written by an
        // older app version that didn't ship today's actions) leaves the JS
        // keymap with a partial — or empty — binding map, and the user's
        // `Cmd+=` / `Cmd+-` / `Cmd+0` gestures silently no-op. The merge
        // preserves user customizations: only keys missing from the loaded
        // map are overwritten.
        for (action, combo) in default_shortcuts() {
            settings.shortcuts.entry(action).or_insert(combo);
        }
        Ok(Self {
            inner: Arc::new(RwLock::new(settings)),
            path,
            subs: Mutex::new(Vec::new()),
        })
    }

    /// Return a clone of the current settings snapshot.
    pub fn get(&self) -> Settings {
        self.inner.read().unwrap().clone()
    }

    /// Apply `f` to the settings, clamp invalid ranges, persist to disk, and
    /// emit a typed change event to all subscribers. The write lock is
    /// released before events fire to avoid deadlocks if a subscriber calls
    /// back into the store on receipt.
    pub fn update<F: FnOnce(&mut Settings)>(&self, f: F) -> Result<()> {
        let event;
        let snapshot;
        {
            let mut g = self.inner.write().unwrap();
            let before = g.clone();
            f(&mut g);
            clamp(&mut g);
            event = diff_event(&before, &g);
            snapshot = g.clone();
        }
        // Only touch disk when something actually changed. Skipping no-op
        // writes avoids spurious mtime bumps that would trigger B2's
        // file-watcher once it's wired up.
        if let Some(ev) = event {
            std::fs::write(&self.path, toml::to_string_pretty(&snapshot)?)?;
            let mut subs = self.subs.lock().unwrap();
            // Drop senders whose receivers were dropped — they'll error on send.
            subs.retain(|tx| tx.send(ev).is_ok());
        }
        Ok(())
    }

    /// Subscribe to typed change events. Each subscriber gets its own
    /// `mpsc::Receiver`; senders to dropped receivers are pruned on next emit.
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<ChangeEvent> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.subs.lock().unwrap().push(tx);
        rx
    }
}

fn clamp(s: &mut Settings) {
    s.comments.reattachment_confidence = s.comments.reattachment_confidence.clamp(1, 100);
    s.appearance.font_size_px = s.appearance.font_size_px.clamp(8, 64);
    s.appearance.line_height = s.appearance.line_height.clamp(100, 250);
    s.editor.auto_save_debounce_ms = s.editor.auto_save_debounce_ms.clamp(100, 10_000);
}

fn diff_event(a: &Settings, b: &Settings) -> Option<ChangeEvent> {
    if a.profile != b.profile {
        return Some(ChangeEvent::Profile);
    }
    if a.appearance != b.appearance {
        return Some(ChangeEvent::Appearance);
    }
    if a.editor != b.editor {
        return Some(ChangeEvent::Editor);
    }
    if a.comments != b.comments {
        return Some(ChangeEvent::Comments);
    }
    if a.advanced != b.advanced {
        return Some(ChangeEvent::Advanced);
    }
    if a.shortcuts != b.shortcuts {
        return Some(ChangeEvent::Shortcuts);
    }
    if a.cloud != b.cloud {
        return Some(ChangeEvent::Cloud);
    }
    if a.onboarding != b.onboarding {
        return Some(ChangeEvent::Onboarding);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A4 invariant: `AutoMergeModeTs` (the desktop TS-codegen wrapper)
    /// must mirror `AutoMergeMode` (the core enum) variant-for-variant
    /// and round-trip through both `From` impls without loss. If a future
    /// variant lands in `mdviewer_core::auto_merge::AutoMergeMode`, this
    /// match-on-every-variant pattern fails to compile until the same
    /// variant is added here — the goal is to make drift impossible to
    /// introduce silently.
    #[test]
    fn auto_merge_ts_wrapper_matches_core_variants() {
        for core in [
            AutoMergeMode::Always,
            AutoMergeMode::Ask,
            AutoMergeMode::Manual,
        ] {
            let ts: AutoMergeModeTs = core.into();
            let back: AutoMergeMode = ts.into();
            assert_eq!(core, back);
            // Shape pin: snake_case JSON identical for both sides.
            assert_eq!(
                serde_json::to_string(&core).unwrap(),
                serde_json::to_string(&ts).unwrap(),
            );
        }
    }

    /// The font-zoom keymap actions (`font_increase`, `font_decrease`,
    /// `font_reset`) must ship with the universal browser-zoom accelerators
    /// `Mod+=` / `Mod+-` / `Mod+0`. The frontend keymap reads these defaults
    /// directly; if any of them go missing or change shape the corresponding
    /// `Cmd+=` / `Cmd+-` / `Cmd+0` shortcut becomes a no-op.
    #[test]
    fn default_shortcuts_includes_font_zoom_bindings() {
        let shortcuts = default_shortcuts();
        assert_eq!(
            shortcuts.get("font_increase").map(String::as_str),
            Some("Mod+="),
        );
        assert_eq!(
            shortcuts.get("font_decrease").map(String::as_str),
            Some("Mod+-"),
        );
        assert_eq!(
            shortcuts.get("font_reset").map(String::as_str),
            Some("Mod+0"),
        );
    }

    /// Pins the load-time merge of `default_shortcuts()` into the loaded
    /// shortcut map. The wdio fixture writes a settings.toml with an empty
    /// `[shortcuts]` section, which deserializes to `BTreeMap::new()`. Without
    /// the merge in `SettingsStore::open`, all keyboard shortcuts would be
    /// no-ops — including the `Cmd+=` / `Cmd+-` / `Cmd+0` font-zoom bindings
    /// that the e2e suite (spec 15) drives via `browser.keys()`. The merge
    /// also future-proofs real users: when we add a new default shortcut, it
    /// shows up immediately on next launch instead of requiring a fresh
    /// settings.toml.
    #[test]
    fn missing_shortcuts_are_filled_from_defaults_at_load_time() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Hand-roll a settings.toml with no [shortcuts] entries — same shape
        // wdio.conf.ts seeds for e2e runs.
        let toml_str = concat!(
            "[profile]\n",
            "user_id = \"x\"\n",
            "display_name = \"y\"\n",
            "color = \"#000000\"\n",
            "\n",
            "[appearance]\n",
            "theme = \"light\"\n",
            "font_size_px = 14\n",
            "line_height = 150\n",
            "density = \"comfortable\"\n",
            "\n",
            "[editor]\n",
            "default_open_mode = \"view\"\n",
            "auto_save = false\n",
            "auto_save_debounce_ms = 500\n",
            "external_change_behavior = \"ask\"\n",
            "syntax_highlighting = true\n",
            "mermaid_enabled = true\n",
            "show_whitespace = false\n",
            "word_wrap = true\n",
            "\n",
            "[comments]\n",
            "auto_merge = \"ask\"\n",
            "reattachment_confidence = 75\n",
            "sidecar_pattern = \"{name}.md.comments.json\"\n",
            "show_resolved = true\n",
            "\n",
            "[advanced]\n",
            "verbose_logs = false\n",
            "\n",
            "[shortcuts]\n",
        );
        std::fs::write(dir.path().join("settings.toml"), toml_str).unwrap();
        let store = SettingsStore::open(dir.path()).expect("open");
        let s = store.get();
        // Every default shortcut is present after load.
        for (action, combo) in default_shortcuts() {
            assert_eq!(
                s.shortcuts.get(&action).map(String::as_str),
                Some(combo.as_str()),
                "default shortcut for {action} missing after load",
            );
        }
    }

    /// User-customized shortcuts must NOT be overwritten by the default
    /// merge. If the user remapped `font_increase` to `Mod+Shift+=`, that
    /// value persists; only missing keys get filled from defaults.
    #[test]
    fn user_customized_shortcuts_override_defaults_after_load() {
        let dir = tempfile::tempdir().expect("tempdir");
        let toml_str = concat!(
            "[profile]\n",
            "user_id = \"x\"\n",
            "display_name = \"y\"\n",
            "color = \"#000000\"\n",
            "\n",
            "[appearance]\n",
            "theme = \"light\"\n",
            "font_size_px = 14\n",
            "line_height = 150\n",
            "density = \"comfortable\"\n",
            "\n",
            "[editor]\n",
            "default_open_mode = \"view\"\n",
            "auto_save = false\n",
            "auto_save_debounce_ms = 500\n",
            "external_change_behavior = \"ask\"\n",
            "syntax_highlighting = true\n",
            "mermaid_enabled = true\n",
            "show_whitespace = false\n",
            "word_wrap = true\n",
            "\n",
            "[comments]\n",
            "auto_merge = \"ask\"\n",
            "reattachment_confidence = 75\n",
            "sidecar_pattern = \"{name}.md.comments.json\"\n",
            "show_resolved = true\n",
            "\n",
            "[advanced]\n",
            "verbose_logs = false\n",
            "\n",
            "[shortcuts]\n",
            "font_increase = \"Mod+Shift+=\"\n",
        );
        std::fs::write(dir.path().join("settings.toml"), toml_str).unwrap();
        let store = SettingsStore::open(dir.path()).expect("open");
        let s = store.get();
        assert_eq!(
            s.shortcuts.get("font_increase").map(String::as_str),
            Some("Mod+Shift+="),
            "user override must win over default",
        );
        // Other defaults still get filled in.
        assert_eq!(
            s.shortcuts.get("font_decrease").map(String::as_str),
            Some("Mod+-"),
        );
        assert_eq!(
            s.shortcuts.get("open_file").map(String::as_str),
            Some("Mod+O"),
        );
    }
}
