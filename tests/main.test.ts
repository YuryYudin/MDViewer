/**
 * Tests for the bootstrap module. The full Tauri-backed `main()` performs
 * IPC calls; we mock the IPC adapter so the bootstrap can run inside jsdom.
 *
 * Coverage focuses on:
 *   - the cached-theme path applied before settings arrive
 *   - mounting ProfileSetup vs Workspace based on display_name
 *   - applying the saved theme (dark, light, follow_system)
 *   - keymap installation + the toggle_dark dispatcher
 *   - the bootstrap error fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../src/ipc';

// jsdom in this configuration ships a Storage *property* but not its
// prototype methods. Stub a minimal in-memory implementation so the
// bootstrap's `localStorage.getItem / setItem` calls work.
const memStore = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
    setItem: (k: string, v: string) => void memStore.set(k, String(v)),
    removeItem: (k: string) => void memStore.delete(k),
    clear: () => memStore.clear(),
    key: (i: number) => Array.from(memStore.keys())[i] ?? null,
    get length() {
      return memStore.size;
    },
  },
});

const fakeIpc = {
  appInfo: vi.fn().mockResolvedValue({ version: '0.0.0', commit_hash: 'unit' }),
  openDocument: vi.fn().mockResolvedValue({ kind: 'document' }),
  closeTab: vi.fn().mockResolvedValue(undefined),
  activateTab: vi.fn().mockResolvedValue(undefined),
  listOpenDocuments: vi.fn().mockResolvedValue([]),
  getActiveTabId: vi.fn().mockResolvedValue(null),
  listRecents: vi.fn().mockResolvedValue([]),
  // `getSettings` is called both by main() and by mountStartPage now;
  // give it a default resolved value so a single mockResolvedValueOnce
  // (which only seeds the first call) doesn't leave the second call
  // returning undefined and tripping `.catch` on a non-promise.
  getSettings: vi.fn().mockResolvedValue({
    profile: { user_id: 'u', display_name: '', color: '#888' },
    appearance: { theme: 'light' },
  }),
  setSettings: vi.fn().mockResolvedValue(undefined),
  listThreads: vi.fn().mockResolvedValue([]),
  createThread: vi.fn(),
  postReply: vi.fn(),
  resolveThread: vi.fn(),
  renderMarkdown: vi.fn(),
  resolveAnchor: vi.fn(),
  // C1 (printing): the Export-to-PDF flow invokes `export_pdf` with the
  // dialog-chosen path. Default to echoing the path back (the command resolves
  // to the written path on success).
  exportPdf: vi.fn((path: string) => Promise.resolve(path)),
};

vi.mock('../src/ipc', async () => {
  const actual = await vi.importActual<typeof import('../src/ipc')>('../src/ipc');
  return { ...actual, tauriIpc: fakeIpc };
});

// C2: window-addressed event bus. `main()` resolves `getCurrentWindow().label`
// at boot and subscribes to THIS window's addressed events via
// `getCurrentWindow().listen(name, cb)` — not the broadcast global `listen`.
// Capture each window-scoped subscription so tests can fire the callbacks
// deterministically and assert the boot label was resolved.
type WinListener = (ev: { payload: unknown }) => void;
const currentWindow = {
  label: 'main',
  listeners: {} as Record<string, WinListener[]>,
  listen: vi.fn((event: string, cb: WinListener) => {
    (currentWindow.listeners[event] ||= []).push(cb);
    return Promise.resolve(() => undefined);
  }),
};
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => currentWindow,
}));

// C2: raw `invoke('new_window')` lands here (the typed ipc.ts binding is D1).
const rawInvoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => rawInvoke(...args),
}));

// C1 (printing): the Export-to-PDF listener dynamically imports
// `@tauri-apps/plugin-dialog` and calls `save()` to pick the PDF path.
// Mock it so unit tests can drive confirm (return a path) / cancel (null)
// and assert the `defaultPath` the listener computed.
const saveDialog = vi.fn();
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (...args: unknown[]) => saveDialog(...args),
}));

// Stub the CSS imports so the bootstrap can be exercised in jsdom.
vi.mock('../src/styles/theme.css', () => ({}));
vi.mock('../src/styles/app.css', () => ({}));

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    profile: { user_id: 'u', display_name: 'Mira', color: '#888' },
    appearance: { theme: 'light', font_size_px: 14, line_height: 1.5, density: 'normal' },
    editor: {
      default_open_mode: 'view',
      auto_save: false,
      auto_save_debounce_ms: 500,
      external_change_behavior: 'ask',
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
      render_line_breaks: true,
    },
    comments: {
      auto_merge: 'ask',
      reattachment_confidence: 0.85,
      sidecar_pattern: '{name}.comments.json',
      show_resolved: true,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: {},
    onboarding: { cli_install_prompt_seen_for: '' },
    ...overrides,
  };
}

function resetDom(includeApp: boolean): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  document.body.classList.remove('theme-dark', 'theme-follow-system');
  if (includeApp) {
    const app = document.createElement('div');
    app.id = 'app';
    document.body.appendChild(app);
  }
}

describe('main()', () => {
  beforeEach(() => {
    resetDom(true);
    localStorage.removeItem('mdviewer.theme');
    Object.values(fakeIpc).forEach((m) => (m as any).mockClear?.());
    fakeIpc.listOpenDocuments.mockResolvedValue([]);
    fakeIpc.getActiveTabId.mockResolvedValue(null);
    fakeIpc.exportPdf.mockImplementation((path: string) => Promise.resolve(path));
    fakeIpc.listRecents.mockResolvedValue([]);
    currentWindow.label = 'main';
    currentWindow.listeners = {};
    currentWindow.listen.mockClear();
    saveDialog.mockReset();
    rawInvoke.mockClear();
  });

  it('mounts Workspace when display_name is set', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    expect(document.querySelector('[data-view="workspace"]')).toBeTruthy();
  });

  it('mounts ProfileSetup when display_name is empty', async () => {
    fakeIpc.getSettings.mockResolvedValue(
      settingsWith({ profile: { user_id: 'u', display_name: '', color: '#888' } }),
    );
    const { main } = await import('../src/main');
    await main();
    expect(document.querySelector('[data-view="profile-setup"]')).toBeTruthy();
  });

  it('applies the dark theme when settings.appearance.theme === "dark"', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({
        appearance: { theme: 'dark', font_size_px: 14, line_height: 1.5, density: 'normal' },
      }),
    );
    const { main } = await import('../src/main');
    await main();
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    expect(localStorage.getItem('mdviewer.theme')).toBe('dark');
  });

  it('applies theme-cool when settings.appearance.dark_variant === "cool"', async () => {
    document.body.classList.remove('theme-cool');
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({
        appearance: {
          theme: 'dark',
          font_size_px: 14,
          line_height: 1.5,
          density: 'normal',
          dark_variant: 'cool',
        },
      }),
    );
    const { main } = await import('../src/main');
    await main();
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    expect(document.body.classList.contains('theme-cool')).toBe(true);
    expect(localStorage.getItem('mdviewer.darkVariant')).toBe('cool');
  });

  it('does not apply theme-cool when dark_variant === "pure" (default)', async () => {
    document.body.classList.add('theme-cool'); // ensure it's cleared
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({
        appearance: {
          theme: 'dark',
          font_size_px: 14,
          line_height: 1.5,
          density: 'normal',
          dark_variant: 'pure',
        },
      }),
    );
    const { main } = await import('../src/main');
    await main();
    expect(document.body.classList.contains('theme-cool')).toBe(false);
    expect(localStorage.getItem('mdviewer.darkVariant')).toBe('pure');
  });

  it('mdviewer:settings-changed event re-applies the dark variant live', async () => {
    document.body.classList.remove('theme-cool');
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({
        appearance: {
          theme: 'dark',
          font_size_px: 14,
          line_height: 1.5,
          density: 'normal',
          dark_variant: 'pure',
        },
      }),
    );
    const { main } = await import('../src/main');
    await main();
    expect(document.body.classList.contains('theme-cool')).toBe(false);

    // Simulate the broadcast that ipc.setSettings emits after a successful save.
    document.dispatchEvent(
      new CustomEvent('mdviewer:settings-changed', {
        detail: settingsWith({
          appearance: {
            theme: 'dark',
            font_size_px: 14,
            line_height: 1.5,
            density: 'normal',
            dark_variant: 'cool',
          },
        }),
      }),
    );
    expect(document.body.classList.contains('theme-cool')).toBe(true);
  });

  it('applies the light theme by default', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    expect(document.body.classList.contains('theme-dark')).toBe(false);
    expect(localStorage.getItem('mdviewer.theme')).toBe('light');
  });

  it('applies follow_system based on prefers-color-scheme', async () => {
    // vitest 4 made vi.spyOn strict — it throws if the target isn't an
    // existing function, and jsdom doesn't implement window.matchMedia. Stub
    // it as a fresh global instead (cleared in finally via unstubAllGlobals).
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({
        matches: q.includes('dark'),
        media: q,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    try {
      fakeIpc.getSettings.mockResolvedValueOnce(
        settingsWith({
          appearance: {
            theme: 'follow_system',
            font_size_px: 14,
            line_height: 1.5,
            density: 'normal',
          },
        }),
      );
      const { main } = await import('../src/main');
      await main();
      expect(document.body.classList.contains('theme-dark')).toBe(true);
      expect(document.body.classList.contains('theme-follow-system')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('honors a cached theme before settings arrive', async () => {
    localStorage.setItem('mdviewer.theme', 'dark');
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    // Light theme from settings overrides the cached value once settings load.
    expect(localStorage.getItem('mdviewer.theme')).toBe('light');
  });

  it('toggle_dark keymap action flips body theme class', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({ shortcuts: { toggle_dark: 'CmdOrCtrl+D' } }),
    );
    const { main } = await import('../src/main');
    await main();
    expect(document.body.classList.contains('theme-dark')).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true }));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
  });

  it('keymap actions dispatch the corresponding mdviewer:* events', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({
        shortcuts: {
          save_file: 'CmdOrCtrl+S',
          toggle_edit: 'CmdOrCtrl+E',
          comment_on_selection: 'CmdOrCtrl+M',
          toggle_sidebar: 'CmdOrCtrl+B',
          resolve_thread: 'CmdOrCtrl+R',
          close_tab: 'CmdOrCtrl+W',
          open_settings: 'CmdOrCtrl+,',
        },
      }),
    );
    const { main } = await import('../src/main');
    await main();

    const cases: Array<{ key: string; event: string }> = [
      { key: 's', event: 'mdviewer:save-document' },
      { key: 'e', event: 'mdviewer:toggle-edit' },
      { key: 'm', event: 'mdviewer:comment-on-selection' },
      { key: 'b', event: 'mdviewer:toggle-sidebar' },
      { key: 'r', event: 'mdviewer:resolve-focused-thread' },
      { key: 'w', event: 'mdviewer:close-tab' },
      { key: ',', event: 'mdviewer:open-settings' },
    ];
    for (const { key, event } of cases) {
      const handler = vi.fn();
      document.addEventListener(event, handler, { once: true });
      window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true }));
      expect(handler).toHaveBeenCalled();
    }
  });

  it('font_increase keymap action dispatches mdviewer:font-increase', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({ shortcuts: { font_increase: 'Mod+=' } }),
    );
    const { main } = await import('../src/main');
    await main();
    const handler = vi.fn();
    document.addEventListener('mdviewer:font-increase', handler, { once: true });
    // Use the natural physical press: Cmd+Shift+= produces key="+". The
    // shifted-symbol fold rewrites it to mod+= so it matches Mod+=.
    window.dispatchEvent(
      new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: '+' }),
    );
    expect(handler).toHaveBeenCalled();
  });

  it('font_decrease keymap action dispatches mdviewer:font-decrease', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({ shortcuts: { font_decrease: 'Mod+-' } }),
    );
    const { main } = await import('../src/main');
    await main();
    const handler = vi.fn();
    document.addEventListener('mdviewer:font-decrease', handler, { once: true });
    window.dispatchEvent(
      new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: '_' }),
    );
    expect(handler).toHaveBeenCalled();
  });

  it('font_reset keymap action dispatches mdviewer:font-reset', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(
      settingsWith({ shortcuts: { font_reset: 'Mod+0' } }),
    );
    const { main } = await import('../src/main');
    await main();
    const handler = vi.fn();
    document.addEventListener('mdviewer:font-reset', handler, { once: true });
    window.dispatchEvent(
      new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: ')' }),
    );
    expect(handler).toHaveBeenCalled();
  });

  it('open_file keymap action dispatches mdviewer:open-file', async () => {
    // Used to click `[data-test="file-input"]` directly. That input only
    // exists on StartPage, so the shortcut died once a doc was open. Now
    // `open_file` dispatches `mdviewer:open-file`; main.ts's listener owns
    // both production (OS dialog) and e2e branches.
    fakeIpc.getSettings.mockResolvedValue(
      settingsWith({ shortcuts: { open_file: 'CmdOrCtrl+O' } }),
    );
    const { main } = await import('../src/main');
    await main();
    const handler = vi.fn();
    document.addEventListener('mdviewer:open-file', handler, { once: true });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true }));
    expect(handler).toHaveBeenCalled();
  });

  it('mdviewer:print calls window.print() when a document is open', async () => {
    // B1 (printing): with a document mounted (the body region carries the
    // `with-document` class the Workspace sets on a real Document mount),
    // the print handler calls window.print() so the OS print dialog opens.
    // NB: main() registers its `mdviewer:print` listener on the shared
    // `document`, so across this file's many main() boots several copies of
    // the listener accumulate. They are all functionally identical, so we
    // assert window.print() was reached (>=1) and that NO toast fired —
    // the doc-open branch, not the no-doc branch.
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    // Mark every body region doc-open so any accumulated listener takes the
    // print branch deterministically regardless of which one querySelector
    // resolves.
    const bodies = document.querySelectorAll('[data-region="body"]');
    expect(bodies.length).toBeGreaterThan(0);
    bodies.forEach((b) => b.classList.add('with-document'));
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    const toast = vi.fn();
    document.addEventListener('mdviewer:toast', toast);
    document.dispatchEvent(new CustomEvent('mdviewer:print'));
    expect(printSpy).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    document.removeEventListener('mdviewer:toast', toast);
    printSpy.mockRestore();
  });

  it('mdviewer:print no-ops with a "No document to print" toast when no doc is open', async () => {
    // B1: triggered via shortcut with no document active, the Print handler
    // must NOT call window.print(); it surfaces a `No document to print`
    // toast instead. After main() with listOpenDocuments=[] the body region
    // shows the StartPage (no `with-document` class). Strip the class from
    // every body region so no accumulated listener (see the doc-open test)
    // takes the print branch off a stale node.
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    const bodies = document.querySelectorAll('[data-region="body"]');
    expect(bodies.length).toBeGreaterThan(0);
    bodies.forEach((b) => b.classList.remove('with-document'));
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    let toastMessage: string | undefined;
    const onToast = (ev: Event) => {
      toastMessage = (ev as CustomEvent<{ message: string }>).detail?.message;
    };
    document.addEventListener('mdviewer:toast', onToast);
    document.dispatchEvent(new CustomEvent('mdviewer:print'));
    expect(printSpy).not.toHaveBeenCalled();
    expect(toastMessage).toBe('No document to print');
    document.removeEventListener('mdviewer:toast', onToast);
    printSpy.mockRestore();
  });

  // === C1 (printing): Export-to-PDF save flow (S5 frontend half / S6 / S7 / S8) ===

  /**
   * Resolve the export listener once main() has booted with one active doc.
   * Seeds the active-tab IPCs so the listener can derive `<dir>/<stem>.pdf`,
   * boots main(), then returns helpers to fire the event + read any toast.
   */
  async function bootWithActiveDoc(docPath: string): Promise<{
    fireExport: () => void;
    lastToast: () => string | undefined;
  }> {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    fakeIpc.getActiveTabId.mockResolvedValue('tab-1');
    fakeIpc.listOpenDocuments.mockResolvedValue([{ id: 'tab-1', path: docPath }]);
    const { main } = await import('../src/main');
    await main();
    let toastMessage: string | undefined;
    document.addEventListener('mdviewer:toast', (ev: Event) => {
      toastMessage = (ev as CustomEvent<{ message: string }>).detail?.message;
    });
    return {
      fireExport: () => document.dispatchEvent(new CustomEvent('mdviewer:export-pdf')),
      lastToast: () => toastMessage,
    };
  }

  it('S6: export-pdf opens the save dialog defaulting to <stem>.pdf in the doc folder', async () => {
    saveDialog.mockResolvedValue('/docs/notes.pdf');
    const { fireExport } = await bootWithActiveDoc('/docs/notes.md');
    fireExport();
    // Let the async listener (getActiveTabId → listOpenDocuments → save) settle.
    await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled());
    const opts = saveDialog.mock.calls[0][0] as { defaultPath?: string };
    expect(opts.defaultPath).toMatch(/notes\.pdf$/);
    // The default lands in the document's own folder.
    expect(opts.defaultPath).toBe('/docs/notes.pdf');
  });

  it('S5: a confirmed path invokes export_pdf and shows an "Exported to" toast', async () => {
    saveDialog.mockResolvedValue('/docs/notes.pdf');
    const { fireExport, lastToast } = await bootWithActiveDoc('/docs/notes.md');
    fireExport();
    await vi.waitFor(() => expect(fakeIpc.exportPdf).toHaveBeenCalledWith('/docs/notes.pdf'));
    await vi.waitFor(() => expect(lastToast()).toMatch(/Exported to .*notes\.pdf/));
  });

  it('S7: cancelling the save dialog does not invoke export_pdf and shows no toast', async () => {
    saveDialog.mockResolvedValue(null); // user cancelled
    const { fireExport, lastToast } = await bootWithActiveDoc('/docs/notes.md');
    fireExport();
    await vi.waitFor(() => expect(saveDialog).toHaveBeenCalled());
    // Give any (incorrect) downstream invoke/toast a tick to fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(fakeIpc.exportPdf).not.toHaveBeenCalled();
    expect(lastToast()).toBeUndefined();
  });

  it('S8: an export_pdf rejection surfaces an error toast without throwing', async () => {
    saveDialog.mockResolvedValue('/docs/notes.pdf');
    fakeIpc.exportPdf.mockRejectedValueOnce('Failed to write PDF: permission denied');
    const { fireExport, lastToast } = await bootWithActiveDoc('/docs/notes.md');
    // Must not escalate into an unhandled rejection.
    fireExport();
    await vi.waitFor(() =>
      expect(lastToast()).toMatch(/Failed to write PDF: permission denied/),
    );
  });

  it('export-pdf with no active document shows a no-doc toast and never opens the dialog', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    fakeIpc.getActiveTabId.mockResolvedValue(null);
    fakeIpc.listOpenDocuments.mockResolvedValue([]);
    const { main } = await import('../src/main');
    await main();
    let toastMessage: string | undefined;
    document.addEventListener('mdviewer:toast', (ev: Event) => {
      toastMessage = (ev as CustomEvent<{ message: string }>).detail?.message;
    });
    document.dispatchEvent(new CustomEvent('mdviewer:export-pdf'));
    await vi.waitFor(() => expect(toastMessage).toBe('No document to print'));
    expect(saveDialog).not.toHaveBeenCalled();
    expect(fakeIpc.exportPdf).not.toHaveBeenCalled();
  });

  it('throws if the #app element is missing', async () => {
    resetDom(false);
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await expect(main()).rejects.toThrow(/#app element missing/);
  });
});

