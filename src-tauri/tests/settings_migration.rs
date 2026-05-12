//! A.3: Settings migration tests for `editor.default_open_mode`.
//!
//! Key Decision 7 from the WYSIWYG design doc:
//!   - The writer ALWAYS emits the new values `"render"` / `"raw"`.
//!   - The reader silently maps legacy `"view"` → `("render", render_readonly=true)`
//!     (behaviour-preserving: users who explicitly chose `"view"` chose the
//!     only non-editable surface available at the time, so the migration must
//!     keep the surface non-editable until they consent).
//!   - The reader silently maps legacy `"edit"` → `"raw"`.
//!   - Fresh installs go through `EditorSettings::default()` and MUST NOT
//!     traverse the legacy-value migration code path — `default_open_mode`
//!     starts as `"render"` and `render_readonly` starts as `false`.
//!   - The migration is reader-only: the on-disk settings.toml is NOT
//!     rewritten on first read. The new values land on disk only after the
//!     user's next IPC-driven `setSettings`.

use mdviewer_lib::settings::{EditorSettings, Settings, SettingsStore};
use tempfile::TempDir;

/// (a) Fresh-install default: `EditorSettings::default()` emits
/// `default_open_mode = "render"` AND `render_readonly = false` DIRECTLY,
/// without traversing the legacy-value migration path. Pin both fields
/// against the literal returned by the Default impl so a future regression
/// (e.g. someone wiring the Default impl through the deserializer to "share
/// code with the migration") surfaces here.
#[test]
fn fresh_install_default_emits_render_and_render_readonly_false() {
    let editor = EditorSettings::default();
    assert_eq!(
        editor.default_open_mode, "render",
        "fresh-install default must be \"render\" (not the legacy \"view\")"
    );
    assert!(
        !editor.render_readonly,
        "fresh-install default must have render_readonly = false"
    );
}

/// `Settings::default()` propagates the fresh-install editor default. The
/// top-level Default impl composes the per-section defaults, so we pin both
/// here in case a future refactor stops calling through `EditorSettings::default`.
#[test]
fn fresh_install_settings_default_propagates_render_default() {
    let s = Settings::default();
    assert_eq!(s.editor.default_open_mode, "render");
    assert!(!s.editor.render_readonly);
}

/// (b) Legacy `"view"` deserializes to `("render", render_readonly=true)`.
/// This is the behaviour-preserving migration: users who explicitly chose
/// `"view"` chose the only non-editable surface available pre-WYSIWYG, so
/// the migration must keep the surface non-editable until they explicitly
/// flip `render_readonly` off.
#[test]
fn legacy_view_maps_to_render_with_render_readonly_true() {
    let toml_str = concat!(
        "default_open_mode = \"view\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
    );
    let editor: EditorSettings = toml::from_str(toml_str).expect("legacy view should parse");
    assert_eq!(
        editor.default_open_mode, "render",
        "legacy \"view\" must surface as \"render\" after migration"
    );
    assert!(
        editor.render_readonly,
        "legacy \"view\" must set render_readonly = true (behaviour-preserving)"
    );
}

/// (c) Legacy `"edit"` deserializes to `"raw"`. No companion-field flip
/// needed — `"edit"` was the editable surface before WYSIWYG, and `"raw"`
/// remains editable. `render_readonly` keeps whatever value the user had
/// (defaults to `false` when absent, as here).
#[test]
fn legacy_edit_maps_to_raw() {
    let toml_str = concat!(
        "default_open_mode = \"edit\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
    );
    let editor: EditorSettings = toml::from_str(toml_str).expect("legacy edit should parse");
    assert_eq!(
        editor.default_open_mode, "raw",
        "legacy \"edit\" must surface as \"raw\" after migration"
    );
    // render_readonly is independent of the "edit" -> "raw" mapping; the
    // serde default applies because the legacy TOML doesn't carry the key.
    assert!(
        !editor.render_readonly,
        "render_readonly defaults to false when the legacy TOML omits the key"
    );
}

/// Legacy `"edit"` with a user-supplied `render_readonly = true` must
/// preserve the user's value — the "edit" -> "raw" mapping is one-way and
/// must not silently overwrite `render_readonly`.
#[test]
fn legacy_edit_preserves_user_render_readonly_when_supplied() {
    let toml_str = concat!(
        "default_open_mode = \"edit\"\n",
        "render_readonly = true\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
    );
    let editor: EditorSettings = toml::from_str(toml_str).expect("should parse");
    assert_eq!(editor.default_open_mode, "raw");
    assert!(
        editor.render_readonly,
        "user-supplied render_readonly must be preserved across the edit→raw mapping"
    );
}

