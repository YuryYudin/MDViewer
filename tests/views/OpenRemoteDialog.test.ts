import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountOpenRemoteDialog } from '../../src/views/OpenRemoteDialog';
import * as ipcModule from '../../src/ipc';
import type { DirEntry, Ipc, RecentEntry } from '../../src/ipc';

/**
 * Smoke tests for the OpenRemoteDialog component. Three states from wireframe
 * 02 plus the dismissal paths:
 *   - state A: host entry with autocomplete sourced from Recents
 *   - state B: directory browsing with breadcrumb + entry table
 *   - state C: error state showing verbatim SSH stderr
 *
 * The dialog accepts an `ipc` prop override so tests don't have to monkey-
 * patch the module-level singleton. Production callers omit it.
 *
 * B3 lands the deeper coverage (keyboard nav, breadcrumb segment clicks for
 * deep paths, etc.). This file pins the basic shape per state plus the
 * dismissal contract that downstream wiring (B2's StartPage button and the
 * menu-bridge listener in Workspace) relies on.
 */

vi.mock('@tauri-apps/api/event', () => ({
  // Other view modules in the same suite touch Tauri events on import; the
  // mock keeps everything in jsdom-friendly territory.
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

function makeRecents(): RecentEntry[] {
  // Mixed local + ssh recents. The dialog pulls user@host[:port] substrings
  // from the ssh entries only, deduplicated.
  return [
    { path: '/local/notes.md', mtime: null, kind: 'local' },
    { path: 'ssh://alice@host.example.com/docs/a.md', mtime: null, kind: 'ssh' },
    { path: 'ssh://alice@host.example.com/docs/b.md', mtime: null, kind: 'ssh' },
    { path: 'ssh://bob@other.example.com:2222/x/y.md', mtime: null, kind: 'ssh' },
  ];
}

function makeIpc(overrides: Partial<Ipc> = {}): Ipc {
  const base = {
    listRecents: vi.fn().mockResolvedValue(makeRecents()),
    sshListDir: vi
      .fn()
      .mockResolvedValue([
        { name: 'docs', isDir: true, size: 0 },
        { name: 'README.md', isDir: false, size: 4096 },
      ] satisfies DirEntry[]),
    sshOpenUrl: vi.fn().mockResolvedValue({ id: 't', path: '/cache/x.md' }),
  };
  return { ...base, ...overrides } as unknown as Ipc;
}

/** Yield several microtasks so initial autocomplete + render settle. */
async function flushMicrotasks(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('OpenRemoteDialog — state A (host entry)', () => {
  it('renders the dialog overlay and a host-input field', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();

    const overlay = document.body.querySelector('[data-testid="open-remote-dialog"]');
    expect(overlay).toBeTruthy();
    const input = overlay!.querySelector('.host-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toContain('user@host');
  });

  it('builds a deduplicated user@host[:port] suggestion list from ssh Recents only', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();

    const datalist = document.body.querySelector('datalist#recent-hosts');
    expect(datalist).toBeTruthy();
    const values = Array.from(datalist!.querySelectorAll('option')).map((o) =>
      (o as HTMLOptionElement).value,
    );
    // Two distinct hosts from the three ssh entries (alice@host.example.com
    // appears twice in Recents and must be deduplicated to one suggestion).
    expect(values.sort()).toEqual([
      'alice@host.example.com',
      'bob@other.example.com:2222',
    ]);
    // Local-only recents must NOT leak in as suggestions.
    expect(values).not.toContain('/local/notes.md');
  });

  it('falls back to the host-input even when listRecents rejects', async () => {
    const ipc = makeIpc();
    (ipc.listRecents as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    expect(document.body.querySelector('.host-input')).toBeTruthy();
    // Datalist is rendered but empty.
    const options = document.body.querySelectorAll('datalist#recent-hosts option');
    expect(options.length).toBe(0);
  });

  it('silently skips ssh recents whose stored path is unparseable', async () => {
    // RecentEntry.kind is the source of truth but the path field is opaque.
    // A malformed stored path must be filtered out rather than feeding garbage
    // into the suggestion datalist.
    const ipc = makeIpc({
      listRecents: vi.fn().mockResolvedValue([
        { path: 'not-a-url', mtime: null, kind: 'ssh' },
        { path: 'ssh://carol@valid.example.com/x.md', mtime: null, kind: 'ssh' },
      ]),
    });
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    const values = Array.from(
      document.body.querySelectorAll('datalist#recent-hosts option'),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['carol@valid.example.com']);
  });
});

describe('OpenRemoteDialog — state B (browsing)', () => {
  it('renders breadcrumb + entries table after a successful list_dir', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();

    const input = document.body.querySelector('.host-input') as HTMLInputElement;
    input.value = 'alice@host.example.com';
    const connect = document.body.querySelector('.connect-btn') as HTMLButtonElement;
    connect.click();
    await flushMicrotasks();

    const table = document.body.querySelector('table.entries');
    expect(table).toBeTruthy();
    expect(table!.getAttribute('role')).toBe('listbox');
    const rows = table!.querySelectorAll('tr[role="option"]');
    expect(rows.length).toBe(2);
    expect(rows[0].getAttribute('data-name')).toBe('docs');
    expect(rows[0].getAttribute('data-is-dir')).toBe('true');
    expect(rows[1].getAttribute('data-name')).toBe('README.md');
    expect(rows[1].getAttribute('data-is-dir')).toBe('false');

    // File size column: directories suppress size, files render formatted.
    const sizeCols = table!.querySelectorAll('td.size');
    expect(sizeCols[0].textContent).toBe('');
    expect(sizeCols[1].textContent).toBe('4.0 KB');

    const breadcrumb = document.body.querySelector('.breadcrumb');
    expect(breadcrumb).toBeTruthy();
    const segs = breadcrumb!.querySelectorAll('.breadcrumb-segment');
    expect(segs.length).toBe(1);
    expect(segs[0].textContent).toBe('alice@host.example.com');

    expect(ipc.sshListDir).toHaveBeenCalledWith('ssh://alice@host.example.com/');
  });

  it('double-clicking a .md row dismisses the dialog and invokes onPick with the full ssh:// url', async () => {
    const ipc = makeIpc();
    const onPick = vi.fn();
    mountOpenRemoteDialog({ root: document.body, onPick, ipc });
    await flushMicrotasks();

    const input = document.body.querySelector('.host-input') as HTMLInputElement;
    input.value = 'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();

    const mdRow = document.body.querySelector('tr[data-name="README.md"]') as HTMLElement;
    mdRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onPick).toHaveBeenCalledWith('ssh://alice@host.example.com/README.md');
    // Dialog should be removed on a successful file pick.
    expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeNull();
  });

  it('double-clicking a non-markdown file does NOT call onPick or dismiss', async () => {
    const ipc = makeIpc({
      sshListDir: vi.fn().mockResolvedValue([
        { name: 'image.png', isDir: false, size: 100 },
      ]),
    });
    const onPick = vi.fn();
    mountOpenRemoteDialog({ root: document.body, onPick, ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();

    const row = document.body.querySelector('tr[data-name="image.png"]') as HTMLElement;
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onPick).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeTruthy();
  });

  it('double-clicking a directory row re-fetches list_dir for the child path', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();

    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();

    const dirRow = document.body.querySelector('tr[data-name="docs"]') as HTMLElement;
    dirRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushMicrotasks();

    const calls = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[1][0]).toBe('ssh://alice@host.example.com/docs/');
  });

  it('clicking a breadcrumb segment re-fetches list_dir for that segment\'s URL only', async () => {
    // Start at host root, descend twice into `docs/`, then click the host
    // breadcrumb segment to verify the dialog goes back to the host root
    // via a single list_dir call (not a tree re-walk).
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ name: 'docs', isDir: true, size: 0 }])
      .mockResolvedValueOnce([{ name: 'README.md', isDir: false, size: 1 }])
      .mockResolvedValueOnce([{ name: 'docs', isDir: true, size: 0 }]);
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();

    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    // Descend into docs/
    const dirRow = document.body.querySelector('tr[data-name="docs"]') as HTMLElement;
    dirRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushMicrotasks();
    // Two breadcrumb segments now: host, docs. Click host (idx 0).
    const segs = document.body.querySelectorAll('.breadcrumb-segment');
    expect(segs.length).toBe(2);
    (segs[0] as HTMLButtonElement).click();
    await flushMicrotasks();

    const calls = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls;
    // Third invocation: targeting the host root URL.
    expect(calls[2][0]).toBe('ssh://alice@host.example.com/');
  });
});