describe('main() — C2 window-addressed routing', () => {
  beforeEach(() => {
    resetDom(true);
    localStorage.removeItem('mdviewer.theme');
    Object.values(fakeIpc).forEach((m) => (m as any).mockClear?.());
    fakeIpc.listOpenDocuments.mockResolvedValue([]);
    fakeIpc.listRecents.mockResolvedValue([]);
    fakeIpc.getSettings.mockResolvedValue(settingsWith());
    currentWindow.label = 'main';
    currentWindow.listeners = {};
    currentWindow.listen.mockClear();
    rawInvoke.mockClear();
  });

  // The addressed-event subscriptions live in a fire-and-forget IIFE that
  // main() does not await (its `await import('@tauri-apps/api/window')` chain
  // resolves on later microtask turns). Poll until the last subscription
  // (`confirm-window-close`) has registered so assertions don't race the
  // IIFE.
  async function waitForAddressedListeners(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if ((currentWindow.listeners['confirm-window-close'] ?? []).length > 0) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it('resolves getCurrentWindow().label and subscribes to this window’s addressed events at boot', async () => {
    currentWindow.label = 'win-42';
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    await waitForAddressedListeners();
    // Subscriptions use the window-scoped `getCurrentWindow().listen`, NOT
    // the broadcast global `listen` — every addressed event the design lists
    // (04-window-addressed-events) is registered against THIS window.
    const subscribed = currentWindow.listen.mock.calls.map((c) => c[0]);
    expect(subscribed).toContain('workspace-changed');
    expect(subscribed).toContain('show-conflict');
    expect(subscribed).toContain('external-change');
    expect(subscribed).toContain('confirm-window-close');
  });

  it('mdviewer:new-window invokes the new_window command via a raw invoke', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    document.dispatchEvent(new CustomEvent('mdviewer:new-window'));
    // Let the fire-and-forget handler's microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(rawInvoke).toHaveBeenCalledWith('new_window');
  });

  it('confirm-window-close runs the save-or-discard confirm and invokes close_window to proceed', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    // The dirty-tab guard's confirm uses window.confirm; accept (save & close).
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const { main } = await import('../src/main');
      await main();
      await waitForAddressedListeners();
      const cbs = currentWindow.listeners['confirm-window-close'] ?? [];
      expect(cbs.length).toBeGreaterThan(0);
      cbs[0]({ payload: null });
      // Drain the async confirm/close chain.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // The save flush is dispatched and then the backend close is driven
      // via the close_window command so the prevented close can proceed.
      expect(rawInvoke).toHaveBeenCalledWith('close_window');
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('confirm-window-close cancel keeps the window open (does NOT invoke close_window)', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const { main } = await import('../src/main');
      await main();
      await waitForAddressedListeners();
      const cbs = currentWindow.listeners['confirm-window-close'] ?? [];
      cbs[0]({ payload: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(rawInvoke).not.toHaveBeenCalledWith('close_window');
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('workspace-changed addressed event triggers a window-scoped refresh', async () => {
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    await waitForAddressedListeners();
    fakeIpc.listOpenDocuments.mockClear();
    const cbs = currentWindow.listeners['workspace-changed'] ?? [];
    expect(cbs.length).toBeGreaterThan(0);
    cbs[0]({ payload: null });
    await Promise.resolve();
    await Promise.resolve();
    // refresh() re-fetches this window's own tab list via list_open_documents.
    expect(fakeIpc.listOpenDocuments).toHaveBeenCalled();
  });
});

describe('Open from Drive menu action', () => {
  beforeEach(() => {
    resetDom(true);
    Object.values(fakeIpc).forEach((m) => (m as any).mockClear?.());
    fakeIpc.listOpenDocuments.mockResolvedValue([]);
    fakeIpc.listRecents.mockResolvedValue([]);
  });

  async function waitForModal(): Promise<void> {
    // The handler imports the view dynamically (`await import('./views/OpenFromDrive')`),
    // which resolves on a microtask but only after vite's module loader
    // walks the dep graph. A single setTimeout(0) wasn't always enough on
    // first-import cold runs — pre-warm the module so the dynamic import
    // is cache-hit and a single tick suffices. We pre-import here (not in
    // beforeEach) so the cache survives across both menu-route tests.
    await import('../src/views/OpenFromDrive');
    for (let i = 0; i < 10; i++) {
      if (document.querySelector('.drive-modal')) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it('mounts the OpenFromDrive modal when mdviewer:open-from-drive fires', async () => {
    // The menu bridge translates the native `open-from-drive` menu id into
    // the `mdviewer:open-from-drive` CustomEvent. main.ts owns the listener
    // that mounts the modal — same indirection as `mdviewer:open-settings`.
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    document.dispatchEvent(new CustomEvent('mdviewer:open-from-drive'));
    await waitForModal();
    expect(document.querySelector('.drive-modal')).toBeTruthy();
  });

  it('routes the open-from-drive menu-bridge action to the modal', async () => {
    // The menu bridge is the public route the OS menu uses; verify the
    // string `open-from-drive` reaches the same modal as the CustomEvent.
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    const { dispatchMenuAction } = await import('../src/menuBridge');
    expect(dispatchMenuAction('open-from-drive')).toBe('mdviewer:open-from-drive');
    await waitForModal();
    expect(document.querySelector('.drive-modal')).toBeTruthy();
  });
});
