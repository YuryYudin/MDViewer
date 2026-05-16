import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountOpenRemoteDialog } from '../../src/views/OpenRemoteDialog';
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
