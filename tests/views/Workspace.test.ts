import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountWorkspace } from '../../src/views/Workspace';
import type { Ipc } from '../../src/ipc';

// Capture the listener callbacks installed against the Tauri event bus so
// tests can fire them deterministically. The mock factory must be called
// before mountWorkspace's `await import(...)` resolves; vi.mock is hoisted
// to the top of the module so this is safe.
type Listener = (ev: { payload: unknown }) => void;
const tauriListeners: Record<string, Listener[]> = {};
vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, cb: Listener) => {
    (tauriListeners[event] ||= []).push(cb);
    return Promise.resolve(() => undefined);
  },
}));

beforeEach(() => {
  for (const k of Object.keys(tauriListeners)) tauriListeners[k] = [];
});

function makeIpc(openIds: string[] = []): Ipc {
  const recents = [
    { path: '/docs/r1.md', mtime: null },
    { path: '/docs/r2.md', mtime: null },
  ];
  // Tests pass bare ids for brevity — this fan-out builds the {id, path}
  // pairs the IPC actually returns. Using `/docs/<id>.md` keeps the path
  // distinct from the id so a regression to "render id as label" would
  // surface in the basename mismatch.
  const summaries = openIds.map((id) => ({ id, path: `/docs/${id}.md` }));
  return {
    listOpenDocuments: vi.fn().mockResolvedValue(summaries),
    listRecents: vi.fn().mockResolvedValue(recents),
    openDocument: vi
      .fn()
      .mockResolvedValue({ kind: 'document', tab_id: 't1', path: '/x', html: '', threads: [] }),
    closeTab: vi.fn().mockResolvedValue(undefined),
    activateTab: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      appearance: { theme: 'light', font_size_px: 14, line_height: 1.5, density: 'comfortable' },
      comments: { show_resolved: false, sidecar_pattern: '{name}.md.comments.json', reattachment_confidence: 75, auto_merge: 'manual' },
      editor: {},
    }),
    setSettings: vi.fn(),
    listThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    appInfo: vi.fn().mockResolvedValue({ version: '0.0.0', commit_hash: 'unit' }),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn().mockResolvedValue({ kind: 'orphan' }),
    saveDocument: vi.fn().mockResolvedValue(undefined),
    setDirty: vi.fn().mockResolvedValue(undefined),
    diffMd: vi.fn().mockResolvedValue([
      { kind: 'conflicting', local_text: 'l', incoming_text: 'r', local_range: [0, 1], incoming_range: [0, 1] },
    ]),
    exportDocument: vi.fn(),
    getDocPref: vi.fn().mockResolvedValue(null),
    setDocPref: vi.fn().mockResolvedValue(undefined),
    deleteDocPref: vi.fn().mockResolvedValue(undefined),
  } as unknown as Ipc;
}

