import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountSettings } from '../../src/views/Settings';
import type { Settings } from '../../src/ipc';

function defaultSettings(): Settings {
  return {
    profile: { user_id: 'u1', display_name: 'Carol', color: '#00aa88' },
    appearance: { theme: 'light', font_size_px: 14, line_height: 150, density: 'comfortable' },
    editor: {
      default_open_mode: 'view',
      auto_save: true,
      auto_save_debounce_ms: 750,
      external_change_behavior: 'ask',
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
    },
    comments: {
      auto_merge: 'always',
      reattachment_confidence: 75,
      sidecar_pattern: '{name}.md.comments.json',
      show_resolved: false,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: { open_file: 'CmdOrCtrl+O', save_file: 'CmdOrCtrl+S' },
  };
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

    const mode = root.querySelector<HTMLSelectElement>('[data-test="default-open-mode"]')!;
    mode.value = 'edit';
    mode.dispatchEvent(new Event('change'));
    await flush();
    expect(ipc.setSettings.mock.calls.at(-1)![0].editor.default_open_mode).toBe('edit');

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
