import { describe, it, expect, vi } from 'vitest';
import { mountProfileSetup } from '../../src/views/ProfileSetup';
import type { Settings } from '../../src/ipc';

function baseSettings(): Settings {
  return {
    profile: { user_id: 'u-1', display_name: '', color: '#888888' },
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
  };
}

describe('ProfileSetup', () => {
  it('renders name + color inputs and Save action', async () => {
    const root = document.createElement('div');
    const ipc: any = {
      getSettings: vi.fn().mockResolvedValue(baseSettings()),
      setSettings: vi.fn().mockResolvedValue(undefined),
    };
    await mountProfileSetup(root, ipc);
    expect(root.querySelector('[data-view="profile-setup"]')).toBeTruthy();
    expect(root.querySelector('[data-test="profile-name"]')).toBeTruthy();
    expect(root.querySelector('[data-test="profile-color"]')).toBeTruthy();
    expect(root.querySelector('[data-action="save-profile"]')).toBeTruthy();
  });

  it('persists name + color via setSettings on save', async () => {
    const root = document.createElement('div');
    const setSettings = vi.fn().mockResolvedValue(undefined);
    const ipc: any = { getSettings: vi.fn().mockResolvedValue(baseSettings()), setSettings };
    await mountProfileSetup(root, ipc);
    (root.querySelector('[data-test="profile-name"]') as HTMLInputElement).value = 'Carol';
    (root.querySelector('[data-test="profile-color"]') as HTMLInputElement).value = '#00aa88';
    (root.querySelector('[data-action="save-profile"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ display_name: 'Carol', color: '#00aa88' }),
      }),
    );
  });

  it('preserves other settings keys when saving', async () => {
    const root = document.createElement('div');
    const setSettings = vi.fn().mockResolvedValue(undefined);
    const settings = baseSettings();
    settings.appearance.font_size_px = 18;
    const ipc: any = { getSettings: vi.fn().mockResolvedValue(settings), setSettings };
    await mountProfileSetup(root, ipc);
    (root.querySelector('[data-test="profile-name"]') as HTMLInputElement).value = 'Dave';
    (root.querySelector('[data-action="save-profile"]') as HTMLButtonElement).click();
    await Promise.resolve();
    await Promise.resolve();
    const saved = setSettings.mock.calls[0][0];
    expect(saved.appearance.font_size_px).toBe(18);
    expect(saved.profile.display_name).toBe('Dave');
  });

  it('skip button dispatches mdviewer:profile-skipped without persisting', async () => {
    const root = document.createElement('div');
    const setSettings = vi.fn().mockResolvedValue(undefined);
    const ipc: any = { getSettings: vi.fn().mockResolvedValue(baseSettings()), setSettings };
    await mountProfileSetup(root, ipc);
    const handler = vi.fn();
    document.addEventListener('mdviewer:profile-skipped', handler, { once: true });
    (root.querySelector('[data-action="skip-profile"]') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalled();
    expect(setSettings).not.toHaveBeenCalled();
  });

  it('seeds inputs with existing profile values', async () => {
    const root = document.createElement('div');
    const settings = baseSettings();
    settings.profile.display_name = 'Existing';
    settings.profile.color = '#ff0000';
    const ipc: any = {
      getSettings: vi.fn().mockResolvedValue(settings),
      setSettings: vi.fn().mockResolvedValue(undefined),
    };
    await mountProfileSetup(root, ipc);
    expect((root.querySelector('[data-test="profile-name"]') as HTMLInputElement).value).toBe('Existing');
    expect((root.querySelector('[data-test="profile-color"]') as HTMLInputElement).value).toBe('#ff0000');
  });

  it('uses fallbacks when settings carries null name and empty color', async () => {
    const root = document.createElement('div');
    const settings = baseSettings();
    // Force the `??` and `||` fallback branches.
    (settings.profile as any).display_name = null;
    settings.profile.color = '';
    const ipc: any = {
      getSettings: vi.fn().mockResolvedValue(settings),
      setSettings: vi.fn().mockResolvedValue(undefined),
    };
    await mountProfileSetup(root, ipc);
    expect((root.querySelector('[data-test="profile-name"]') as HTMLInputElement).value).toBe('');
    // Color input falls back to the default '#888888'.
    expect((root.querySelector('[data-test="profile-color"]') as HTMLInputElement).value).toBe('#888888');
  });
});