describe('Workspace', () => {
  it('mounts the workspace shell with three regions (tabbar / body / status)', async () => {
    // The OS supplies the window title; the in-app titlebar region was
    // removed because it (a) duplicated the OS title and (b) confused
    // CSS Grid's auto-placement when hidden, slotting items into the
    // wrong tracks.
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    expect(root.querySelector('[data-view="workspace"]')).toBeTruthy();
    expect(root.querySelector('[data-region="titlebar"]')).toBeNull();
    expect(root.querySelector('[data-region="tabbar"]')).toBeTruthy();
    expect(root.querySelector('[data-region="body"]')).toBeTruthy();
    expect(root.querySelector('[data-region="status"]')).toBeTruthy();
  });

  it('mounts StartPage in body when no tabs are open', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc([]));
    const body = root.querySelector('[data-region="body"]')!;
    expect(body.querySelector('[data-view="start"]')).toBeTruthy();
  });

  it('mounts a Document placeholder when at least one tab is open', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc(['t1']));
    const body = root.querySelector('[data-region="body"]')!;
    expect(body.querySelector('[data-view="document"]')).toBeTruthy();
    expect(body.querySelector('[data-view="start"]')).toBeNull();
  });

  it('clicking × on the only open tab calls closeTab and falls back to StartPage', async () => {
    // Regression: TabBar dispatched closeTab but the workspace never
    // repainted, so the closed tab stayed visible and StartPage never
    // came back. Wiring onAfterChange → refresh() in the TabBar mount
    // call is what makes the strip drop the row.
    const root = document.createElement('div');
    let ids: string[] = ['t-1'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() =>
      Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))),
    );
    // closeTab on the Rust side removes the tab — emulate by shrinking ids.
    (ipc.closeTab as any).mockImplementation(async (id: string) => {
      ids = ids.filter((x) => x !== id);
    });
    await mountWorkspace(root, ipc);
    expect(root.querySelector('[data-view="document"]')).toBeTruthy();

    (root.querySelector('[data-test="tab-close"]') as HTMLElement).click();
    // Two ticks: closeTab resolves, onAfterChange awaits, refresh runs.
    await new Promise((r) => setTimeout(r, 10));

    expect(ipc.closeTab).toHaveBeenCalledWith('t-1');
    expect(root.querySelector('[data-view="document"]')).toBeNull();
    expect(root.querySelector('[data-view="start"]')).toBeTruthy();
  });

  it('refresh() picks up new tabs and replaces StartPage with Document', async () => {
    const root = document.createElement('div');
    let ids: string[] = [];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    const handle = await mountWorkspace(root, ipc);
    expect(root.querySelector('[data-view="start"]')).toBeTruthy();
    ids = ['t1'];
    await handle.refresh();
    expect(root.querySelector('[data-view="start"]')).toBeNull();
    expect(root.querySelector('[data-view="document"]')).toBeTruthy();
  });

  it('caches Document outcomes via setActive and shows them on refresh', async () => {
    // setActive seeds the title/threads cache; subsequent refresh mounts a
    // real Document (not the placeholder shape).
    const root = document.createElement('div');
    let ids: string[] = [];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-active',
      path: '/docs/x.md',
      html: '<p>hi</p>',
      threads: [],
    });
    ids = ['t-active'];
    await handle.refresh();
    expect(root.querySelector('[data-view="document"]')).toBeTruthy();
  });

  it('routes a Conflict outcome to the Conflict view via pendingConflict', async () => {
    // Asserting the dispatch path: setActive(conflict) → refresh() →
    // mountConflict mounts the conflict view in body, regardless of the
    // open-tab list.
    const root = document.createElement('div');
    const ipc = makeIpc();
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'conflict',
      tab_id: 't',
      path: '/docs/x.md',
      local: 'l',
      incoming: 'r',
    });
    await handle.refresh();
    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();
    expect(root.querySelector('[data-view="document"]')).toBeNull();
  });

  it('clears pendingConflict on conflict-resolved and routes back to Document', async () => {
    const root = document.createElement('div');
    let ids: string[] = ['t-active'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-active',
      path: '/docs/x.md',
      html: '<p>v</p>',
      threads: [],
    });
    handle.setActive({
      kind: 'conflict',
      tab_id: 't-active',
      path: '/docs/x.md',
      local: 'l',
      incoming: 'r',
    });
    await handle.refresh();
    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();

    // Simulate the user clicking Finish merge inside the conflict view —
    // mountConflict emits 'conflict-resolved' on the body, which flips
    // pendingConflict back to null and triggers a refresh.
    (root.querySelector('[data-action="finish-merge"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
    expect(root.querySelector('[data-view="document"]')).toBeTruthy();
    expect(root.querySelector('[data-view="conflict"]')).toBeNull();
  });

  it('exposes setActive on the workspace root via __mdv_setActive for StartPage', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    const hook = (root as unknown as { __mdv_setActive?: Function }).__mdv_setActive;
    expect(typeof hook).toBe('function');
  });

  it('subscribes to the show-conflict tauri event and routes to the Conflict view', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc(['t-1']));
    expect(tauriListeners['show-conflict']?.length ?? 0).toBeGreaterThan(0);

    // Fire the show-conflict event the way the Rust IPC handler emits it.
    tauriListeners['show-conflict']![0]!({
      payload: { tab_id: 't-1', path: '/docs/x.md', local: 'l', incoming: 'r' },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();
  });

  it('forwards external-change reload events for the active tab into a refresh', async () => {
    const root = document.createElement('div');
    let ids: string[] = ['t-1'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>v1</p>',
      threads: [],
    });
    await handle.refresh();
    expect(tauriListeners['external-change']?.length ?? 0).toBeGreaterThan(0);

    const calls = (ipc.listOpenDocuments as any).mock.calls.length;
    tauriListeners['external-change']![0]!({
      payload: { path: '/docs/x.md', kind: 'md', action: 'reload' },
    });
    await new Promise((r) => setTimeout(r, 5));
    // The reload listener should have triggered a refresh, which calls
    // listOpenDocuments at least once more.
    expect((ipc.listOpenDocuments as any).mock.calls.length).toBeGreaterThan(calls);
  });

  it('mounts ShareDialog when Document dispatches share-requested', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let ids: string[] = ['t-1'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>v</p>',
      threads: [],
    });
    await handle.refresh();

    const body = root.querySelector('[data-region="body"]')!;
    body.dispatchEvent(
      new CustomEvent('share-requested', {
        bubbles: true,
        detail: { tabId: 't-1', path: '/docs/x.md' },
      }),
    );
    await Promise.resolve();
    expect(root.querySelector('[data-region="share-overlay"]')).toBeTruthy();

    // share-dismissed removes the overlay.
    const overlay = root.querySelector('[data-region="share-overlay"]')!;
    overlay.dispatchEvent(new CustomEvent('share-dismissed', { bubbles: true }));
    await Promise.resolve();
    expect(root.querySelector('[data-region="share-overlay"]')).toBeNull();

    document.body.removeChild(root);
  });

  it('reloadDocument round-trip on external-change reload swaps cached html', async () => {
    const root = document.createElement('div');
    let ids: string[] = ['t-1'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    (ipc.reloadDocument as any) = vi.fn().mockResolvedValue({
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>fresh</p>',
      threads: [],
    });
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>stale</p>',
      threads: [],
    });
    await handle.refresh();

    tauriListeners['external-change']![0]!({
      payload: { path: '/docs/x.md', kind: 'md', action: 'reload' },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(ipc.reloadDocument).toHaveBeenCalledWith('/docs/x.md');
  });

  it('reloadDocument failure still triggers a refresh so the user is not stranded', async () => {
    const root = document.createElement('div');
    let ids: string[] = ['t-1'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))));
    (ipc.reloadDocument as any) = vi.fn().mockRejectedValue(new Error('disk gone'));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>v</p>',
      threads: [],
    });
    await handle.refresh();
    const calls = (ipc.listOpenDocuments as any).mock.calls.length;

    tauriListeners['external-change']![0]!({
      payload: { path: '/docs/x.md', kind: 'md', action: 'reload' },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect((ipc.listOpenDocuments as any).mock.calls.length).toBeGreaterThan(calls);
  });

  it('renders an external-change banner for an "ask" action and skips it for "ignore"', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc(['t-1']));

    // ignore: no banner appears.
    tauriListeners['external-change']![0]!({
      payload: { path: '/docs/x.md', kind: 'md', action: 'ignore' },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(root.querySelector('[data-view="external-change"]')).toBeNull();

    // ask: banner appears with the path text.
    tauriListeners['external-change']![0]!({
      payload: { path: '/docs/x.md', kind: 'md', action: 'ask' },
    });
    await new Promise((r) => setTimeout(r, 5));
    const banner = root.querySelector<HTMLElement>('[data-view="external-change"]');
    expect(banner).toBeTruthy();
    expect(banner!.textContent).toContain('/docs/x.md');
  });
});

