import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Tauri core invoke so the Drive section's module-level wrappers
// (driveConnect / driveDisconnect / driveStatus) round-trip against a stub
// instead of throwing in jsdom. The mock is hoisted before the imports below
// so `mountSettings → mountDriveSettings → driveConnect` resolves cleanly.
const driveInvoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => driveInvoke(...args),
}));

import { mountSettings } from '../../src/views/Settings';
import type { Settings } from '../../src/ipc';

function defaultSettings(): Settings {
  return {
    profile: { user_id: 'u1', display_name: 'Carol', color: '#00aa88' },
    appearance: { theme: 'light', font_size_px: 14, line_height: 150, density: 'comfortable', startup_mode: 'clean', dark_variant: 'pure' },
    editor: {
      default_open_mode: 'render',
      auto_save: true,
      auto_save_debounce_ms: 750,
      external_change_behavior: 'ask',
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
      // A.9: Phase-1 read-only toggle on the render surface. Fresh
      // installs see `false` (editable render is the new default).
      render_readonly: false,
    },
    comments: {
      auto_merge: 'always',
      reattachment_confidence: 75,
      sidecar_pattern: '{name}.md.comments.json',
      show_resolved: false,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: { open_file: 'CmdOrCtrl+O', save_file: 'CmdOrCtrl+S' },
    // C5 baseline: feature_enabled = true matches the new Phase-3
    // production default. Tests that exercise the kill-switch path
    // (the user-facing opt-out) override it back to `false` explicitly.
    cloud: {
      drive: {
        feature_enabled: true,
        connected: false,
        account_email: null,
        backend_mode: 'auto',
        poll_interval_active_secs: 5n,
        poll_interval_unfocused_secs: 10n,
        custom_oauth_client_id: null,
        detect_toast_suppressed: false,
      },
    },
    onboarding: { cli_install_prompt_seen_for: '' },
  };
}

function settingsWithDrive(overrides: Partial<Settings['cloud']['drive']> = {}): Settings {
  const s = defaultSettings();
  s.cloud = {
    drive: {
      feature_enabled: true,
      connected: false,
      account_email: null,
      backend_mode: 'auto',
      poll_interval_active_secs: 5n,
      poll_interval_unfocused_secs: 30n,
      custom_oauth_client_id: null,
      detect_toast_suppressed: false,
      ...overrides,
    },
  };
  return s;
}

function makeIpc(overrides: Partial<Record<string, any>> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue(defaultSettings()),
    setSettings: vi.fn().mockResolvedValue(undefined),
    appInfo: vi.fn().mockResolvedValue({ version: '0.1.0', commit_hash: 'abc1234' }),
    openDocument: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    listOpenDocuments: vi.fn(),
    listRecents: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Settings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.classList.remove('theme-dark');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all 7 sections', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    for (const s of ['profile', 'appearance', 'editor', 'comments', 'shortcuts', 'advanced', 'about']) {
      expect(root.querySelector(`[data-section="${s}"]`)).toBeTruthy();
    }
  });

  it('seeds profile inputs from settings', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const name = root.querySelector<HTMLInputElement>('[data-test="profile-name"]')!;
    const color = root.querySelector<HTMLInputElement>('[data-test="profile-color"]')!;
    expect(name.value).toBe('Carol');
    expect(color.value).toBe('#00aa88');
  });

  it('debounces profile name input and persists merged settings', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const name = root.querySelector<HTMLInputElement>('[data-test="profile-name"]')!;
    name.value = 'Dave';
    name.dispatchEvent(new Event('input'));
    expect(ipc.setSettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    await flush();
    expect(ipc.setSettings).toHaveBeenCalledTimes(1);
    const saved = ipc.setSettings.mock.calls[0][0];
    expect(saved.profile.display_name).toBe('Dave');
    // Whole-snapshot pattern: every other field is preserved.
    expect(saved.appearance.theme).toBe('light');
    expect(saved.editor.auto_save).toBe(true);
  });

  it('switching theme to Dark applies body class immediately and saves', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const select = root.querySelector<HTMLSelectElement>('[data-test="theme-select"]')!;
    select.value = 'dark';
    select.dispatchEvent(new Event('change'));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    await flush();
    expect(ipc.setSettings).toHaveBeenCalled();
    const saved = ipc.setSettings.mock.calls[0][0];
    expect(saved.appearance.theme).toBe('dark');
  });

  it('switching theme to light removes the dark class', async () => {
    const root = document.createElement('div');
    const settings = defaultSettings();
    settings.appearance.theme = 'dark';
    document.body.classList.add('theme-dark');
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settings) });
    await mountSettings(root, ipc as any);
    const select = root.querySelector<HTMLSelectElement>('[data-test="theme-select"]')!;
    expect(select.value).toBe('dark');
    select.value = 'light';
    select.dispatchEvent(new Event('change'));
    expect(document.body.classList.contains('theme-dark')).toBe(false);
  });

  it('font size slider updates CSS var and saves on change', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const fs = root.querySelector<HTMLInputElement>('[data-test="font-size"]')!;
    fs.value = '18';
    fs.dispatchEvent(new Event('input'));
    expect(document.documentElement.style.getPropertyValue('--font-size')).toBe('18px');
    await flush();
    const saved = ipc.setSettings.mock.calls[0][0];
    expect(saved.appearance.font_size_px).toBe(18);
  });

  it('line height and density update settings', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const lh = root.querySelector<HTMLInputElement>('[data-test="line-height"]')!;
    lh.value = '175';
    lh.dispatchEvent(new Event('input'));
    await flush();
    const density = root.querySelector<HTMLSelectElement>('[data-test="density"]')!;
    density.value = 'compact';
    density.dispatchEvent(new Event('change'));
    await flush();
    const calls = ipc.setSettings.mock.calls;
    expect(calls[calls.length - 1][0].appearance.line_height).toBe(175);
    expect(calls[calls.length - 1][0].appearance.density).toBe('compact');
  });

  it('dark-variant dropdown defaults to "pure", persists changes, and toggles theme-cool on body', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    document.body.classList.remove('theme-cool');
    await mountSettings(root, ipc as any);
    const variant = root.querySelector<HTMLSelectElement>('[data-test="dark-variant"]')!;
    expect(variant).toBeTruthy();
    expect(variant.value).toBe('pure');
    expect(Array.from(variant.options).map((o) => o.value).sort()).toEqual(['cool', 'pure']);
    expect(document.body.classList.contains('theme-cool')).toBe(false);
    variant.value = 'cool';
    variant.dispatchEvent(new Event('change'));
    await flush();
    expect(document.body.classList.contains('theme-cool')).toBe(true);
    const calls = ipc.setSettings.mock.calls;
    expect(calls[calls.length - 1][0].appearance.dark_variant).toBe('cool');
    // Flipping back to pure clears the class.
    variant.value = 'pure';
    variant.dispatchEvent(new Event('change'));
    await flush();
    expect(document.body.classList.contains('theme-cool')).toBe(false);
  });

  it('startup-mode dropdown defaults to current setting and persists changes', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    // makeIpc seeds settings with startup_mode = 'clean' (the default).
    await mountSettings(root, ipc as any);
    const startup = root.querySelector<HTMLSelectElement>('[data-test="startup-mode"]')!;
    expect(startup).toBeTruthy();
    expect(startup.value).toBe('clean');
    // Both options must be present so the user can flip back.
    const options = Array.from(startup.options).map((o) => o.value).sort();
    expect(options).toEqual(['clean', 'restore']);
    // Switch to restore — the change handler writes settings via IPC.
    startup.value = 'restore';
    startup.dispatchEvent(new Event('change'));
    await flush();
    const calls = ipc.setSettings.mock.calls;
    expect(calls[calls.length - 1][0].appearance.startup_mode).toBe('restore');
  });

  it('editor section toggles persist auto_save and word_wrap', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const auto = root.querySelector<HTMLInputElement>('[data-test="auto-save"]')!;
    expect(auto.checked).toBe(true);
    auto.checked = false;
    auto.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls[0][0].editor.auto_save).toBe(false);

    const wrap = root.querySelector<HTMLInputElement>('[data-test="word-wrap"]')!;
    wrap.checked = false;
    wrap.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.word_wrap).toBe(false);
  });

  it('editor: default_open_mode + external_change_behavior + debounce', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);

    // A.3 (Phase-A correction): default_open_mode now lives in the
    // `{ "render" | "raw" }` space (post-WYSIWYG vocabulary). The
    // legacy `"view" / "edit"` values are accepted via the Rust-side
    // deserializer and rewritten in-memory; the writer always emits
    // the new values. The Vitest assertion mirrors the new space.
    const mode = root.querySelector<HTMLSelectElement>('[data-test="default-open-mode"]')!;
    mode.value = 'raw';
    mode.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.default_open_mode).toBe('raw');

    const ext = root.querySelector<HTMLSelectElement>('[data-test="external-change"]')!;
    ext.value = 'reload';
    ext.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.external_change_behavior).toBe('reload');

    const deb = root.querySelector<HTMLInputElement>('[data-test="auto-save-debounce"]')!;
    deb.value = '1500';
    deb.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.auto_save_debounce_ms).toBe(1500);
  });

  // A.3 (correction): the spec at e2e/specs/wysiwyg/render-raw-toggle.spec.ts
  // queries `browser.$('#render-readonly').isSelected()`. WebDriver's
  // `.isSelected()` resolves only against actual checkbox/radio/option
  // semantics on an element matched by a real CSS id selector. Both the
  // `id="render-readonly"` and the `type="checkbox"` are load-bearing.
  it('editor: render-readonly toggle is <input type="checkbox" id="render-readonly">', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const cb = root.querySelector<HTMLInputElement>('#render-readonly');
    expect(cb).not.toBeNull();
    expect(cb!.tagName).toBe('INPUT');
    expect(cb!.type).toBe('checkbox');
    // Seed defaults render_readonly = false (fresh-install default).
    expect(cb!.checked).toBe(false);
  });

  it('editor: render-readonly checkbox reflects render_readonly === true', async () => {
    const root = document.createElement('div');
    const settings = defaultSettings();
    settings.editor.render_readonly = true;
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settings) });
    await mountSettings(root, ipc as any);
    const cb = root.querySelector<HTMLInputElement>('#render-readonly');
    expect(cb).not.toBeNull();
    expect(cb!.checked).toBe(true);
  });

  // A.3 (correction): the spec at e2e/specs/wysiwyg/render-raw-toggle.spec.ts
  // queries `browser.$('[data-testid="default-mode-select"]').getValue()`.
  // WebDriver `.getValue()` only resolves to `.value` on <input>, <select>,
  // <textarea>. The render must be a real <select> element, not a custom
  // dropdown, with <option value="render"> and <option value="raw">.
  it('editor: default-mode surface is <select data-testid="default-mode-select"> with render/raw options', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const sel = root.querySelector<HTMLSelectElement>('[data-testid="default-mode-select"]');
    expect(sel).not.toBeNull();
    expect(sel!.tagName).toBe('SELECT');
    // Default seed = 'render'.
    expect(sel!.value).toBe('render');
    expect(Array.from(sel!.options).map((o) => o.value).sort()).toEqual(['raw', 'render']);
  });

  it('editor: default-mode select reflects render_readonly-migrated value (raw)', async () => {
    const root = document.createElement('div');
    const settings = defaultSettings();
    settings.editor.default_open_mode = 'raw';
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settings) });
    await mountSettings(root, ipc as any);
    const sel = root.querySelector<HTMLSelectElement>('[data-testid="default-mode-select"]');
    expect(sel).not.toBeNull();
    expect(sel!.value).toBe('raw');
  });

  // Migration coverage: the Rust deserializer rewrites a legacy
  // `default_open_mode = "view"` value to `"render"` in-memory (see the
  // doc comment on EditorSettings in types-generated.ts). By the time
  // Settings.ts reads from `getSettings()` the value is already migrated.
  // The <select>'s `.value` must therefore read 'render' (NOT 'view',
  // which is no longer an <option>). This test pins that Settings.ts
  // passes the migrated value straight through to the rendered DOM.
  it('editor: default-mode select shows "render" for a legacy migrated value', async () => {
    const root = document.createElement('div');
    const settings = defaultSettings();
    // Simulate the post-migration shape the IPC layer produces.
    // (Pre-migration the Rust side would have observed "view" and
    // rewritten it to "render" before the TS layer ever saw it.)
    settings.editor.default_open_mode = 'render';
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settings) });
    await mountSettings(root, ipc as any);
    const sel = root.querySelector<HTMLSelectElement>('[data-testid="default-mode-select"]');
    expect(sel!.value).toBe('render');
  });

  // A.9: render_readonly toggle ships in the Editor & Viewer card
  // bound to settings.editor.render_readonly. Description copy is
  // Phase-1 release-notes text — must match verbatim.
  it('editor: render_readonly toggle round-trips and shows the verbatim description', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const toggle = root.querySelector<HTMLInputElement>('[data-test="render-readonly"]')!;
    expect(toggle).toBeTruthy();
    expect(toggle.checked).toBe(false);

    // The row description string is part of the user-visible Phase-1
    // release-notes contract. Asserted verbatim so a paraphrase trips
    // the test.
    const row = toggle.closest('.row') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.textContent).toContain(
      'Render documents read-only. Toggle off to enable in-place editing.',
    );

    // Toggle on, persists with render_readonly = true.
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.render_readonly).toBe(true);

    // Toggle off, persists with render_readonly = false.
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.render_readonly).toBe(false);
  });

  it('editor: render_readonly toggle reflects initial setting value', async () => {
    const root = document.createElement('div');
    const settings = defaultSettings();
    settings.editor.render_readonly = true;
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settings) });
    await mountSettings(root, ipc as any);
    const toggle = root.querySelector<HTMLInputElement>('[data-test="render-readonly"]')!;
    expect(toggle.checked).toBe(true);
  });

  it('editor: syntax_highlighting / mermaid_enabled / show_whitespace toggles', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const sh = root.querySelector<HTMLInputElement>('[data-test="syntax-highlighting"]')!;
    sh.checked = false;
    sh.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.syntax_highlighting).toBe(false);

    const me = root.querySelector<HTMLInputElement>('[data-test="mermaid-enabled"]')!;
    me.checked = false;
    me.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.mermaid_enabled).toBe(false);

    const ws = root.querySelector<HTMLInputElement>('[data-test="show-whitespace"]')!;
    ws.checked = true;
    ws.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.show_whitespace).toBe(true);
  });

  it('comments section: show_resolved + sidecar_pattern + reattachment_confidence + auto_merge', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);

    const sr = root.querySelector<HTMLInputElement>('[data-test="show-resolved"]')!;
    sr.checked = true;
    sr.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].comments.show_resolved).toBe(true);

    const sp = root.querySelector<HTMLInputElement>('[data-test="sidecar-pattern"]')!;
    sp.value = '{name}.notes.json';
    sp.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(260);
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].comments.sidecar_pattern).toBe('{name}.notes.json');

    const rc = root.querySelector<HTMLInputElement>('[data-test="reattachment-confidence"]')!;
    rc.value = '90';
    rc.dispatchEvent(new Event('input'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].comments.reattachment_confidence).toBe(90);

    const am = root.querySelector<HTMLSelectElement>('[data-test="auto-merge"]')!;
    am.value = 'manual';
    am.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].comments.auto_merge).toBe('manual');
  });

  it('renders Sync provider as disabled with planned pill', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const sync = root.querySelector<HTMLSelectElement>('[data-test="sync-provider"]')!;
    expect(sync.disabled).toBe(true);
    const pill = root.querySelector('[data-test="sync-planned-pill"]');
    expect(pill).toBeTruthy();
    expect(pill!.textContent).toMatch(/planned/i);
  });

  it('shortcuts section renders read-only table from settings.shortcuts', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const section = root.querySelector('[data-section="shortcuts"]')!;
    expect(section.textContent).toContain('open_file');
    expect(section.textContent).toContain('CmdOrCtrl+O');
    expect(section.textContent).toContain('save_file');
    expect(section.textContent).toContain('CmdOrCtrl+S');
    // No edit inputs for shortcuts (non-goal in v1).
    expect(section.querySelectorAll('input').length).toBe(0);
  });

  it('verbose logs toggle persists via setSettings', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const cb = root.querySelector<HTMLInputElement>('[data-test="verbose-logs"]')!;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].advanced.verbose_logs).toBe(true);
  });

  it('Open DevTools button dispatches a custom event', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const handler = vi.fn();
    document.addEventListener('mdviewer:open-devtools', handler, { once: true });
    const btn = root.querySelector<HTMLButtonElement>('[data-test="open-devtools"]')!;
    btn.click();
    expect(handler).toHaveBeenCalled();
  });

  it('Reset to Defaults button dispatches a custom event', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const handler = vi.fn();
    document.addEventListener('mdviewer:reset-settings', handler, { once: true });
    const btn = root.querySelector<HTMLButtonElement>('[data-test="reset-defaults"]')!;
    btn.click();
    expect(handler).toHaveBeenCalled();
  });

  it('shows MDVIEWER version + commit hash in About section', async () => {
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const about = root.querySelector('[data-section="about"]')!;
    expect(about.textContent).toContain('0.1.0');
    expect(about.textContent).toContain('abc1234');
  });

  it('blur on profile name flushes pending changes immediately', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const name = root.querySelector<HTMLInputElement>('[data-test="profile-name"]')!;
    name.value = 'Eve';
    // Don't trigger 'input' (would start debounce). Just blur — should flush.
    name.dispatchEvent(new Event('blur'));
    await flush();
    expect(ipc.setSettings).toHaveBeenCalled();
    expect(ipc.setSettings.mock.calls.at(-1)![0].profile.display_name).toBe('Eve');
  });

  it('color change event flushes immediately', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const color = root.querySelector<HTMLInputElement>('[data-test="profile-color"]')!;
    color.value = '#ff00ff';
    color.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].profile.color).toBe('#ff00ff');
  });

  it('follow_system theme uses matchMedia when available', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation(
      () =>
        ({
          matches: true,
          media: '(prefers-color-scheme: dark)',
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
          onchange: null,
        }) as unknown as MediaQueryList,
    );
    await mountSettings(root, ipc as any);
    const select = root.querySelector<HTMLSelectElement>('[data-test="theme-select"]')!;
    select.value = 'follow_system';
    select.dispatchEvent(new Event('change'));
    expect(document.body.classList.contains('theme-dark')).toBe(true);
    expect(document.body.classList.contains('theme-follow-system')).toBe(true);
    mm.mockRestore();
  });

  it('falls back to default color when settings.color is empty', async () => {
    const root = document.createElement('div');
    const settings = defaultSettings();
    settings.profile.color = '';
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settings) });
    await mountSettings(root, ipc as any);
    const color = root.querySelector<HTMLInputElement>('[data-test="profile-color"]')!;
    expect(color.value).toBe('#888888');
  });

  it('debounce coalesces rapid input events into one save', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    await mountSettings(root, ipc as any);
    const name = root.querySelector<HTMLInputElement>('[data-test="profile-name"]')!;
    name.value = 'A';
    name.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(100);
    name.value = 'AB';
    name.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(100);
    name.value = 'ABC';
    name.dispatchEvent(new Event('input'));
    expect(ipc.setSettings).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    await flush();
    expect(ipc.setSettings).toHaveBeenCalledTimes(1);
    expect(ipc.setSettings.mock.calls[0][0].profile.display_name).toBe('ABC');
  });
});

