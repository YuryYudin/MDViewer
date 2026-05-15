import { describe, it, expect, vi } from 'vitest';
import { mountStartPage } from '../../src/views/StartPage';
import type { Ipc } from '../../src/ipc';

function fakeIpc(recentPaths: string[] = ['/docs/a.md', '/docs/b.md']): Ipc {
  // listRecents now returns RecentEntry[] with optional mtime; tests
  // exercising path rendering supply just the path component. A10 added
  // `kind` so each entry is tagged Local / Ssh — the helper defaults to
  // 'local' because most callers don't care about the badge surface.
  const recents = recentPaths.map((p) => ({
    path: p,
    mtime: null,
    kind: p.startsWith('ssh://') ? 'ssh' : 'local',
  }));
  return {
    listRecents: vi.fn().mockResolvedValue(recents),
    openDocument: vi
      .fn()
      .mockResolvedValue({ kind: 'document', tab_id: 't1', path: '/docs/a.md', html: '<h1/>', threads: [] }),
    getSettings: vi.fn().mockResolvedValue({
      profile: { user_id: 'u', display_name: '', color: '#888' },
    }),
    setSettings: vi.fn().mockResolvedValue(undefined),
    listThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    listOpenDocuments: vi.fn().mockResolvedValue([]),
    appInfo: vi.fn().mockResolvedValue({ version: '0.0.0', commit_hash: 'unit' }),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn(),
  } as unknown as Ipc;
}

describe('StartPage', () => {
  it('renders recents and Open / Settings buttons', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    expect(root.querySelector('[data-view="start"]')).toBeTruthy();
    expect(root.querySelector('[data-action="open-file"]')).toBeTruthy();
    expect(root.querySelector('[data-action="open-settings"]')).toBeTruthy();
    const items = root.querySelectorAll('[data-test="recent-item"]');
    expect(items.length).toBe(2);
  });

  it('uses textContent for recent paths so markup cannot be injected', async () => {
    // The XSS guarantee comes from textContent, not from path parsing.
    // basename() and withTilde() may legitimately reshape the displayed
    // text (basename strips the / inside `</script>`, for example), so
    // the assertion is "no actual <script> element exists in the DOM",
    // not "the displayed text equals the input verbatim".
    const root = document.createElement('div');
    const ipc = fakeIpc(['<script>alert(1)</script>.md']);
    await mountStartPage(root, ipc);
    const item = root.querySelector('[data-test="recent-item"]')!;
    expect(item.querySelector('script')).toBeNull();
    expect(item.innerHTML).not.toContain('<script>');
  });

  it('opens recent document on click', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc(['/docs/a.md']);
    await mountStartPage(root, ipc);
    const item = root.querySelector('[data-test="recent-item"]') as HTMLElement;
    item.click();
    expect(ipc.openDocument).toHaveBeenCalledWith('/docs/a.md');
  });

  it('exposes a hidden file input for E2E uploads', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    const input = root.querySelector('[data-test="file-input"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe('file');
    expect(input.style.display).toBe('none');
  });

  it('routes the file input change event through ipc.openDocument', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    const input = root.querySelector('[data-test="file-input"]') as HTMLInputElement;
    // Simulate setValue from tauri-driver: a file with an absolute `path` is
    // attached. jsdom forbids programmatically setting the value field, so we
    // place the path on the file object directly.
    const file = new File(['# hi'], 'a.md', { type: 'text/markdown' });
    (file as unknown as { path: string }).path = '/abs/path/to/a.md';
    Object.defineProperty(input, 'files', {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(ipc.openDocument).toHaveBeenCalled();
  });

  it('falls back to File.name when neither value nor path is available', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    const input = root.querySelector('[data-test="file-input"]') as HTMLInputElement;
    const file = new File(['# hi'], 'plain.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(ipc.openDocument).toHaveBeenCalledWith('plain.md');
  });

  it('ignores empty file input change events', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    const input = root.querySelector('[data-test="file-input"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(ipc.openDocument).not.toHaveBeenCalled();
  });

  it('clicking Settings dispatches mdviewer:open-settings', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    const handler = vi.fn();
    document.addEventListener('mdviewer:open-settings', handler, { once: true });
    (root.querySelector('[data-action="open-settings"]') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalled();
  });

  it('clicking Open in E2E mode triggers the hidden file input', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    // The e2e flag is normally injected by the launcher via `import.meta.env`.
    // For unit tests we use the `window.__MDVIEWER_E2E` escape hatch the
    // detector also honors.
    (window as any).__MDVIEWER_E2E = true;
    try {
      await mountStartPage(root, ipc);
      const input = root.querySelector('[data-test="file-input"]') as HTMLInputElement;
      const click = vi.spyOn(input, 'click');
      const open = root.querySelector('[data-action="open-file"]') as HTMLButtonElement;
      open.click();
      await Promise.resolve();
      expect(click).toHaveBeenCalled();
    } finally {
      delete (window as any).__MDVIEWER_E2E;
    }
  });

  it('clicking Open out of E2E mode opens the native dialog and forwards the picked path', async () => {
    // Mock the dynamic import target so the dialog branch is exercised
    // without needing a real Tauri runtime.
    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      open: vi.fn().mockResolvedValue('/picked/path.md'),
    }));
    try {
      const root = document.createElement('div');
      const ipc = fakeIpc();
      delete (window as any).__MDVIEWER_E2E;
      await mountStartPage(root, ipc);
      (root.querySelector('[data-action="open-file"]') as HTMLButtonElement).click();
      // Allow the dynamic import + dialog promise chain to resolve.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(ipc.openDocument).toHaveBeenCalledWith('/picked/path.md');
    } finally {
      vi.doUnmock('@tauri-apps/plugin-dialog');
    }
  });

  it('clicking Open ignores a cancelled dialog (non-string result)', async () => {
    vi.doMock('@tauri-apps/plugin-dialog', () => ({
      open: vi.fn().mockResolvedValue(null),
    }));
    try {
      const root = document.createElement('div');
      const ipc = fakeIpc();
      delete (window as any).__MDVIEWER_E2E;
      await mountStartPage(root, ipc);
      (root.querySelector('[data-action="open-file"]') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(ipc.openDocument).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('@tauri-apps/plugin-dialog');
    }
  });
});

