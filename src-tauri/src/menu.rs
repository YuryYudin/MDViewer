//! Native application menu.
//!
//! After the StartPage unmounts (a doc is open) there's no in-app surface for
//! `Open…` or `Settings…` — the user reported this and asked for a real
//! native menu. We build the standard macOS layout (App / File / Edit /
//! Window) and translate menu clicks into the same `mdviewer:*` CustomEvents
//! the keymap and StartPage already emit, so the frontend has one wiring
//! path regardless of which surface drove the action.
//!
//! The menu is intentionally small; it grows as we add commands. The
//! `menu_id_to_action` mapping is a pure function so unit tests can pin the
//! contract without spinning up a real app handle.
//!
//! macOS gets this layout for free; on Windows/Linux the predefined items
//! adapt to the platform conventions automatically (services / hide_others
//! become no-ops, etc. — see muda's predefined items).

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

/// Frontend listens for this event name on the global Tauri bus. Payload is
/// the action string that the frontend re-dispatches as a CustomEvent
/// (`mdviewer:<action>` minus the prefix).
pub const MENU_EVENT: &str = "menu-action";

/// Menu item id for the macOS "Install 'mdviewer' Command in PATH…" item.
/// Unlike the entries in `menu_id_to_action`, this one is handled entirely
/// in the Rust `on_menu_event` closure (it shells out to `osascript`) and
/// does not emit a frontend CustomEvent.
pub const MENU_ID_INSTALL_CLI: &str = "menu-install-cli";

/// Menu item id for the macOS "Uninstall 'mdviewer' Command…" companion.
/// Same Rust-side handling as the install item.
pub const MENU_ID_UNINSTALL_CLI: &str = "menu-uninstall-cli";

/// Pure mapping from menu-item id to the frontend action it triggers.
/// Unknown ids return None and are silently dropped — predefined items
/// (cut, copy, etc.) are handled by the OS and never reach this path.
/// The `menu-install-cli` / `menu-uninstall-cli` ids also return None
/// because their handler runs Rust-side (no frontend involvement).
pub fn menu_id_to_action(id: &str) -> Option<&'static str> {
    match id {
        "menu-open-file" => Some("open-file"),
        "menu-new-document" => Some("new-document"),
        "menu-close-tab" => Some("close-tab"),
        "menu-open-settings" => Some("open-settings"),
        "menu-save-file" => Some("save-file"),
        "menu-toggle-edit" => Some("toggle-edit"),
        "menu-toggle-sidebar" => Some("toggle-sidebar"),
        "menu-zoom-in" => Some("zoom-in"),
        "menu-zoom-out" => Some("zoom-out"),
        "menu-zoom-reset" => Some("zoom-reset"),
        // B1: "Open from remote…" File menu item. The frontend's
        // OpenRemoteDialog (B2) subscribes to `mdviewer:open-remote`,
        // which `menuBridge.ts` synthesizes from this action string.
        "menu-open-remote" => Some("open-remote"),
        _ => None,
    }
}