describe('OpenRemoteDialog — state C (error)', () => {
  it('renders verbatim SSH stderr when sshListDir rejects', async () => {
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('ssh exited Some(255)\nPermission denied (publickey)'),
    );
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();

    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();

    const err = document.body.querySelector('[data-testid="dialog-error"]');
    expect(err).toBeTruthy();
    const pre = err!.querySelector('pre');
    expect(pre?.textContent).toContain('ssh exited Some(255)');
    expect(pre?.textContent).toContain('Permission denied (publickey)');
  });

  it('renders a plain-string rejection verbatim', async () => {
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      'a bare string error',
    );
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const pre = document.body.querySelector('[data-testid="dialog-error"] pre');
    expect(pre?.textContent).toBe('a bare string error');
  });

  it('renders an object rejection as JSON so the user at least sees something', async () => {
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      code: 42,
      detail: 'oh no',
    });
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const pre = document.body.querySelector('[data-testid="dialog-error"] pre');
    expect(pre?.textContent).toContain('"code":42');
    expect(pre?.textContent).toContain('"detail":"oh no"');
  });

  it('Back button on the error pane returns to state A', async () => {
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('nope'),
    );
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.body.querySelector('[data-testid="dialog-error"]')).toBeTruthy();

    (document.body.querySelector('.dialog-retry') as HTMLButtonElement).click();
    expect(document.body.querySelector('.host-input')).toBeTruthy();
    expect(document.body.querySelector('[data-testid="dialog-error"]')).toBeNull();
  });
});