describe('Drive section', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    driveInvoke.mockReset();
    driveInvoke.mockResolvedValue({
      connected: false,
      account_email: null,
      online: true,
      pending_count: 0,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the Drive section unconditionally under the Phase-3 default', async () => {
    // C5 removed the `if (settings.cloud?.drive?.feature_enabled)` guard
    // around mountDriveSettings — every fresh install lands on the new
    // `true` default and sees the Drive section. The frontend no longer
    // hides any UI based on the flag; the kill-switch lives in
    // src-tauri/src/main.rs (drive_connect / drive_open_url short-circuit
    // when the user has explicitly written `feature_enabled = false`).
    const root = document.createElement('div');
    await mountSettings(root, makeIpc() as any);
    const section = root.querySelector('[data-testid="drive-section"]');
    expect(section).toBeTruthy();
    expect(section!.textContent).toMatch(/Drive integration/i);
  });

  it('still renders the Drive section when the user has set feature_enabled=false (kill-switch is server-side)', async () => {
    // The kill-switch is a Rust-side guard on the IPC commands, not a
    // frontend gate. The Settings UI keeps the section visible so the
    // user can flip it back on / inspect Connect state, mirroring how
    // the Drive Settings group renders for connected and disconnected
    // accounts alike. The Connect button itself will surface the
    // kill-switch error from the IPC if the user clicks it.
    const root = document.createElement('div');
    const ipc = makeIpc({
      getSettings: vi
        .fn()
        .mockResolvedValue(settingsWithDrive({ feature_enabled: false })),
    });
    await mountSettings(root, ipc as any);
    expect(root.querySelector('[data-testid="drive-section"]')).toBeTruthy();
  });

  it('renders Connect button when not connected', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      getSettings: vi.fn().mockResolvedValue(settingsWithDrive({ connected: false })),
    });
    await mountSettings(root, ipc as any);
    expect(root.querySelector('[data-testid="drive-connect-btn"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="drive-disconnect-btn"]')).toBeFalsy();
    // The wireframe-01 "Not connected" copy is part of the contract.
    expect(root.querySelector('[data-testid="drive-section"]')!.textContent).toMatch(
      /Not connected/i,
    );
  });

  it('renders account chip and Disconnect when connected', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      getSettings: vi.fn().mockResolvedValue(
        settingsWithDrive({ connected: true, account_email: 'alice@example.com' }),
      ),
    });
    await mountSettings(root, ipc as any);
    const section = root.querySelector('[data-testid="drive-section"]')!;
    expect(section.textContent).toContain('alice@example.com');
    expect(root.querySelector('[data-testid="drive-disconnect-btn"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="drive-connect-btn"]')).toBeFalsy();
  });

  it('reveals the BYO client_id input under the Advanced toggle', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settingsWithDrive()) });
    await mountSettings(root, ipc as any);
    // The BYO field lives inside <details>; before opening, the field is in
    // the DOM but not visible. The test asserts that the toggle exists and
    // that opening it makes the field present.
    const advanced = root.querySelector<HTMLDetailsElement>('[data-testid="drive-advanced-toggle"]')!;
    expect(advanced).toBeTruthy();
    expect(advanced.tagName.toLowerCase()).toBe('details');
    expect(advanced.open).toBe(false);
    advanced.open = true;
    advanced.dispatchEvent(new Event('toggle'));
    expect(root.querySelector('[data-testid="drive-byo-client-id"]')).toBeTruthy();
  });

  it('Connect button calls drive_connect via IPC', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settingsWithDrive()) });
    await mountSettings(root, ipc as any);
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="drive-connect-btn"]')!;
    btn.click();
    // The driveConnect wrapper invokes 'drive_connect' with no args.
    await Promise.resolve();
    await Promise.resolve();
    expect(driveInvoke).toHaveBeenCalledWith('drive_connect');
  });

  it('Disconnect button calls drive_disconnect via IPC', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      getSettings: vi.fn().mockResolvedValue(
        settingsWithDrive({ connected: true, account_email: 'alice@example.com' }),
      ),
    });
    await mountSettings(root, ipc as any);
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="drive-disconnect-btn"]')!;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(driveInvoke).toHaveBeenCalledWith('drive_disconnect');
  });

  it('changing the BYO client_id input persists via setSettings', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({ getSettings: vi.fn().mockResolvedValue(settingsWithDrive()) });
    await mountSettings(root, ipc as any);
    const advanced = root.querySelector<HTMLDetailsElement>('[data-testid="drive-advanced-toggle"]')!;
    advanced.open = true;
    advanced.dispatchEvent(new Event('toggle'));
    const cid = root.querySelector<HTMLInputElement>('[data-testid="drive-byo-client-id"]')!;
    cid.value = '999.apps.googleusercontent.com';
    cid.dispatchEvent(new Event('input'));
    // Debounced — wait past the timer.
    vi.advanceTimersByTime(260);
    await Promise.resolve();
    await Promise.resolve();
    const calls = (ipc.setSettings as any).mock.calls;
    const last = calls[calls.length - 1][0] as Settings;
    expect(last.cloud.drive.custom_oauth_client_id).toBe('999.apps.googleusercontent.com');
  });

  it('clearing the BYO client_id input persists null (not an empty string)', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      getSettings: vi
        .fn()
        .mockResolvedValue(settingsWithDrive({ custom_oauth_client_id: 'old.apps.googleusercontent.com' })),
    });
    await mountSettings(root, ipc as any);
    const advanced = root.querySelector<HTMLDetailsElement>('[data-testid="drive-advanced-toggle"]')!;
    advanced.open = true;
    advanced.dispatchEvent(new Event('toggle'));
    const cid = root.querySelector<HTMLInputElement>('[data-testid="drive-byo-client-id"]')!;
    expect(cid.value).toBe('old.apps.googleusercontent.com');
    cid.value = '';
    cid.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(260);
    await Promise.resolve();
    await Promise.resolve();
    const calls = (ipc.setSettings as any).mock.calls;
    const last = calls[calls.length - 1][0] as Settings;
    expect(last.cloud.drive.custom_oauth_client_id).toBeNull();
  });
});

