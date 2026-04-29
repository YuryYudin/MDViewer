import { describe, it, expect, vi } from 'vitest';
import { mountStartPage } from '../../src/views/StartPage';
import type { Ipc } from '../../src/ipc';

function fakeIpc(recentPaths: string[] = ['/docs/a.md', '/docs/b.md']): Ipc {
  // listRecents now returns RecentEntry[] with optional mtime; tests
  // exercising path rendering supply just the path component.
  const recents = recentPaths.map((p) => ({ path: p, mtime: null }));
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