// Branch-coverage gate (C5): the relativeTime() helper has six arms — just
// now / minutes / hours / yesterday / days / absolute date — and prior to
// this gate only the `mtime: null` branch (rendered as "—") was exercised.
// The C5 trim of dead `if !feature_enabled` branches dropped the global
// branch denominator just enough to expose this helper's missing arms.
//
// The helper isn't exported, so we drive it through the public mountStartPage
// surface by feeding mtimes computed from `Date.now()`. fake-timers pin the
// `now` value so each branch is reachable deterministically.
describe('StartPage — relativeTime branches (C5 branch coverage)', () => {
  function fakeIpcWithMtimes(
    entries: { path: string; mtime: number | null }[],
  ): Ipc {
    return {
      listRecents: vi.fn().mockResolvedValue(entries),
      openDocument: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        profile: { user_id: 'u', display_name: '', color: '#888' },
      }),
      setSettings: vi.fn().mockResolvedValue(undefined),
      listThreads: vi.fn().mockResolvedValue([]),
      createThread: vi.fn(),
      postReply: vi.fn(),
      resolveThread: vi.fn(),
      closeTab: vi.fn(),
      activateTab: vi.fn(),
      listOpenDocuments: vi.fn().mockResolvedValue([]),
      appInfo: vi.fn().mockResolvedValue({ version: '0.0.0', commit_hash: 'unit' }),
      renderMarkdown: vi.fn(),
      resolveAnchor: vi.fn(),
    } as unknown as Ipc;
  }

  function timeOf(item: Element): string {
    return item.querySelector('[data-test="recent-when"]')?.textContent ?? '';
  }

  it('renders all five relative-time branches plus the absolute-date fallback', async () => {
    // Pin "now" so the deltas are reproducible regardless of when the
    // suite runs. Date.now() inside relativeTime samples the system
    // clock; fake-timers replace it without leaking into other tests.
    const NOW_MS = new Date('2026-04-30T12:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const nowSec = Math.floor(NOW_MS / 1000);

    const entries = [
      { path: '/docs/justnow.md', mtime: nowSec - 10 },           // < 60s
      { path: '/docs/minutes.md', mtime: nowSec - 5 * 60 },       // < 3600s
      { path: '/docs/hours.md', mtime: nowSec - 5 * 3600 },       // < 86400s
      { path: '/docs/yesterday.md', mtime: nowSec - 30 * 3600 },  // < 86400 * 2
      { path: '/docs/days.md', mtime: nowSec - 4 * 86400 },       // < 86400 * 7
      { path: '/docs/old.md', mtime: nowSec - 30 * 86400 },       // absolute
    ];
    const root = document.createElement('div');
    await mountStartPage(root, fakeIpcWithMtimes(entries));

    const items = root.querySelectorAll('[data-test="recent-item"]');
    expect(items.length).toBe(6);
    expect(timeOf(items[0])).toBe('just now');
    expect(timeOf(items[1])).toBe('5 minutes ago');
    expect(timeOf(items[2])).toBe('5 hours ago');
    expect(timeOf(items[3])).toBe('Yesterday');
    expect(timeOf(items[4])).toBe('4 days ago');
    // Absolute date: locale-formatted "Mar 31" or "31 Mar" depending on
    // jsdom's ICU. Assert the shape rather than the exact locale-dependent
    // string. The branch we want covered is the `> 7 days` arm.
    expect(timeOf(items[5])).toMatch(/^(?:[A-Z][a-z]{2,} \d{1,2}|\d{1,2} [A-Z][a-z]{2,})$/);

    vi.useRealTimers();
  });

  it('renders an SSH badge on Recents entries whose kind is "ssh"', async () => {
    // A11: wireframe-01 specifies a small "SSH" text pill on remote recent
    // entries so the user can tell at a glance which row will trigger an
    // SSH auth round-trip. The predicate is the RecentEntry.kind field
    // (added by A10), NOT a string startswith check on the path — that
    // way a future tweak to how SSH paths are stringified can't drift the
    // UI without also drifting the badge.
    const entries = [
      { path: '/local/notes.md', mtime: null, kind: 'local' as const },
      { path: 'ssh://server/path/remote.md', mtime: null, kind: 'ssh' as const },
    ];
    const root = document.createElement('div');
    await mountStartPage(root, fakeIpcWithMtimes(entries));
    const items = root.querySelectorAll('[data-test="recent-item"]');
    expect(items.length).toBe(2);
    // Local entry: NO badge.
    expect(items[0].querySelector('.recents-badge--ssh')).toBeNull();
    // SSH entry: badge present with the literal text "SSH".
    const badge = items[1].querySelector('.recents-badge--ssh') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('SSH');
    expect(badge.getAttribute('aria-label')).toBe('Remote file');
  });

  it('uses singular forms ("1 minute ago") for the boundary deltas', async () => {
    // The pluralisation ternaries (`m === 1 ? '' : 's'`) are their own
    // branches; covering only the plural arm leaves them at 50%. Pinning
    // exactly 60s and 3600s deltas exercises both singular branches.
    const NOW_MS = new Date('2026-04-30T12:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const nowSec = Math.floor(NOW_MS / 1000);

    const entries = [
      { path: '/docs/one-minute.md', mtime: nowSec - 60 },
      { path: '/docs/one-hour.md', mtime: nowSec - 3600 },
    ];
    const root = document.createElement('div');
    await mountStartPage(root, fakeIpcWithMtimes(entries));
    const items = root.querySelectorAll('[data-test="recent-item"]');
    expect(timeOf(items[0])).toBe('1 minute ago');
    expect(timeOf(items[1])).toBe('1 hour ago');

    vi.useRealTimers();
  });
});
