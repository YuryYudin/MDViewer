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
    },
    comments: {
      auto_merge: 'ask',
      reattachment_confidence: 0.85,
      sidecar_pattern: '{name}.comments.json',
      show_resolved: true,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: {},
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
    const mq = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
      matches: q.includes('dark'),
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
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
      mq.mockRestore();
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
      { key: 's', event: 'mdviewer:save-active' },
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

describe('Open from Drive menu action', () => {
  beforeEach(() => {
    resetDom(true);
    Object.values(fakeIpc).forEach((m) => (m as any).mockClear?.());
    fakeIpc.listOpenDocuments.mockResolvedValue([]);
    fakeIpc.listRecents.mockResolvedValue([]);
  });

  it('mounts the OpenFromDrive modal when mdviewer:open-from-drive fires', async () => {
    // The menu bridge translates the native `open-from-drive` menu id into
    // the `mdviewer:open-from-drive` CustomEvent. main.ts owns the listener
    // that mounts the modal — same indirection as `mdviewer:open-settings`.
    fakeIpc.getSettings.mockResolvedValueOnce(settingsWith());
    const { main } = await import('../src/main');
    await main();
    document.dispatchEvent(new CustomEvent('mdviewer:open-from-drive'));
    // The handler imports the view dynamically so the modal mounts on the
    // next tick — wait for any pending microtasks.
    await new Promise((r) => setTimeout(r, 0));
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
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector('.drive-modal')).toBeTruthy();
  });
});
