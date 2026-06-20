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
      render_line_breaks: true,
    },
    comments: {
      auto_merge: 'ask',
      reattachment_confidence: 0.85,
      sidecar_pattern: '{name}.comments.json',
      show_resolved: true,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts,
    onboarding: { cli_install_prompt_seen_for: '' },
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

describe('canonicalFromEvent shifted-symbol fold', () => {
  // On a US Mac keyboard the user physically presses `Cmd+Shift+=` (because
  // `+` lives on the same key as `=`); the raw KeyboardEvent is
  // `{shiftKey: true, key: "+"}`. Without the fold this canonicalizes to
  // `mod+shift++` and never matches the `Mod+=` binding. The fold rewrites
  // the key to its unshifted partner AND drops the `shift` token so the
  // user's Mod+= binding matches both physical keypresses.
  it('plain Cmd+= (unshifted) canonicalizes to mod+=', () => {
    const ev = new KeyboardEvent('keydown', { metaKey: true, key: '=' });
    expect(canonicalFromEvent(ev)).toBe(canonical('Mod+='));
  });

  it('Cmd+Shift+= (shifted physical "+") folds to mod+= matching Mod+=', () => {
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: '+' });
    expect(canonicalFromEvent(ev)).toBe(canonical('Mod+='));
  });

  it('Cmd+Shift+- (shifted physical "_") folds to mod+- matching Mod+-', () => {
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: '_' });
    expect(canonicalFromEvent(ev)).toBe(canonical('Mod+-'));
  });

  it('Cmd+Shift+0 (shifted physical ")") folds to mod+0 matching Mod+0', () => {
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: ')' });
    expect(canonicalFromEvent(ev)).toBe(canonical('Mod+0'));
  });

  it('folds the full top-row shifted symbol set to their unshifted partners', () => {
    // Each pair: shifted key the user physically produces -> unshifted key
    // that the binding string carries. The fold must handle every entry.
    const pairs: Array<[string, string]> = [
      ['+', '='],
      ['_', '-'],
      [')', '0'],
      ['(', '9'],
      ['*', '8'],
      ['&', '7'],
      ['^', '6'],
      ['%', '5'],
      ['$', '4'],
      ['#', '3'],
      ['@', '2'],
      ['!', '1'],
      ['~', '`'],
      ['}', ']'],
      ['{', '['],
      [':', ';'],
      ['"', "'"],
      ['<', ','],
      ['>', '.'],
      ['?', '/'],
      ['|', '\\'],
    ];
    for (const [shifted, unshifted] of pairs) {
      const ev = new KeyboardEvent('keydown', {
        metaKey: true,
        shiftKey: true,
        key: shifted,
      });
      // The bind string would be e.g. "Mod+=" — folded form drops shift.
      expect(canonicalFromEvent(ev)).toBe(canonical(`Mod+${unshifted}`));
    }
  });

  it('does NOT fold letter keys: Mod+Shift+A stays distinct from Mod+A', () => {
    // Only the top-row symbol set is folded — folding letters would break
    // bindings like Mod+Shift+M (resolve_thread, etc.).
    const shifted = new KeyboardEvent('keydown', {
      metaKey: true,
      shiftKey: true,
      key: 'A',
    });
    const unshifted = new KeyboardEvent('keydown', { metaKey: true, key: 'a' });
    expect(canonicalFromEvent(shifted)).not.toBe(canonicalFromEvent(unshifted));
    expect(canonicalFromEvent(shifted)).toBe(canonical('Mod+Shift+A'));
  });
});

describe('installKeymap font-zoom shortcuts', () => {
  // The keymap fans out into dispatchAction on a match — for the keymap's
  // own concern we only need to verify the action dispatch hits the new
  // Action variants on the shifted-physical and unshifted forms.
  it('Cmd+Shift+= dispatches font_increase (matches Mod+= via shifted-symbol fold)', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(
      settingsWith({ font_increase: 'Mod+=' }),
      handler,
    );
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: '+' });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('font_increase');
    uninstall();
  });

  it('Cmd+= (unshifted) also dispatches font_increase', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(
      settingsWith({ font_increase: 'Mod+=' }),
      handler,
    );
    const ev = new KeyboardEvent('keydown', { metaKey: true, key: '=' });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('font_increase');
    uninstall();
  });

  it('Cmd+Shift+_ dispatches font_decrease (matches Mod+-)', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(
      settingsWith({ font_decrease: 'Mod+-' }),
      handler,
    );
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: '_' });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('font_decrease');
    uninstall();
  });

  it('Cmd+- (unshifted) also dispatches font_decrease', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(
      settingsWith({ font_decrease: 'Mod+-' }),
      handler,
    );
    const ev = new KeyboardEvent('keydown', { metaKey: true, key: '-' });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('font_decrease');
    uninstall();
  });

  it('Cmd+Shift+) dispatches font_reset (matches Mod+0)', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(
      settingsWith({ font_reset: 'Mod+0' }),
      handler,
    );
    const ev = new KeyboardEvent('keydown', { metaKey: true, shiftKey: true, key: ')' });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('font_reset');
    uninstall();
  });

  it('Cmd+0 (unshifted) also dispatches font_reset', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(
      settingsWith({ font_reset: 'Mod+0' }),
      handler,
    );
    const ev = new KeyboardEvent('keydown', { metaKey: true, key: '0' });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('font_reset');
    uninstall();
  });
});

describe('installKeymap print shortcut', () => {
  // B1: `print` is a keymap Action with a `Mod+P` default. Pressing
  // Cmd/Ctrl+P must dispatch the `print` action so main.ts's dispatchAction
  // can fan it out to the `mdviewer:print` listener.
  it('Cmd+P dispatches the print action (Mod+P default)', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ print: 'Mod+P' }), handler);
    const ev = new KeyboardEvent('keydown', { key: 'p', metaKey: true });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('print');
    uninstall();
  });

  it('Ctrl+P also dispatches print (canonicalizes to mod)', () => {
    const handler = vi.fn();
    const uninstall = installKeymap(settingsWith({ print: 'Mod+P' }), handler);
    const ev = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true });
    window.dispatchEvent(ev);
    expect(handler).toHaveBeenCalledWith('print');
    uninstall();
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