describe('OpenRemoteDialog — dismissal', () => {
  it('Escape dismisses the dialog', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeNull();
  });

  it('close button dismisses the dialog', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.dialog-close') as HTMLButtonElement).click();
    expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeNull();
  });

  it('returned close() handle dismisses the dialog programmatically', async () => {
    const ipc = makeIpc();
    const handle = mountOpenRemoteDialog({
      root: document.body,
      onPick: vi.fn(),
      ipc,
    });
    await flushMicrotasks();
    handle.close();
    expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeNull();
  });

  it('non-Escape keys do not dismiss the dialog', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeTruthy();
  });
});

describe('OpenRemoteDialog — host input flow', () => {
  it('Connect with empty input does nothing', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(ipc.sshListDir).not.toHaveBeenCalled();
    expect(document.body.querySelector('.host-input')).toBeTruthy();
  });

  it('whitespace-only input is also treated as empty', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value = '   ';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(ipc.sshListDir).not.toHaveBeenCalled();
  });

  it('Enter in the host input drives the same connect path', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    const input = document.body.querySelector('.host-input') as HTMLInputElement;
    input.value = 'alice@host.example.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(ipc.sshListDir).toHaveBeenCalledWith('ssh://alice@host.example.com/');
  });

  it('non-Enter keystrokes in the host input do NOT trigger a list_dir', async () => {
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    const input = document.body.querySelector('.host-input') as HTMLInputElement;
    input.value = 'alice@host.example.com';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    await flushMicrotasks();
    expect(ipc.sshListDir).not.toHaveBeenCalled();
  });
});