// Direct mountDriveSettings tests — exercise the catch-branch + notify path
// that the parent Settings.ts shell doesn't wire (it omits the optional
// notify hook). Without these the connect/disconnect failure branches
// remain uncovered (DriveSettings.ts:103-104 + 116-117).
describe('Drive section — connect/disconnect failure paths', () => {
  beforeEach(() => {
    driveInvoke.mockReset();
  });

  it('renders an error notify when driveDisconnect rejects', async () => {
    const root = document.createElement('div');
    const settings = settingsWithDrive({
      connected: true,
      account_email: 'alice@example.com',
    });
    driveInvoke.mockRejectedValueOnce(new Error('network down'));
    const notify = vi.fn();
    const { mountDriveSettings } = await import('../../src/views/DriveSettings');
    mountDriveSettings(root, settings, {
      saveSettings: vi.fn().mockResolvedValue(undefined),
      notify,
    });
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="drive-disconnect-btn"]')!;
    btn.click();
    // Two microtask flushes: one for the awaited driveDisconnect rejection,
    // one for the ensuing catch handler synchronous notify call.
    await Promise.resolve();
    await Promise.resolve();
    expect(driveInvoke).toHaveBeenCalledWith('drive_disconnect');
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to disconnect.*network down/),
      'error',
    );
  });

  it('renders an error notify when driveConnect rejects', async () => {
    const root = document.createElement('div');
    const settings = settingsWithDrive({ connected: false });
    driveInvoke.mockRejectedValueOnce(new Error('oauth denied'));
    const notify = vi.fn();
    const { mountDriveSettings } = await import('../../src/views/DriveSettings');
    mountDriveSettings(root, settings, {
      saveSettings: vi.fn().mockResolvedValue(undefined),
      notify,
    });
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="drive-connect-btn"]')!;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(driveInvoke).toHaveBeenCalledWith('drive_connect');
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to connect.*oauth denied/),
      'error',
    );
  });

  it('does not throw when driveDisconnect rejects with no notify hook supplied', async () => {
    // Defense against the optional-chaining branch (deps.notify?.) — the
    // failure path must still be silent-safe when the caller (today's
    // Settings.ts) omits the notify hook.
    const root = document.createElement('div');
    const settings = settingsWithDrive({ connected: true, account_email: 'a@b' });
    driveInvoke.mockRejectedValueOnce(new Error('boom'));
    const { mountDriveSettings } = await import('../../src/views/DriveSettings');
    mountDriveSettings(root, settings, {
      saveSettings: vi.fn().mockResolvedValue(undefined),
    });
    const btn = root.querySelector<HTMLButtonElement>('[data-testid="drive-disconnect-btn"]')!;
    expect(() => btn.click()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // No assertion needed beyond "did not throw". The aim is to cover the
    // `deps.notify?.()` short-circuit branch alongside the wired one above.
  });
});
