import { describe, it, expect, vi } from 'vitest';
import { installKeymap, canonical, canonicalFromEvent } from '../src/keymap';
import type { Settings } from '../src/ipc';

function settingsWith(shortcuts: Record<string, string>): Settings {
  return {
    profile: { user_id: 'u', display_name: 'X', color: '#fff' },
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
    shortcuts,
  };
}

describe('keymap canonicalization', () => {
  it('normalizes Mod+Shift+M into the same form as a KeyboardEvent', () => {
    const a = canonical('Mod+Shift+M');
    const ev = new KeyboardEvent('keydown', { key: 'M', metaKey: true, shiftKey: true });
    expect(canonicalFromEvent(ev)).toBe(a);
  });

  it('treats CmdOrCtrl, Cmd, Ctrl, Meta as the same canonical "mod"', () => {
    expect(canonical('CmdOrCtrl+O')).toBe(canonical('Cmd+O'));
    expect(canonical('CmdOrCtrl+O')).toBe(canonical('Ctrl+O'));
    expect(canonical('CmdOrCtrl+O')).toBe(canonical('Meta+O'));
  });

  it('is order-insensitive', () => {
    expect(canonical('Mod+Shift+M')).toBe(canonical('Shift+Mod+M'));
  });
});

describe('installKeymap', () => {
  it('dispatches an action when its bound combo is pressed', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ open_file: 'CmdOrCtrl+O' }), handler);
    const ev = new KeyboardEvent('keydown', { key: 'o', metaKey: true });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('open_file');
    uninstall();
  });

  it('does not dispatch on unknown combos', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ open_file: 'CmdOrCtrl+O' }), handler);
    const ev = new KeyboardEvent('keydown', { key: 'q', metaKey: true });
    window.dispatchEvent(ev);
    expect(handler).not.toHaveBeenCalled();
    uninstall();
  });

  it('returned cleanup function detaches the listener', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ open_file: 'CmdOrCtrl+O' }), handler);
    uninstall();
    const ev = new KeyboardEvent('keydown', { key: 'o', metaKey: true });
    window.dispatchEvent(ev);
    expect(handler).not.toHaveBeenCalled();
  });

  it('preventDefault is called on a matched combo', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ open_file: 'CmdOrCtrl+O' }), handler);
    const ev = new KeyboardEvent('keydown', { key: 'o', metaKey: true, cancelable: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    window.dispatchEvent(ev);
    expect(spy).toHaveBeenCalled();
    uninstall();
  });

  it('Ctrl variant fires too because it canonicalizes to mod', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ save_file: 'CmdOrCtrl+S' }), handler);
    const ev = new KeyboardEvent('keydown', { key: 's', ctrlKey: true });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('save_file');
    uninstall();
  });
});
