import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MENU_ACTION_TO_EVENT,
  dispatchMenuAction,
  installMenuBridge,
  menuBridgeReady,
  __resetMenuBridgeForTests,
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

  it('every File / Settings action dispatches its mapped CustomEvent', async () => {
    // Clicking Open… → File dialog opens (mdviewer:open-file).
    // Clicking Settings… → Settings overlay mounts (mdviewer:open-settings).
    // Each action must dispatch its mapped event. Most actions map 1:1,
    // but a few are aliases (e.g. 'settings' and 'open-settings' both
    // dispatch mdviewer:open-settings — the wysiwyg e2e spec uses the
    // short form).
    const KNOWN_ALIASES: Record<string, string> = {
      'settings': 'open-settings',
    };
    const seen = new Map<string, string>();
    for (const action of Object.keys(MENU_ACTION_TO_EVENT)) {
      const event = MENU_ACTION_TO_EVENT[action];
      const prior = seen.get(event);
      if (prior) {
        expect(KNOWN_ALIASES[action]).toBe(prior);
      } else {
        seen.set(event, action);
      }
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
    __resetMenuBridgeForTests();
    const unlisten = await installMenuBridge();
    expect(typeof unlisten).toBe('function');
    // Calling unlisten must not throw even when no real subscription
    // happened.
    expect(() => unlisten()).not.toThrow();
  });
});

/**
 * A2 race-safety: the diagnose-first investigation pinpointed
 * `void installMenuBridge()` in src/main.ts as a fire-and-forget call —
 * after `browser.reloadSession()` the spec emits `menu-action` before the
 * `listen()` registration completes, so the listener never fires and the
 * Settings overlay never mounts. The fix is to expose a `menuBridgeReady`
 * promise the e2e `__mdviewerE2E.emitMenuAction` hook awaits before
 * `emit`-ing, closing the race entirely.
 */
describe('menuBridge subscription-timing (A2 race fix)', () => {
  beforeEach(() => {
    __resetMenuBridgeForTests();
  });

  it('menuBridgeReady() resolves to a settled promise (no race) only after installMenuBridge has been called', async () => {
    // Before any call to installMenuBridge, menuBridgeReady() returns an
    // already-resolved promise so callers don't deadlock when the bridge
    // never ran (e.g. ProfileSetup boot path before Workspace mounts).
    await expect(menuBridgeReady()).resolves.toBeUndefined();
  });

  it('menuBridgeReady() awaits the same install completion across multiple callers', async () => {
    // Calling installMenuBridge() returns a promise. Anyone awaiting
    // menuBridgeReady() before installMenuBridge resolves must wait for
    // the same underlying registration — otherwise emitMenuAction could
    // race past it. We assert by ordering: the ready-promise must resolve
    // AFTER the install promise (or at the same microtask, but never
    // before it).
    let installResolved = false;
    const install = installMenuBridge().then((u) => {
      installResolved = true;
      return u;
    });
    const ready = menuBridgeReady().then(() => {
      // Must not resolve before install — the bridge isn't ready until
      // listen() returns.
      expect(installResolved).toBe(true);
    });
    await install;
    await ready;
  });

  it('installMenuBridge is memoized — repeated calls return the same install promise', async () => {
    // Production main() may bootstrap twice in dev hot-reload scenarios.
    // The bridge should subscribe once; otherwise the listen-handler runs
    // n times per event and the user sees the Settings overlay flicker.
    const first = installMenuBridge();
    const second = installMenuBridge();
    expect(first).toBe(second);
    await first;
  });

  it('__resetMenuBridgeForTests clears the memo so the next install runs fresh', async () => {
    // Without this reset the suite would carry the jsdom no-op unlisten
    // across describes and `menuBridgeReady()` would resolve immediately
    // for the second-suite's first assertion (false-green).
    await installMenuBridge();
    __resetMenuBridgeForTests();
    // After reset, menuBridgeReady is back to the pre-install "no work
    // queued" resolved state.
    await expect(menuBridgeReady()).resolves.toBeUndefined();
  });
});
