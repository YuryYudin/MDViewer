import { describe, it, expect, vi } from 'vitest';
import {
  MENU_ACTION_TO_EVENT,
  dispatchMenuAction,
  installMenuBridge,
} from '../src/menuBridge';

/**
 * The native menu uses this bridge to reach the existing CustomEvent
 * handlers. The Rust side (src-tauri/src/menu.rs) shares the same id ↔
 * action contract — these tests are the JS half.
 */
describe('menuBridge', () => {
  it('exports a frozen mapping covering File + Settings + edit shortcuts', () => {
    // Every entry must be `mdviewer:<thing>`-shaped; this catches typos
    // that would silently dispatch into the void.
    for (const [action, event] of Object.entries(MENU_ACTION_TO_EVENT)) {
      expect(event.startsWith('mdviewer:')).toBe(true);
      expect(action.length).toBeGreaterThan(0);
    }
    // The minimum the user explicitly asked for: File menu items + Settings.
    expect(MENU_ACTION_TO_EVENT['open-file']).toBe('mdviewer:open-file');
    expect(MENU_ACTION_TO_EVENT['open-from-drive']).toBe('mdviewer:open-from-drive');
    expect(MENU_ACTION_TO_EVENT['new-document']).toBe('mdviewer:new-document');
    expect(MENU_ACTION_TO_EVENT['close-tab']).toBe('mdviewer:close-tab');
    expect(MENU_ACTION_TO_EVENT['open-settings']).toBe('mdviewer:open-settings');
    // Frozen so accidental mutation can't corrupt the mapping at runtime.
    expect(Object.isFrozen(MENU_ACTION_TO_EVENT)).toBe(true);
  });

  it('keymap save-file aliases to mdviewer:save-active', () => {
    // The keymap's save action dispatches save-active; if the menu used a
    // different event name the save handler would have to listen on two
    // channels. This test pins the alias so the indirection stays
    // intentional, not accidental.
    expect(MENU_ACTION_TO_EVENT['save-file']).toBe('mdviewer:save-active');
  });

  it('File → "Open from remote…" maps to mdviewer:open-remote (B2)', () => {
    // B2: the Rust menu builds an `Open from remote…` item with id
    // `menu-open-remote`. The Rust id-to-action map translates that to
    // the action string `open-remote`, which lands here and must surface
    // as the `mdviewer:open-remote` CustomEvent the Workspace listens for.
    expect(MENU_ACTION_TO_EVENT['open-remote']).toBe('mdviewer:open-remote');
  });

  it('View → Zoom items map to the three font-zoom CustomEvents', () => {
    // The native View menu uses kebab-case action ids (`zoom-in`, `zoom-out`,
    // `zoom-reset`) per `menu_id_to_action`. The bridge translates them to
    // the three distinct CustomEvent names the Workspace listens for —
    // distinct events instead of one + delta payload because the bridge's
    // contract is `{ actionString -> eventName }` with no detail payload.
    expect(MENU_ACTION_TO_EVENT['zoom-in']).toBe('mdviewer:font-increase');
    expect(MENU_ACTION_TO_EVENT['zoom-out']).toBe('mdviewer:font-decrease');
    expect(MENU_ACTION_TO_EVENT['zoom-reset']).toBe('mdviewer:font-reset');
  });

  it('dispatchMenuAction fires the matching CustomEvent and reports the name', () => {
    const handler = vi.fn();
    document.addEventListener('mdviewer:open-settings', handler, { once: true });
    const dispatched = dispatchMenuAction('open-settings');
    expect(dispatched).toBe('mdviewer:open-settings');
    expect(handler).toHaveBeenCalled();
  });

  it('dispatchMenuAction returns null and dispatches nothing for unknown actions', () => {
    // Predefined OS items (cut/copy/paste/quit) should never reach the
    // bridge — the Rust side filters them out before emitting — but if
    // one slips through, the bridge must not synthesize a bogus event.
    const handler = vi.fn();
    const events = ['mdviewer:cut', 'mdviewer:quit', 'mdviewer:'];
    for (const e of events) document.addEventListener(e, handler);
    expect(dispatchMenuAction('cut')).toBeNull();
    expect(dispatchMenuAction('quit')).toBeNull();
    expect(dispatchMenuAction('unknown-action')).toBeNull();
    expect(dispatchMenuAction('')).toBeNull();
    for (const e of events) document.removeEventListener(e, handler);
    expect(handler).not.toHaveBeenCalled();
  });

  it('every File / Settings action dispatches a unique CustomEvent', async () => {
    // Clicking Open… → File dialog opens (mdviewer:open-file).
    // Clicking Settings… → Settings overlay mounts (mdviewer:open-settings).
    // Each action must dispatch a DISTINCT event; collisions would route
    // multiple menu items into the same handler.
    const seen = new Set<string>();
    for (const action of Object.keys(MENU_ACTION_TO_EVENT)) {
      const event = MENU_ACTION_TO_EVENT[action];
      expect(seen.has(event)).toBe(false);
      seen.add(event);
      const handler = vi.fn();
      document.addEventListener(event, handler, { once: true });
      const dispatched = dispatchMenuAction(action);
      expect(dispatched).toBe(event);
      expect(handler).toHaveBeenCalled();
    }
  });

  it('installMenuBridge is a no-op when the Tauri runtime is missing', async () => {
    // jsdom has no @tauri-apps/api/event runtime; installMenuBridge
    // catches the import failure and returns a noop unsubscribe rather
    // than crashing main()'s bootstrap.
    const unlisten = await installMenuBridge();
    expect(typeof unlisten).toBe('function');
    // Calling unlisten must not throw even when no real subscription
    // happened.
    expect(() => unlisten()).not.toThrow();
  });
});