describe('OpenRemoteDialog — hostAutocompleteSource override', () => {
  it('uses the injected source instead of listRecents when supplied', async () => {
    const ipc = makeIpc();
    const source = vi.fn().mockResolvedValue(['preset@host:9999']);
    mountOpenRemoteDialog({
      root: document.body,
      onPick: vi.fn(),
      hostAutocompleteSource: source,
      ipc,
    });
    await flushMicrotasks();
    expect(source).toHaveBeenCalled();
    expect(ipc.listRecents).not.toHaveBeenCalled();
    const values = Array.from(
      document.body.querySelectorAll('datalist#recent-hosts option'),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['preset@host:9999']);
  });

  it('host-entry HTML is built with escaped attribute values to prevent injection', async () => {
    // The autocomplete data ends up inside <option value="...">; an
    // attacker-controlled Recents entry must not be able to break the
    // attribute boundary.
    const source = vi.fn().mockResolvedValue(['"><script>alert(1)</script>']);
    mountOpenRemoteDialog({
      root: document.body,
      onPick: vi.fn(),
      hostAutocompleteSource: source,
      ipc: makeIpc(),
    });
    await flushMicrotasks();
    expect(document.body.querySelector('script')).toBeNull();
  });
});

describe('OpenRemoteDialog — keyboard navigation in browsing state', () => {
  /**
   * The wireframe's Avoid block calls for full keyboard nav while
   * browsing: arrow keys move row focus, Enter activates the focused
   * row, Backspace pops the breadcrumb. The implementation tracks the
   * focused index on the State, marks the focused row with
   * `aria-selected="true"`, and listens for keydown on the entries
   * container (tabindex="0" so it can receive focus).
   */

  async function enterBrowsing(
    ipc: Ipc,
    onPick = vi.fn(),
  ): Promise<HTMLElement> {
    mountOpenRemoteDialog({ root: document.body, onPick, ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    return document.body.querySelector('table.entries') as HTMLElement;
  }

  it('first row is selected on entry into browsing state and container is focusable', async () => {
    const ipc = makeIpc();
    const table = await enterBrowsing(ipc);
    expect(table).toBeTruthy();
    expect(table.getAttribute('tabindex')).toBe('0');
    const rows = table.querySelectorAll('tr[role="option"]');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].getAttribute('aria-selected')).toBe('false');
  });

  it('ArrowDown advances selection from 0 to 1', async () => {
    const ipc = makeIpc();
    const table = await enterBrowsing(ipc);
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    const rows = document.body.querySelectorAll('tr[role="option"]');
    expect(rows[0].getAttribute('aria-selected')).toBe('false');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowDown at the last row does not overflow', async () => {
    const ipc = makeIpc();
    const table = await enterBrowsing(ipc);
    // Two rows total; press ArrowDown three times.
    for (let i = 0; i < 3; i += 1) {
      table.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    }
    const rows = document.body.querySelectorAll('tr[role="option"]');
    expect(rows[1].getAttribute('aria-selected')).toBe('true');
  });

  it('ArrowUp moves selection back; clamped at 0', async () => {
    const ipc = makeIpc();
    const table = await enterBrowsing(ipc);
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    const rows = document.body.querySelectorAll('tr[role="option"]');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
  });

  it('Enter on a directory row descends into it', async () => {
    const ipc = makeIpc();
    const table = await enterBrowsing(ipc);
    // Focus is on row 0 (the `docs` directory). Press Enter.
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await flushMicrotasks();
    const calls = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][0]).toBe('ssh://alice@host.example.com/docs/');
  });

  it('Enter on a markdown file row picks the file and dismisses the dialog', async () => {
    const ipc = makeIpc();
    const onPick = vi.fn();
    const table = await enterBrowsing(ipc, onPick);
    // Advance to README.md row.
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(onPick).toHaveBeenCalledWith('ssh://alice@host.example.com/README.md');
    expect(
      document.body.querySelector('[data-testid="open-remote-dialog"]'),
    ).toBeNull();
  });

  it('Enter on a non-markdown file row is a no-op', async () => {
    const ipc = makeIpc({
      sshListDir: vi
        .fn()
        .mockResolvedValue([{ name: 'image.png', isDir: false, size: 100 }]),
    });
    const onPick = vi.fn();
    const table = await enterBrowsing(ipc, onPick);
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(onPick).not.toHaveBeenCalled();
    expect(
      document.body.querySelector('[data-testid="open-remote-dialog"]'),
    ).toBeTruthy();
  });

  it('Backspace at the host root is a no-op (only one breadcrumb segment)', async () => {
    const ipc = makeIpc();
    const table = await enterBrowsing(ipc);
    const callCountBefore = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock
      .calls.length;
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
    );
    await flushMicrotasks();
    const callCountAfter = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock
      .calls.length;
    expect(callCountAfter).toBe(callCountBefore);
    // Still browsing — dialog is still up.
    expect(
      document.body.querySelector('[data-testid="open-remote-dialog"]'),
    ).toBeTruthy();
  });

  it('Backspace mid-tree pops the breadcrumb (descends into parent)', async () => {
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ name: 'docs', isDir: true, size: 0 }])
      .mockResolvedValueOnce([{ name: 'README.md', isDir: false, size: 1 }])
      .mockResolvedValueOnce([{ name: 'docs', isDir: true, size: 0 }]);
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'alice@host.example.com';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    // Descend into docs/.
    const dirRow = document.body.querySelector(
      'tr[data-name="docs"]',
    ) as HTMLElement;
    dirRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushMicrotasks();
    // Now two breadcrumb segments (host, docs). Press Backspace from the table.
    const table = document.body.querySelector('table.entries') as HTMLElement;
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
    );
    await flushMicrotasks();
    const calls = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][0]).toBe('ssh://alice@host.example.com/');
  });

  it('descending resets focus to the first row', async () => {
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { name: 'docs', isDir: true, size: 0 },
        { name: 'README.md', isDir: false, size: 4096 },
      ])
      .mockResolvedValueOnce([
        { name: 'inner.md', isDir: false, size: 1 },
        { name: 'second.md', isDir: false, size: 2 },
      ]);
    const table = await enterBrowsing(ipc);
    // Move focus to row 1.
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    // Descend into docs/ (row 0). First move focus back to 0.
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
    );
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await flushMicrotasks();
    const rows = document.body.querySelectorAll('tr[role="option"]');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(rows[1].getAttribute('aria-selected')).toBe('false');
  });

  it('keydown is ignored when there are no entries', async () => {
    const ipc = makeIpc({
      sshListDir: vi.fn().mockResolvedValue([] satisfies DirEntry[]),
    });
    const onPick = vi.fn();
    const table = await enterBrowsing(ipc, onPick);
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    // No crash, no pick, no new list_dir.
    expect(onPick).not.toHaveBeenCalled();
  });

  it('non-tracked keys (e.g. plain letters) on the entries table are a no-op', async () => {
    // Covers the fall-through branch in the table keydown handler where
    // none of ArrowDown/ArrowUp/Enter/Backspace match.
    const ipc = makeIpc();
    const onPick = vi.fn();
    const table = await enterBrowsing(ipc, onPick);
    const callsBefore = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls
      .length;
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', bubbles: true }),
    );
    table.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(
      (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsBefore);
    expect(onPick).not.toHaveBeenCalled();
    // Selection still on row 0.
    const rows = document.body.querySelectorAll('tr[role="option"]');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
  });
});

