import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountStartPage } from '../../src/views/StartPage';
import type { Ipc } from '../../src/ipc';

// The StartPage open-file handler dynamically `import()`s
// `@tauri-apps/plugin-dialog`. A per-test `vi.doMock` raced that dynamic
// import (and intermittently failed to intercept it at all, letting the real
// plugin run and throw `Cannot read properties of undefined (reading
// 'invoke')`). A hoisted `vi.mock` reliably intercepts every import of the
// module for the whole file; each test configures the shared `open` mock's
// resolved value. The E2E-mode and recents tests never reach this import, so
// the file-wide mock is inert for them.
const { dialogOpen } = vi.hoisted(() => ({ dialogOpen: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialogOpen }));

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
    openInNewWindow: vi.fn().mockResolvedValue(undefined),
  } as unknown as Ipc;
}

describe('StartPage', () => {
  beforeEach(() => {
    // Clear the shared dialog mock's history + implementation so the two
    // dialog tests don't see each other's calls or resolved values.
    dialogOpen.mockReset();
  });

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

  // D3: each recents row carries an open-in-new-window affordance
  // (wireframe 06). It must (a) be present per row with the agreed
  // data-test hook, (b) call ipc.openInNewWindow with that row's path
  // when activated, and (c) stopPropagation so the row's own
  // open-in-this-window click does NOT also fire.
  it('renders an open-in-new-window affordance per recent row', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc(['/docs/a.md', '/docs/b.md']);
    await mountStartPage(root, ipc);
    const affordances = root.querySelectorAll('[data-test="recent-open-new-window"]');
    expect(affordances.length).toBe(2);
  });

  it('clicking the open-in-new-window affordance calls ipc.openInNewWindow with the row path', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc(['/docs/a.md', '/docs/b.md']);
    await mountStartPage(root, ipc);
    const rows = root.querySelectorAll('[data-test="recent-item"]');
    const affordance = rows[1].querySelector(
      '[data-test="recent-open-new-window"]',
    ) as HTMLElement;
    affordance.click();
    expect(ipc.openInNewWindow).toHaveBeenCalledWith('/docs/b.md');
  });

  it('the open-in-new-window affordance stops propagation so the row open does not also fire', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc(['/docs/a.md']);
    await mountStartPage(root, ipc);
    const affordance = root.querySelector(
      '[data-test="recent-open-new-window"]',
    ) as HTMLElement;
    affordance.click();
    // Propagation stopped: the row's open-in-this-window handler did NOT run.
    expect(ipc.openDocument).not.toHaveBeenCalled();
    // The new-window IPC did run for this row's path.
    expect(ipc.openInNewWindow).toHaveBeenCalledWith('/docs/a.md');
  });

  it('a plain row-body click still opens in this window even with the affordance present', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc(['/docs/a.md']);
    await mountStartPage(root, ipc);
    const item = root.querySelector('[data-test="recent-item"]') as HTMLElement;
    item.click();
    expect(ipc.openDocument).toHaveBeenCalledWith('/docs/a.md');
    expect(ipc.openInNewWindow).not.toHaveBeenCalled();
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
    // The dialog branch is exercised via the hoisted plugin-dialog mock.
    dialogOpen.mockResolvedValue('/picked/path.md');
    const root = document.createElement('div');
    const ipc = fakeIpc();
    delete (window as any).__MDVIEWER_E2E;
    await mountStartPage(root, ipc);
    (root.querySelector('[data-action="open-file"]') as HTMLButtonElement).click();
    // Poll until the dynamic-import → dialog → openDocument chain completes,
    // instead of guessing a fixed number of macrotask ticks (the old race).
    await vi.waitFor(() =>
      expect(ipc.openDocument).toHaveBeenCalledWith('/picked/path.md'),
    );
  });

  it('clicking Open ignores a cancelled dialog (non-string result)', async () => {
    dialogOpen.mockResolvedValue(null);
    const root = document.createElement('div');
    const ipc = fakeIpc();
    delete (window as any).__MDVIEWER_E2E;
    await mountStartPage(root, ipc);
    (root.querySelector('[data-action="open-file"]') as HTMLButtonElement).click();
    // Wait until the dialog actually resolved, then let the handler's
    // string-check continuation settle; only then assert it stayed a no-op.
    await vi.waitFor(() => expect(dialogOpen).toHaveBeenCalled());
    await Promise.resolve();
    expect(ipc.openDocument).not.toHaveBeenCalled();
  });

  // B2: the "Open from remote…" button mounts OpenRemoteDialog. The
  // button's presence is the contract — the dialog's wiring is covered
  // separately in tests/views/OpenRemoteDialog.test.ts. Here we only
  // assert (a) the button exists with the agreed data-testid, and (b)
  // clicking it appends an OpenRemoteDialog overlay to document.body
  // (the dialog mounts at the body level, not inside StartPage's root,
  // because it needs to overlay the entire workspace).
  it('renders an "Open from remote…" button on the action row', async () => {
    const root = document.createElement('div');
    const ipc = fakeIpc();
    await mountStartPage(root, ipc);
    const btn = root.querySelector('[data-testid="open-from-remote-button"]');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toContain('Open from remote');
  });

  it('clicking "Open from remote…" mounts the OpenRemoteDialog overlay on document.body', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = fakeIpc();
    try {
      await mountStartPage(root, ipc);
      // Pre-condition: no dialog present yet.
      expect(document.body.querySelector('[data-testid="open-remote-dialog"]')).toBeNull();
      (
        root.querySelector('[data-testid="open-from-remote-button"]') as HTMLButtonElement
      ).click();
      // The dialog mounts synchronously in its initial render before its
      // async autocomplete fetch resolves.
      expect(
        document.body.querySelector('[data-testid="open-remote-dialog"]'),
      ).toBeTruthy();
    } finally {
      document.body.innerHTML = '';
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