/// (d) New value `"render"` round-trips cleanly via serialize → deserialize.
/// The writer's output is the reader's input on next launch, so this is the
/// steady-state shape after migration.
#[test]
fn new_render_value_round_trips() {
    let editor = EditorSettings::default(); // default_open_mode = "render"
    let serialized = toml::to_string(&editor).expect("serialize");
    assert!(
        serialized.contains("default_open_mode = \"render\""),
        "serialized TOML must contain the new value, got:\n{serialized}"
    );
    let parsed: EditorSettings = toml::from_str(&serialized).expect("deserialize");
    assert_eq!(parsed.default_open_mode, "render");
    assert!(!parsed.render_readonly);
}

/// New value `"raw"` round-trips cleanly. Mirror of the previous test for
/// the editable-surface variant.
#[test]
fn new_raw_value_round_trips() {
    let mut editor = EditorSettings::default();
    editor.default_open_mode = "raw".into();
    let serialized = toml::to_string(&editor).expect("serialize");
    assert!(
        serialized.contains("default_open_mode = \"raw\""),
        "serialized TOML must contain the new value, got:\n{serialized}"
    );
    let parsed: EditorSettings = toml::from_str(&serialized).expect("deserialize");
    assert_eq!(parsed.default_open_mode, "raw");
}

/// (e) After deserializing legacy `"view"` then serializing back, the
/// output carries the new `"render"` value (no `"view"` anywhere). This
/// proves that the next user-initiated `setSettings` lands the migrated
/// value on disk. We do NOT rewrite the file on first read — that's
/// covered by the "open does not rewrite" test below.
#[test]
fn legacy_view_rewrites_to_render_on_next_serialize() {
    let toml_str = concat!(
        "default_open_mode = \"view\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
    );
    let editor: EditorSettings = toml::from_str(toml_str).unwrap();
    let serialized = toml::to_string(&editor).unwrap();
    assert!(
        serialized.contains("default_open_mode = \"render\""),
        "after deserialize+serialize, value must be \"render\", got:\n{serialized}"
    );
    assert!(
        !serialized.contains("\"view\""),
        "after deserialize+serialize, the legacy \"view\" string must be gone, got:\n{serialized}"
    );
    assert!(
        serialized.contains("render_readonly = true"),
        "the companion render_readonly must persist on re-serialize, got:\n{serialized}"
    );
}

/// `Settings::default()` -> serialize -> deserialize must round-trip to
/// the same struct. The Default impl is the single source of truth for
/// every other settings field, and this test pins that the migration
/// changes haven't broken serde shape on the unaffected sections.
#[test]
fn default_settings_round_trip_through_toml() {
    let original = Settings::default();
    let serialized = toml::to_string_pretty(&original).expect("serialize default");
    let parsed: Settings = toml::from_str(&serialized).expect("deserialize default");
    assert_eq!(parsed.editor.default_open_mode, "render");
    assert!(!parsed.editor.render_readonly);
    assert_eq!(
        parsed.editor.auto_save_debounce_ms,
        original.editor.auto_save_debounce_ms,
    );
}

/// The migration is reader-only. `SettingsStore::open()` must NOT rewrite
/// the on-disk file if all we did was read a legacy `"view"` value. The
/// new value lands on disk only when the user issues their next IPC-driven
/// `setSettings` (covered by `update()` writing the in-memory snapshot,
/// which will already have `"render"` thanks to the deserialize mapping).
#[test]
fn open_does_not_rewrite_legacy_settings_toml() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("settings.toml");
    let legacy = concat!(
        "[profile]\n",
        "user_id = \"x\"\n",
        "display_name = \"\"\n",
        "color = \"#888888\"\n",
        "\n",
        "[appearance]\n",
        "theme = \"follow_system\"\n",
        "font_size_px = 14\n",
        "line_height = 150\n",
        "density = \"comfortable\"\n",
        "\n",
        "[editor]\n",
        "default_open_mode = \"view\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
        "\n",
        "[comments]\n",
        "auto_merge = \"always\"\n",
        "reattachment_confidence = 75\n",
        "sidecar_pattern = \"{name}.md.comments.json\"\n",
        "show_resolved = false\n",
        "\n",
        "[advanced]\n",
        "verbose_logs = false\n",
        "\n",
        "[shortcuts]\n",
    );
    std::fs::write(&path, legacy).unwrap();
    let bytes_before = std::fs::read_to_string(&path).unwrap();

    let store = SettingsStore::open(tmp.path()).expect("open should succeed");

    // The in-memory snapshot reflects the migration.
    let s = store.get();
    assert_eq!(s.editor.default_open_mode, "render");
    assert!(s.editor.render_readonly);

    // The on-disk file is unchanged — migration is reader-only.
    let bytes_after = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        bytes_before, bytes_after,
        "open() must NOT rewrite the legacy settings.toml on first read"
    );
}

