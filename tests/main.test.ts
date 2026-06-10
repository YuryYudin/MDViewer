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
    fakeIpc.listRecents.mockResolvedValue([]);
    currentWindow.label = 'main';
    currentWindow.listeners = {};
    currentWindow.listen.mockClear();
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
