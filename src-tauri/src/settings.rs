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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ExternalChangeBehavior {
    Ask,
    Reload,
    Ignore,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum AutoMergeMode {
    Always,
    Ask,
    Manual,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct EditorSettings {
    pub default_open_mode: String, // "view" | "edit"
    pub auto_save: bool,
    pub auto_save_debounce_ms: u32,
    pub external_change_behavior: ExternalChangeBehavior,
    pub syntax_highlighting: bool,
    pub mermaid_enabled: bool,
    pub show_whitespace: bool,
    pub word_wrap: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct CommentsSettings {
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export)]
pub struct Settings {
    pub profile: ProfileSettings,
    pub appearance: AppearanceSettings,
    pub editor: EditorSettings,
    pub comments: CommentsSettings,
    pub advanced: AdvancedSettings,
    pub shortcuts: BTreeMap<String, String>, // action → keybinding
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
            },
            editor: EditorSettings {
                default_open_mode: "view".into(),
                auto_save: true,
                auto_save_debounce_ms: 750,
                external_change_behavior: ExternalChangeBehavior::Ask,
                syntax_highlighting: true,
                mermaid_enabled: true,
                show_whitespace: false,
                word_wrap: true,
            },
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
            f(&mut *g);
            clamp(&mut *g);
            event = diff_event(&before, &*g);
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
    None
}

#[cfg(test)]
mod tests {
    use super::*;

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