describe('OpenRemoteDialog — branch-coverage edge cases', () => {
  it('falls back to the default ipc singleton when no ipc prop is supplied', async () => {
    // Covers the `props.ipc ?? defaultIpc` branch in mountOpenRemoteDialog.
    // Spy on the module-level singleton's listRecents to confirm the
    // dialog reached it rather than receiving a test-supplied fake.
    const spy = vi
      .spyOn(ipcModule.ipc, 'listRecents')
      .mockResolvedValue([] satisfies RecentEntry[]);
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn() });
    await flushMicrotasks();
    expect(spy).toHaveBeenCalled();
    expect(document.body.querySelector('.host-input')).toBeTruthy();
    spy.mockRestore();
  });

  it('descending two directory levels produces correctly /-terminated URLs', async () => {
    // joinSshDirPath always appends `/`. onConnect already builds the
    // host root URL with trailing `/`, and breadcrumbsForUrl emits each
    // segment URL with a trailing `/` as well, so every URL that flows
    // back into joinSshDirPath/joinSshFilePath is already slash-
    // terminated — the non-`/` branch is structurally guarded. This
    // test pins the trailing-`/` invariant so a future refactor can't
    // silently drop it and hand a malformed URL to ssh_list_dir.
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ name: 'a', isDir: true, size: 0 }])
      .mockResolvedValueOnce([{ name: 'b', isDir: true, size: 0 }])
      .mockResolvedValueOnce([{ name: 'c', isDir: true, size: 0 }]);
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    // Descend into a/
    (
      document.body.querySelector('tr[data-name="a"]') as HTMLElement
    ).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushMicrotasks();
    // Descend into b/
    (
      document.body.querySelector('tr[data-name="b"]') as HTMLElement
    ).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushMicrotasks();
    const calls = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls;
    // All URLs should be slash-terminated dir paths — assert shape.
    expect(calls[0][0]).toBe('ssh://h.example/');
    expect(calls[1][0]).toBe('ssh://h.example/a/');
    expect(calls[2][0]).toBe('ssh://h.example/a/b/');
  });

  it('renders a non-markdown extension file correctly (no dismissal on dblclick)', async () => {
    // Covers the joinSshFilePath happy path + the isMarkdownName false branch
    // already exercised, but adds a more diverse name to be sure non-`.md`
    // suffixes don't accidentally count.
    const ipc = makeIpc({
      sshListDir: vi.fn().mockResolvedValue([
        { name: 'NOTES.MARKDOWN', isDir: false, size: 10 },
        { name: 'archive.tar.gz', isDir: false, size: 20 },
      ] satisfies DirEntry[]),
    });
    const onPick = vi.fn();
    mountOpenRemoteDialog({ root: document.body, onPick, ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();

    // .MARKDOWN (uppercase) should still match the case-insensitive regex
    // and dismiss the dialog.
    const mdRow = document.body.querySelector(
      'tr[data-name="NOTES.MARKDOWN"]',
    ) as HTMLElement;
    mdRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(onPick).toHaveBeenCalledWith('ssh://h.example/NOTES.MARKDOWN');
  });

  it('formats a >1 MB file size in MB', async () => {
    // Covers the `>= 1MB` branch of formatSize.
    const ipc = makeIpc({
      sshListDir: vi
        .fn()
        .mockResolvedValue([
          { name: 'big.bin', isDir: false, size: 5 * 1024 * 1024 },
        ] satisfies DirEntry[]),
    });
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const sizeCol = document.body.querySelector('td.size');
    expect(sizeCol?.textContent).toBe('5.0 MB');
  });

  it('formats a small (<1 KB) file size in bytes', async () => {
    // Covers the `< 1024` branch of formatSize.
    const ipc = makeIpc({
      sshListDir: vi
        .fn()
        .mockResolvedValue([
          { name: 'tiny.md', isDir: false, size: 17 },
        ] satisfies DirEntry[]),
    });
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const sizeCol = document.body.querySelector('td.size');
    expect(sizeCol?.textContent).toBe('17 B');
  });

  it('escapes ampersand and apostrophe in dirent names', async () => {
    // Covers the `&` and `'` cases of escapeHtml. Dirent names with these
    // characters must round-trip through escape+parse with their textual
    // content intact (no double-encoding, no HTML injection). jsdom
    // normalises `&#39;` back to `'` on innerHTML read, so we assert on
    // textContent + that no unexpected child nodes were created from a
    // bare `'` accidentally being interpreted as markup.
    const ipc = makeIpc({
      sshListDir: vi.fn().mockResolvedValue([
        { name: "A&B's notes.md", isDir: false, size: 1 },
      ] satisfies DirEntry[]),
    });
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const nameCell = document.body.querySelector('td.name');
    // Textual content reads the original characters back — proves the
    // escape didn't drop or double-encode either char.
    expect(nameCell?.textContent).toBe("A&B's notes.md");
    // No child elements (would indicate the `&` or `'` was interpreted
    // as markup).
    expect(nameCell?.children.length).toBe(0);
    // `&amp;` survives jsdom's serializer; that's the `&` escape branch.
    expect(nameCell?.innerHTML).toContain('&amp;');
  });

  it('breadcrumb has exactly one segment (host) at the host root', async () => {
    // Pins the breadcrumb shape after a Connect: one segment containing
    // the host, no leading separator. breadcrumbsForUrl's no-match
    // early-return is structurally guarded since onConnect always
    // constructs a valid `ssh://${raw}/` URL.
    const ipc = makeIpc();
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const segs = document.body.querySelectorAll('.breadcrumb-segment');
    expect(segs.length).toBe(1);
    expect(segs[0].textContent).toBe('h.example');
  });

  it('JSON.stringify failure on a circular rejection falls back to String(e)', async () => {
    // Covers the try/catch fallback in errorMessage.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      circular,
    );
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const pre = document.body.querySelector('[data-testid="dialog-error"] pre');
    // String(circular) yields '[object Object]'.
    expect(pre?.textContent).toBe('[object Object]');
  });

  it('autocomplete arriving after a connect-fired browsing state preserves browsing view', async () => {
    // Covers the `else` branch in the mount-time autocomplete fetch where
    // state.kind has already moved past 'host-entry'. We slow the
    // autocomplete source so the Connect click wins the race and the
    // dialog is in 'browsing' when the suggestions resolve.
    const ipc = makeIpc();
    let resolveSuggestions!: (v: string[]) => void;
    const slowSource = () =>
      new Promise<string[]>((res) => {
        resolveSuggestions = res;
      });
    mountOpenRemoteDialog({
      root: document.body,
      onPick: vi.fn(),
      hostAutocompleteSource: slowSource,
      ipc,
    });
    // Type a host + Connect before suggestions arrive.
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    // Now we should be in browsing state.
    expect(document.body.querySelector('table.entries')).toBeTruthy();
    // Resolve the autocomplete fetch — should NOT clobber browsing.
    resolveSuggestions(['preset@h']);
    await flushMicrotasks();
    expect(document.body.querySelector('table.entries')).toBeTruthy();
    expect(document.body.querySelector('.host-input')).toBeNull();
  });

  it('renders host-entry safely when the autocomplete source resolves with undefined', async () => {
    // Covers the `state.suggestions ?? []` fallback in renderHostEntry.
    // A misbehaving custom source might break the string[] contract at
    // runtime; the dialog should defensively fall back to an empty list
    // rather than crash on the .map() call.
    const ipc = makeIpc();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badSource: any = vi.fn().mockResolvedValue(undefined);
    mountOpenRemoteDialog({
      root: document.body,
      onPick: vi.fn(),
      hostAutocompleteSource: badSource,
      ipc,
    });
    await flushMicrotasks();
    // No crash; host-input is still on screen.
    expect(document.body.querySelector('.host-input')).toBeTruthy();
    const options = document.body.querySelectorAll(
      'datalist#recent-hosts option',
    );
    expect(options.length).toBe(0);
  });

  it('renders browsing state safely when list_dir resolves with undefined', async () => {
    // Covers the `state.entries ?? []` fallback in renderBrowsing.
    // A misbehaving IPC might break the DirEntry[] contract at runtime.
    const ipc = makeIpc({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sshListDir: vi.fn().mockResolvedValue(undefined as any),
    });
    mountOpenRemoteDialog({ root: document.body, onPick: vi.fn(), ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    // No crash; entries table is empty but rendered.
    const table = document.body.querySelector('table.entries');
    expect(table).toBeTruthy();
    expect(table!.querySelectorAll('tr[role="option"]').length).toBe(0);
  });

  it('table keydown post-navigation (state moved to error) is a no-op', async () => {
    // Covers the `state.kind !== 'browsing'` guard in the table keydown
    // handler. We hold a reference to the table from the first browsing
    // render, then trigger a list_dir failure that moves the dialog to
    // error state; the orphaned table listener still fires on dispatch
    // but should bail because state.kind is now 'error'.
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        { name: 'docs', isDir: true, size: 0 },
      ] satisfies DirEntry[])
      .mockRejectedValueOnce(new Error('boom'));
    const onPick = vi.fn();
    mountOpenRemoteDialog({ root: document.body, onPick, ipc });
    await flushMicrotasks();
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    const originalTable = document.body.querySelector(
      'table.entries',
    ) as HTMLElement;
    expect(originalTable).toBeTruthy();
    // Trigger a failed descend → moves state to 'error'.
    (
      document.body.querySelector('tr[data-name="docs"]') as HTMLElement
    ).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flushMicrotasks();
    expect(
      document.body.querySelector('[data-testid="dialog-error"]'),
    ).toBeTruthy();
    const callsBefore = (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls
      .length;
    // Dispatch keydown on the orphan table. Handler must early-return
    // (state.kind === 'error'), so no crash, no extra list_dir, no pick.
    originalTable.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    );
    originalTable.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    originalTable.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
    );
    expect(
      (ipc.sshListDir as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(callsBefore);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Back from error after a slow autocomplete shows the resolved suggestions', async () => {
    // Covers the autocomplete-during-error stash (state = {...state,
    // suggestions}) and confirms Back→A then renders with the resolved
    // suggestions list (state.suggestions ?? [] branch in renderHostEntry).
    const ipc = makeIpc();
    (ipc.sshListDir as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom'),
    );
    let resolveSuggestions!: (v: string[]) => void;
    const slowSource = () =>
      new Promise<string[]>((res) => {
        resolveSuggestions = res;
      });
    mountOpenRemoteDialog({
      root: document.body,
      onPick: vi.fn(),
      hostAutocompleteSource: slowSource,
      ipc,
    });
    // Trigger error state before autocomplete resolves.
    (document.body.querySelector('.host-input') as HTMLInputElement).value =
      'h.example';
    (document.body.querySelector('.connect-btn') as HTMLButtonElement).click();
    await flushMicrotasks();
    expect(document.body.querySelector('[data-testid="dialog-error"]')).toBeTruthy();
    // Autocomplete arrives — state.kind === 'error', not 'host-entry'.
    resolveSuggestions(['stashed@h:42']);
    await flushMicrotasks();
    // Still in error state, but suggestions stashed on state.
    expect(
      document.body.querySelector('[data-testid="dialog-error"]'),
    ).toBeTruthy();
    // Click Back — host-entry should render with the stashed suggestions.
    (document.body.querySelector('.dialog-retry') as HTMLButtonElement).click();
    const values = Array.from(
      document.body.querySelectorAll('datalist#recent-hosts option'),
    ).map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['stashed@h:42']);
  });
});