/// After `open()`s reader-side migration, the next `update()` (representing
/// a user-initiated `setSettings` IPC call) MUST persist the new
/// `"render"` value to disk — that's how the legacy "view" -> "render"
/// rewrite eventually lands on disk without us bypassing the user's
/// explicit consent flow.
#[test]
fn update_after_legacy_load_persists_new_render_value() {
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("settings.toml");
    let legacy = concat!(
        "[profile]\n",
        "user_id = \"x\"\n",
        "display_name = \"\"\n",
        "color = \"#888888\"\n",
        "\n",
        "[appearance]\n",
        "theme = \"follow_system\"\n",
        "font_size_px = 14\n",
        "line_height = 150\n",
        "density = \"comfortable\"\n",
        "\n",
        "[editor]\n",
        "default_open_mode = \"view\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
        "\n",
        "[comments]\n",
        "auto_merge = \"always\"\n",
        "reattachment_confidence = 75\n",
        "sidecar_pattern = \"{name}.md.comments.json\"\n",
        "show_resolved = false\n",
        "\n",
        "[advanced]\n",
        "verbose_logs = false\n",
        "\n",
        "[shortcuts]\n",
    );
    std::fs::write(&path, legacy).unwrap();

    let store = SettingsStore::open(tmp.path()).expect("open should succeed");
    // Simulate a user-initiated update (e.g. flipping the theme via the
    // Settings page) — anything that produces a non-trivial diff so the
    // store flushes the in-memory snapshot to disk.
    store
        .update(|s| s.profile.display_name = "Migrated".into())
        .expect("update should succeed");

    let bytes_after = std::fs::read_to_string(&path).unwrap();
    assert!(
        bytes_after.contains("default_open_mode = \"render\""),
        "after a user-initiated update, the migrated value must land on disk, got:\n{bytes_after}"
    );
    assert!(
        bytes_after.contains("render_readonly = true"),
        "render_readonly companion must also persist, got:\n{bytes_after}"
    );
    assert!(
        !bytes_after.contains("\"view\""),
        "the legacy \"view\" string must be replaced on persist, got:\n{bytes_after}"
    );
}

/// Backward-compat: a settings.toml WITHOUT the new `render_readonly` key
/// must still deserialize (serde(default) -> false). This is the path
/// every existing user takes on the upgrade.
#[test]
fn missing_render_readonly_key_defaults_to_false() {
    let toml_str = concat!(
        "default_open_mode = \"render\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
    );
    let editor: EditorSettings =
        toml::from_str(toml_str).expect("missing render_readonly should default");
    assert!(!editor.render_readonly);
}

/// Explicit `render_readonly = true` on a fresh-install settings.toml
/// (i.e. the user enabled the toggle via the Settings UI) round-trips
/// cleanly without the migration code touching it.
#[test]
fn explicit_render_readonly_true_round_trips_cleanly() {
    let mut editor = EditorSettings::default();
    editor.render_readonly = true;
    let serialized = toml::to_string(&editor).unwrap();
    let parsed: EditorSettings = toml::from_str(&serialized).unwrap();
    assert_eq!(parsed.default_open_mode, "render");
    assert!(parsed.render_readonly);
}

/// An unknown legacy value (typo, future-binary value we don't recognise)
/// passes through unchanged. The frontend's typed union narrows acceptable
/// values, and the migration must not over-reach — only the two known
/// legacy strings get rewritten.
///
/// Note: this also covers the forward-compat case where an OLD binary
/// reads a NEW settings.toml — `"render"` and `"raw"` pass through as-is
/// (and the design doc accepts that an old binary won't know how to
/// activate the render surface, falling back to its default behavior).
#[test]
fn unrecognised_open_mode_passes_through_unchanged() {
    let toml_str = concat!(
        "default_open_mode = \"some_future_mode\"\n",
        "auto_save = true\n",
        "auto_save_debounce_ms = 750\n",
        "external_change_behavior = \"ask\"\n",
        "syntax_highlighting = true\n",
        "mermaid_enabled = true\n",
        "show_whitespace = false\n",
        "word_wrap = true\n",
    );
    let editor: EditorSettings = toml::from_str(toml_str).unwrap();
    assert_eq!(editor.default_open_mode, "some_future_mode");
    assert!(!editor.render_readonly);
}