describe('Workspace — font-size feature (A9)', () => {
  // Tests below use real (fake-)timers for the 150ms debounce and rely on
  // `:root.style.--doc-font-size` mutations. Each test cleans up the
  // inline property at the end so cross-test pollution can't hide a bug.
  beforeEach(() => {
    document.documentElement.style.removeProperty('--doc-font-size');
  });

  async function mountWith(
    ipc: Ipc,
    activeId = 't-1',
    path = '/docs/x.md',
  ): Promise<{ root: HTMLElement; handle: any }> {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let ids: string[] = [activeId];
    (ipc.listOpenDocuments as any).mockImplementation(() =>
      Promise.resolve(ids.map((id) => ({ id, path }))),
    );
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: activeId,
      path,
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    return { root, handle };
  }

  it('registers listeners for the three font CustomEvents on document', async () => {
    const ipc = makeIpc();
    await mountWith(ipc);
    // After mount, the listeners exist — firing each fires the helper which
    // ultimately mutates `:root.style.--doc-font-size`. Just verify the
    // increment path mutates the inline CSS property.
    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('15px');

    document.dispatchEvent(new CustomEvent('mdviewer:font-decrease'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('14px');

    document.dispatchEvent(new CustomEvent('mdviewer:font-reset'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('');
  });

  it('clamps to [10, 24]: at 10 px, decrease is a no-op (no IPC, value stays 10)', async () => {
    vi.useFakeTimers();
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue({ font_size_px: 10 });
    const { root } = await mountWith(ipc);
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('10px');

    document.dispatchEvent(new CustomEvent('mdviewer:font-decrease'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('10px');
    vi.advanceTimersByTime(200);
    expect(ipc.setDocPref).not.toHaveBeenCalled();

    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('10');
    const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
    expect(dec.disabled).toBe(true);
    vi.useRealTimers();
  });

  it('clamps to [10, 24]: at 24 px, increase is a no-op (no IPC, value stays 24)', async () => {
    vi.useFakeTimers();
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue({ font_size_px: 24 });
    const { root } = await mountWith(ipc);
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('24px');

    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('24px');
    vi.advanceTimersByTime(200);
    expect(ipc.setDocPref).not.toHaveBeenCalled();

    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('24');
    const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
    expect(inc.disabled).toBe(true);
    vi.useRealTimers();
  });

  it('debounce: rapid-fire 5 increases coalesce to one setDocPref call after 150 ms with the final value', async () => {
    vi.useFakeTimers();
    const ipc = makeIpc();
    const { root } = await mountWith(ipc); // starts at 14
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
    }
    // Before the timer fires, setDocPref must not have been called yet.
    expect(ipc.setDocPref).not.toHaveBeenCalled();
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('19px');

    vi.advanceTimersByTime(150);
    // Exactly one IPC call with the final value.
    expect(ipc.setDocPref).toHaveBeenCalledTimes(1);
    expect(ipc.setDocPref).toHaveBeenCalledWith('/docs/x.md', { font_size_px: 19 });
    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('19');
    vi.useRealTimers();
  });

  it('reset: removes the inline property AND calls deleteDocPref after 150 ms', async () => {
    vi.useFakeTimers();
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue({ font_size_px: 18 });
    const { root } = await mountWith(ipc);
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('18px');

    document.dispatchEvent(new CustomEvent('mdviewer:font-reset'));
    // Inline property cleared synchronously so the cascade re-applies.
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('');
    // Readout falls back to global default (14) immediately.
    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('14');

    expect(ipc.deleteDocPref).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(ipc.deleteDocPref).toHaveBeenCalledTimes(1);
    expect(ipc.deleteDocPref).toHaveBeenCalledWith('/docs/x.md');
    vi.useRealTimers();
  });

  it('tab activation: getDocPref returns {font_size_px: 18} → sets :root --doc-font-size to 18px', async () => {
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue({ font_size_px: 18 });
    const { root } = await mountWith(ipc);
    expect(ipc.getDocPref).toHaveBeenCalledWith('/docs/x.md');
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('18px');
    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('18');
  });

  it('tab activation: getDocPref returns null → REMOVES the inline --doc-font-size property', async () => {
    const ipc = makeIpc();
    // Pre-pollute the inline property to ensure activation actually removes it.
    document.documentElement.style.setProperty('--doc-font-size', '20px');
    (ipc.getDocPref as any).mockResolvedValue(null);
    const { root } = await mountWith(ipc);
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('');
    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('14');
  });

  it('mdviewer:settings-changed: re-renders readout when active tab has NO override', async () => {
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue(null);
    const { root } = await mountWith(ipc);
    let readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('14');

    document.dispatchEvent(
      new CustomEvent('mdviewer:settings-changed', {
        detail: {
          appearance: { theme: 'light', font_size_px: 17, line_height: 1.5, density: 'comfortable' },
          comments: { show_resolved: false, sidecar_pattern: '{name}.md.comments.json', reattachment_confidence: 75, auto_merge: 'manual' },
          editor: {},
        },
      }),
    );

    readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('17');
  });

  it('mdviewer:settings-changed: does NOT touch the readout when active tab HAS an override', async () => {
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue({ font_size_px: 18 });
    const { root } = await mountWith(ipc);
    let readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('18');

    document.dispatchEvent(
      new CustomEvent('mdviewer:settings-changed', {
        detail: {
          appearance: { theme: 'light', font_size_px: 17, line_height: 1.5, density: 'comfortable' },
          comments: { show_resolved: false, sidecar_pattern: '{name}.md.comments.json', reattachment_confidence: 75, auto_merge: 'manual' },
          editor: {},
        },
      }),
    );

    readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    // Readout stays at the override value because the active tab has one.
    expect(readout.textContent).toBe('18');
  });

  it('untitled / scratch tabs (no path) skip the IPC persist path entirely', async () => {
    vi.useFakeTimers();
    const ipc = makeIpc();
    const root = document.createElement('div');
    document.body.appendChild(root);
    (ipc.listOpenDocuments as any).mockResolvedValue([
      { id: 't-untitled', path: '' },
    ]);
    const handle = await mountWorkspace(root, ipc);
    // setActive without a path → activeTab.path is empty/undefined.
    handle.setActive({
      kind: 'document',
      tab_id: 't-untitled',
      path: '',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();

    // getDocPref is skipped for empty path (no on-disk path = nothing to read).
    expect(ipc.getDocPref).not.toHaveBeenCalled();

    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('15px');
    vi.advanceTimersByTime(200);
    // No persist call for untitled tabs.
    expect(ipc.setDocPref).not.toHaveBeenCalled();

    document.dispatchEvent(new CustomEvent('mdviewer:font-reset'));
    vi.advanceTimersByTime(200);
    expect(ipc.deleteDocPref).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('toolbar +/- bound state updates after applyFontDelta crosses a bound', async () => {
    vi.useFakeTimers();
    const ipc = makeIpc();
    (ipc.getDocPref as any).mockResolvedValue({ font_size_px: 23 });
    const { root } = await mountWith(ipc);
    const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
    const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
    expect(inc.disabled).toBe(false);

    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
    // Now at 24 — increase becomes disabled with the bound title.
    expect(inc.disabled).toBe(true);
    expect(inc.getAttribute('title')).toBe('Already at maximum (24 px)');
    expect(dec.disabled).toBe(false);
    vi.useRealTimers();
  });
});
