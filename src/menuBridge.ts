/**
 * Native menu bridge.
 *
 * The Rust side (`src-tauri/src/menu.rs`) emits a `menu-action` Tauri event
 * with a string payload like `"open-file"` whenever the user clicks a
 * non-predefined menu item. We map that payload onto the existing
 * `mdviewer:*` CustomEvents the rest of the app already listens for, so
 * keymap shortcuts, on-screen buttons, and menu items all converge on the
 * same handlers.
 *
 * The mapping is exported as a plain object so unit tests can pin the
 * contract without spinning up the Tauri runtime.
 */

/**
 * Pure mapping: menu-action payload → CustomEvent name. Adding a new item
 * is one line here plus one line in `menu.rs::menu_id_to_action`. Anything
 * not in the table is silently ignored — predefined OS items
 * (cut/copy/paste/quit) never enter this path because the Rust side filters
 * them out before emitting.
 */
export const MENU_ACTION_TO_EVENT: Readonly<Record<string, string>> = Object.freeze({
  'open-file': 'mdviewer:open-file',
  'open-from-drive': 'mdviewer:open-from-drive',
  // B2: File → "Open from remote…" → `mdviewer:open-remote`. The Rust
  // side (menu_id_to_action in src-tauri/src/menu.rs) maps the menu id
  // `menu-open-remote` to the action string `open-remote` which lands
  // here and fans out as the CustomEvent the Workspace listens for.
  'open-remote': 'mdviewer:open-remote',
  // B3: File → "New Window" (CmdOrCtrl+Shift+N) → `mdviewer:new-window`. The
  // Rust side (menu_id_to_action) maps the menu id `menu-new-window` to the
  // action string `new-window` which lands here and fans out as the
  // CustomEvent the Workspace handler turns into the `new_window` IPC (C1)
  // that spawns a second window on the StartPage.
  'new-window': 'mdviewer:new-window',
  'new-document': 'mdviewer:new-document',
  'close-tab': 'mdviewer:close-tab',
  'open-settings': 'mdviewer:open-settings',
  // B5: spec contract — specs 23/24 dispatch `mdviewer:save-document`.
  // Renamed from the legacy `save-active` so the menu, keymap, and
  // WDIO suite converge on the same single event name.
  'save-file': 'mdviewer:save-document',
  'toggle-edit': 'mdviewer:toggle-edit',
  'toggle-sidebar': 'mdviewer:toggle-sidebar',
  // View → Zoom items. The Rust side (`menu_id_to_action`) maps the menu
  // ids `menu-zoom-in / menu-zoom-out / menu-zoom-reset` to these
  // kebab-case action strings; we map them in turn to the three distinct
  // `mdviewer:font-*` CustomEvents (no payload) that Workspace listens
  // for. Three events instead of one + delta payload because widening
  // this bridge to carry a `detail` was rejected in the design doc.
  'zoom-in': 'mdviewer:font-increase',
  'zoom-out': 'mdviewer:font-decrease',
  'zoom-reset': 'mdviewer:font-reset',
  // B1: File → Print… (CmdOrCtrl+P). The Rust side maps menu id `menu-print`
  // to the action string `print`; we fan it out as `mdviewer:print`, which
  // main.ts turns into window.print() (guarded with a no-doc toast).
  'print': 'mdviewer:print',
  // C1: File → Export to PDF… (no accelerator). The Rust side maps menu id
  // `menu-export-pdf` to the action string `export-pdf`; we fan it out as
  // `mdviewer:export-pdf`, which main.ts turns into the native save dialog →
  // `export_pdf` invoke flow (defaulting to <stem>.pdf, cancel = no-op).
  'export-pdf': 'mdviewer:export-pdf',
});

/**
 * Dispatch the matching CustomEvent for a menu-action payload. Returns the
 * event name that was dispatched (or `null` if the action was unknown) so
 * tests can assert behavior without monkey-patching `document`.
 */
export function dispatchMenuAction(action: string): string | null {
  const eventName = MENU_ACTION_TO_EVENT[action];
  if (!eventName) return null;
  document.dispatchEvent(new CustomEvent(eventName));
  return eventName;
}

/**
 * Subscribe to the Tauri `menu-action` event and forward each click into
 * the corresponding CustomEvent. The Tauri import is dynamic so jsdom unit
 * tests of the dispatch logic don't need a Tauri runtime stub. Returns a
 * promise that resolves to an unsubscribe function once the listener is
 * attached; resolves to a no-op when the runtime is unavailable.
 */
export async function installMenuBridge(): Promise<() => void> {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlisten = await listen<string>('menu-action', (ev) => {
      // The payload is the action string — Rust emits `app.emit("menu-action", action)`
      // where `action` is a `&str`. Tauri serializes it as a JSON string.
      if (typeof ev.payload === 'string') dispatchMenuAction(ev.payload);
    });
    return unlisten;
  } catch {
    // jsdom / non-Tauri environments — the bridge is a no-op.
    return () => undefined;
  }
}