/// Build the application menu. Owns no state — every dynamic shortcut comes
/// from the user's settings via the keymap layer; the menu accelerators
/// here are the platform conventions (Cmd+O, Cmd+,, etc.) and are intended
/// to mirror the keymap defaults.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // App menu — macOS surfaces this as the bold app-name item. On
    // Windows/Linux the menu bar starts with File, but we still include
    // `Settings…` here because muda hides the platform-irrelevant items
    // (about/services/hide) automatically.
    // `mut` is consumed by the macOS-only block below; on other platforms
    // it's unused, so silence the warning rather than #[cfg]-fork the whole
    // builder chain.
    #[allow(unused_mut)]
    let mut app_menu_builder = SubmenuBuilder::new(app, "MDViewer")
        .item(&PredefinedMenuItem::about(app, None, None)?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu-open-settings",
            "Settings…",
            true,
            Some("CmdOrCtrl+,"),
        )?);

    // macOS-only: shell-tool installer entries. The dmg can't run a
    // postinstall, so we follow the VS Code / iTerm2 convention of
    // exposing an in-app menu that drops `/usr/local/bin/mdviewer`. On
    // Linux the deb/rpm install already lands at `/usr/bin/mdviewer`
    // (locked via `mainBinaryName` in tauri.conf.json), and on Windows
    // the MSI installer puts the binary on PATH — so we don't surface
    // these items there.
    #[cfg(target_os = "macos")]
    {
        app_menu_builder = app_menu_builder
            .separator()
            .item(&MenuItem::with_id(
                app,
                MENU_ID_INSTALL_CLI,
                "Install 'mdviewer' Command in PATH…",
                true,
                None::<&str>,
            )?)
            .item(&MenuItem::with_id(
                app,
                MENU_ID_UNINSTALL_CLI,
                "Uninstall 'mdviewer' Command…",
                true,
                None::<&str>,
            )?);
    }

    let app_menu = app_menu_builder
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&MenuItem::with_id(
            app,
            "menu-new-document",
            "New Document",
            true,
            Some("CmdOrCtrl+N"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu-open-file",
            "Open…",
            true,
            Some("CmdOrCtrl+O"),
        )?)
        // B1: SSH "Open from remote…" picker. Sits next to "Open…" so the
        // two are visually adjacent; uses CmdOrCtrl+Shift+O because the
        // unshifted variant is already taken by the local-file picker.
        // The id `menu-open-remote` is what `menu_id_to_action` maps to
        // the `open-remote` action string the frontend's menuBridge (B2)
        // forwards as `mdviewer:open-remote` for OpenRemoteDialog.
        .item(&MenuItem::with_id(
            app,
            "menu-open-remote",
            "Open from remote…",
            true,
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu-save-file",
            "Save",
            true,
            Some("CmdOrCtrl+S"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu-close-tab",
            "Close Tab",
            true,
            Some("CmdOrCtrl+W"),
        )?)
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu-toggle-edit",
            "Toggle Edit Mode",
            true,
            Some("CmdOrCtrl+E"),
        )?)
        .build()?;

    let view_menu: Submenu<R> = SubmenuBuilder::new(app, "View")
        .item(&MenuItem::with_id(
            app,
            "menu-toggle-sidebar",
            "Toggle Comments Sidebar",
            true,
            Some("CmdOrCtrl+B"),
        )?)
        .separator()
        .item(&MenuItem::with_id(
            app,
            "menu-zoom-in",
            "Zoom In",
            true,
            Some("CmdOrCtrl+="),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu-zoom-out",
            "Zoom Out",
            true,
            Some("CmdOrCtrl+-"),
        )?)
        .item(&MenuItem::with_id(
            app,
            "menu-zoom-reset",
            "Reset Zoom",
            true,
            Some("CmdOrCtrl+0"),
        )?)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The id ↔ action contract is what the frontend depends on. If a menu
    /// id changes, this test breaks before the user discovers a dead menu
    /// item. The empty strings and unknown ids must return None so
    /// predefined items (cut/copy/paste/quit) don't accidentally double-
    /// dispatch into the frontend.
    #[test]
    fn menu_id_action_mapping_is_stable() {
        assert_eq!(menu_id_to_action("menu-open-file"), Some("open-file"));
        assert_eq!(menu_id_to_action("menu-new-document"), Some("new-document"));
        assert_eq!(menu_id_to_action("menu-close-tab"), Some("close-tab"));
        assert_eq!(menu_id_to_action("menu-open-settings"), Some("open-settings"));
        assert_eq!(menu_id_to_action("menu-save-file"), Some("save-file"));
        assert_eq!(menu_id_to_action("menu-toggle-edit"), Some("toggle-edit"));
        assert_eq!(menu_id_to_action("menu-toggle-sidebar"), Some("toggle-sidebar"));
    }

    /// B1: the "Open from remote…" File menu item bridges to the
    /// frontend's OpenRemoteDialog via the existing `menu-action` Tauri
    /// event. The Rust id `menu-open-remote` translates to the action
    /// string `open-remote`, which `menuBridge.ts` (B2) will map onto
    /// `mdviewer:open-remote` for the dialog to subscribe to.
    #[test]
    fn menu_id_action_mapping_includes_open_remote() {
        assert_eq!(menu_id_to_action("menu-open-remote"), Some("open-remote"));
    }

    /// The View-menu zoom items map to kebab-case action strings that the
    /// frontend's `menuBridge.ts` translates into the
    /// `mdviewer:font-{increase,decrease,reset}` CustomEvents. Pinning these
    /// mappings here keeps the Rust ↔ TS contract stable.
    #[test]
    fn menu_id_action_mapping_includes_zoom() {
        assert_eq!(menu_id_to_action("menu-zoom-in"), Some("zoom-in"));
        assert_eq!(menu_id_to_action("menu-zoom-out"), Some("zoom-out"));
        assert_eq!(menu_id_to_action("menu-zoom-reset"), Some("zoom-reset"));
    }

    #[test]
    fn unknown_menu_ids_return_none() {
        // Predefined items (cut/copy/paste/quit/about) flow through the
        // same on_menu_event closure but must NOT translate into a
        // frontend action — the OS already handled them.
        for id in [
            "",
            "quit",
            "cut",
            "copy",
            "paste",
            "about",
            "services",
            "menu-unknown",
            "MENU-OPEN-FILE", // case-sensitive
            // The CLI installer items live on the same `on_menu_event`
            // bus but are intentionally NOT bridged into the frontend
            // — their handler shells out to osascript Rust-side. Pin
            // that they stay out of `menu_id_to_action`.
            MENU_ID_INSTALL_CLI,
            MENU_ID_UNINSTALL_CLI,
        ] {
            assert_eq!(menu_id_to_action(id), None, "id={:?} should be unknown", id);
        }
    }

    /// The CLI-installer ids are the contract between menu.rs and main.rs's
    /// on_menu_event closure. Pin them here so a rename can't slip past the
    /// type system unnoticed.
    #[test]
    fn cli_installer_menu_ids_are_stable() {
        assert_eq!(MENU_ID_INSTALL_CLI, "menu-install-cli");
        assert_eq!(MENU_ID_UNINSTALL_CLI, "menu-uninstall-cli");
    }
}
