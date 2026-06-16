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
    getActiveTabId: vi.fn().mockResolvedValue(null),
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
      // 2025-05-01: Drive integration is opt-in; the legacy A8 pill tests
      // assume an enabled feature, so wire it true in the fixture.
      cloud: { drive: { feature_enabled: true, connected: false, account_email: null, backend_mode: 'auto', poll_interval_active_secs: 5, poll_interval_unfocused_secs: 10, custom_oauth_client_id: null, detect_toast_suppressed: false } },
    }),
    setSettings: vi.fn(),
    listThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    deleteThread: vi.fn().mockResolvedValue(undefined),
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

  it('clicking another tab calls openDocument(path) and swaps the rendered HTML', async () => {
    // Regression: TabBar's click handler used to call ipc.activateTab(id)
    // and trigger a workspace refresh. activateTab updates Rust's active
    // id but does NOT refresh the host's cached payload, so refresh()
    // re-mounted with the previously-active tab's html and the click
    // appeared to do nothing. Fix: TabBar now exposes onActivate(tab),
    // and Workspace wires it to openDocument(tab.path) → setActive →
    // refresh — same path the recents-click flow takes.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ids = ['t-a', 't-b'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() =>
      Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))),
    );
    // openDocument returns each tab's distinct html so we can assert the
    // swap is visible in the DOM.
    (ipc.openDocument as any).mockImplementation(async (path: string) => {
      const tabId = path.endsWith('t-a.md') ? 't-a' : 't-b';
      return {
        kind: 'document',
        tab_id: tabId,
        path,
        html: `<p data-test="doc-marker">${tabId} content</p>`,
        threads: [],
      };
    });
    const handle = await mountWorkspace(root, ipc);
    // Prime: open the first tab via the existing setActive path so the
    // workspace has a Document mounted before the user clicks the second.
    handle.setActive({
      kind: 'document',
      tab_id: 't-a',
      path: '/docs/t-a.md',
      html: '<p data-test="doc-marker">t-a content</p>',
      threads: [],
    });
    await handle.refresh();
    expect(root.querySelector('[data-test="doc-marker"]')!.textContent).toBe('t-a content');

    // User clicks the second tab.
    const tabs = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
    expect(tabs.length).toBe(2);
    tabs[1].click();
    await new Promise((r) => setTimeout(r, 10));

    expect(ipc.openDocument).toHaveBeenCalledWith('/docs/t-b.md');
    expect(root.querySelector('[data-test="doc-marker"]')!.textContent).toBe('t-b content');

    document.body.removeChild(root);
  });

  // Regression guard for the orphan-delete wiring. Previously
  // `OrphanComments` dispatched a bubbling `mdviewer:delete-thread` event
  // and called `onDeleteOrphan?.(id)`, but `Workspace` never supplied
  // `onDeleteOrphan` and nothing listened for the bubbling event, so the
  // Delete button confirmed and then silently did nothing. This test
  // drives the full wire end-to-end: mount workspace → seed an orphaned
  // thread → click Delete → assert `ipc.deleteThread` was called with
  // the right (tabId, threadId) and that the sidebar refreshed.
  it('clicking Delete on an orphan calls ipc.deleteThread and refreshes the sidebar', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const orphanedThread = {
      id: 'thr-orph',
      anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
      comments: [
        {
          id: 'c-1',
          author: 'U',
          color: '#000',
          body: 'note',
          created_at: '2026-04-28T00:00:00Z',
        },
      ],
      resolved: false,
      resolved_at: null,
      resolved_by: null,
    };

    const ipc = makeIpc(['t1']);
    // Seed the post-refresh thread list — after delete, the sidebar's
    // `refreshThreads` will call listThreads again. We toggle the return
    // value after deleteThread fires so the second call returns [].
    let threadsAfterDelete: typeof orphanedThread[] = [orphanedThread];
    (ipc.listThreads as any).mockImplementation(async () => threadsAfterDelete);
    (ipc.deleteThread as any).mockImplementation(async () => {
      threadsAfterDelete = [];
    });
    // `resolveAnchor` already returns `{ kind: 'orphan' }` in the fixture,
    // so the thread automatically lands in the orphan bucket.

    // OrphanComments uses window.confirm() — auto-accept so the click
    // proceeds to onDeleteOrphan.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't1',
      path: '/docs/x.md',
      html: '<p><span data-src-offset="0" data-src-end="5">Hello</span></p>',
      threads: [orphanedThread],
    });
    await handle.refresh();
    // mountDocument awaits resolveAnchor for each thread, then calls
    // onOrphansChanged which re-mounts the sidebar with the orphan card.
    // Give the microtask queue a couple of ticks to settle.
    await new Promise((r) => setTimeout(r, 30));

    const orphanCard = root.querySelector('[data-orphan-id="thr-orph"]');
    expect(orphanCard).toBeTruthy();
    const deleteBtn = orphanCard!.querySelector(
      '[data-action="delete"]',
    ) as HTMLButtonElement;
    deleteBtn.click();
    // Wait for confirm → ipc.deleteThread → refreshThreads chain.
    await new Promise((r) => setTimeout(r, 20));

    expect(confirmSpy).toHaveBeenCalled();
    expect(ipc.deleteThread).toHaveBeenCalledWith('t1', 'thr-orph');
    // Refresh fired — the second listThreads call landed (the first was
    // the initial mount, the second is post-delete).
    expect((ipc.listThreads as any).mock.calls.length).toBeGreaterThanOrEqual(2);

    confirmSpy.mockRestore();
    document.body.removeChild(root);
  });

  it('C2: refresh() calls the window-scoped list_open_documents with no client-supplied label', async () => {
    // Window identity is derived backend-side from the calling
    // `tauri::Window` arg (contract 02), so the JS side must NOT pass a
    // label. If a regression starts threading a label through from the
    // frontend, this catches it: the call must carry no positional argument.
    const root = document.createElement('div');
    const ipc = makeIpc(['t1']);
    const handle = await mountWorkspace(root, ipc);
    (ipc.listOpenDocuments as any).mockClear();
    await handle.refresh();
    expect(ipc.listOpenDocuments).toHaveBeenCalled();
    for (const call of (ipc.listOpenDocuments as any).mock.calls) {
      expect(call.length).toBe(0);
    }
  });

  it('C2: a received show-conflict event drives a window-scoped refresh', async () => {
    // Workspace reacts only to the addressed events it actually receives
    // (emit_to backend-side). Firing the captured `show-conflict` listener
    // must re-fetch this window's own tab list via list_open_documents.
    const root = document.createElement('div');
    const ipc = makeIpc(['t1']);
    await mountWorkspace(root, ipc);
    (ipc.listOpenDocuments as any).mockClear();
    const cbs = tauriListeners['show-conflict'] ?? [];
    expect(cbs.length).toBeGreaterThan(0);
    cbs[0]({
      payload: { tab_id: 't1', path: '/docs/t1.md', local: 'a', incoming: 'b' },
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.listOpenDocuments).toHaveBeenCalled();
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

  // Phase B implementation review fix #4: end-to-end coverage for the
  // save → SaveOutcome::Conflict → show-conflict event → Conflict view +
  // wireframe-07 banner flow. Catches regressions in either fix #1 (Rust
  // emits the event) or fix #2 (TS threads the source discriminator through
  // pendingConflict to mountConflict).
  it('routes a DriveApi save-conflict event to the Conflict view with the API banner', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc(['t-drive']));
    expect(tauriListeners['show-conflict']?.length ?? 0).toBeGreaterThan(0);

    // The Rust save_document handler emits this exact payload shape when
    // SaveOutcome::Conflict carries source: DriveApiEtag (Phase B fix #1).
    // A8 rename: the event field is `source` (was `drive_source` pre-A8);
    // the fallback was dropped in review-cycle-1, so this fixture pins the
    // new wire spelling.
    tauriListeners['show-conflict']![0]!({
      payload: {
        tab_id: 't-drive',
        path: 'drive-api://FID',
        local: 'my edits',
        incoming: 'remote edits',
        source: 'DriveApiEtag',
      },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();
    const banner = root.querySelector('.drive-banner');
    expect(banner).toBeTruthy();
    // Wireframe-07 API banner copy ("Someone else updated this Drive file").
    expect(banner?.textContent).toMatch(/Drive file/i);
    expect(banner?.textContent).toMatch(/Someone else/i);
    // The data attribute should round-trip the wire string so the
    // banner-copy switch can be exercised by selector in fidelity tests.
    expect(banner?.getAttribute('data-drive-source')).toBe('DriveApiEtag');
  });

  it('routes a DriveDesktop watcher conflict event to the Conflict view with the sync banner', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc(['t-desktop']));

    tauriListeners['show-conflict']![0]!({
      payload: {
        tab_id: 't-desktop',
        path: '/Users/me/Drive/notes.md',
        local: 'my edits',
        incoming: 'changed externally',
        source: 'DriveDesktopWatcher',
      },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();
    const banner = root.querySelector('.drive-banner');
    expect(banner).toBeTruthy();
    // Wireframe-07 sync-client copy must reference Drive Desktop + disk so a
    // user with both flavors knows which client touched the file.
    expect(banner?.textContent).toMatch(/Drive Desktop/i);
    expect(banner?.textContent).toMatch(/disk/i);
    expect(banner?.getAttribute('data-drive-source')).toBe('DriveDesktopWatcher');
  });

  it('omits the Drive banner when show-conflict carries no source', async () => {
    // Local-backend conflicts (mtime mismatch from open_document) emit the
    // same event without a source field — Conflict.ts must NOT render the
    // Drive-specific copy in that case.
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc(['t-1']));

    tauriListeners['show-conflict']![0]!({
      payload: {
        tab_id: 't-1',
        path: '/tmp/notes.md',
        local: 'l',
        incoming: 'r',
        // source intentionally omitted; Local-backend event payload shape.
      },
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();
    expect(root.querySelector('.drive-banner')).toBeNull();
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

  it('external-change "ask" renders an actionable reload banner (no merge)', async () => {
    // The no-unsaved-edits external-change path must offer a reload/keep
    // banner — NOT the 3-way merge. Clicking Reload pulls fresh content.
    const root = document.createElement('div');
    const ids: string[] = ['t-1'];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() =>
      Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))),
    );
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
      payload: { path: '/docs/x.md', kind: 'md', action: 'ask' },
    });
    await new Promise((r) => setTimeout(r, 5));

    // An actionable banner appears; no merge/conflict view is mounted.
    const banner = root.querySelector('[data-view="external-change"]');
    expect(banner).toBeTruthy();
    const reloadBtn = banner!.querySelector<HTMLButtonElement>('[data-action="reload"]');
    expect(reloadBtn).toBeTruthy();
    expect(root.querySelector('[data-view="conflict"]')).toBeNull();

    // Clicking Reload pulls in fresh content via reloadDocument.
    reloadBtn!.click();
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
    // C2 added drive_detect_dismissed to DocPref; the font-size persist
     // path preserves whatever the existing flag value was (false here, no
     // prior dismissal in this test).
    expect(ipc.setDocPref).toHaveBeenCalledWith('/docs/x.md', {
      font_size_px: 19,
      drive_detect_dismissed: false,
    });
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

describe('Workspace — comments-sidebar toggle', () => {
  async function mountDoc(ipc: Ipc): Promise<{ root: HTMLElement; body: HTMLElement; handle: any }> {
    const root = document.createElement('div');
    document.body.appendChild(root);
    (ipc.listOpenDocuments as any).mockResolvedValue([{ id: 't-1', path: '/docs/x.md' }]);
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    const body = root.querySelector<HTMLElement>('[data-region="body"]')!;
    return { root, body, handle };
  }

  it('starts visible — body has no data-sidebar attribute and the sidebar element is rendered', async () => {
    const ipc = makeIpc();
    const { body } = await mountDoc(ipc);
    expect(body.hasAttribute('data-sidebar')).toBe(false);
    expect(body.querySelector('[data-region="sidebar"]')).toBeTruthy();
    expect(body.querySelector('[data-view="sidebar-comments"]')).toBeTruthy();
  });

  it('mdviewer:toggle-sidebar flips data-sidebar="hidden" on the body region', async () => {
    const ipc = makeIpc();
    const { body } = await mountDoc(ipc);
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    expect(body.hasAttribute('data-sidebar')).toBe(false);
  });

  it('clicking the sidebar close button hides the sidebar', async () => {
    const ipc = makeIpc();
    const { root, body } = await mountDoc(ipc);
    const closeBtn = root.querySelector<HTMLButtonElement>('[data-test="sidebar-close"]');
    expect(closeBtn).toBeTruthy();
    closeBtn!.click();
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
  });

  it('mounts a floating "Show comments" button inside the body region', async () => {
    const ipc = makeIpc();
    const { body } = await mountDoc(ipc);
    const showBtn = body.querySelector('[data-test="sidebar-show"]');
    expect(showBtn).toBeTruthy();
    expect(showBtn!.getAttribute('aria-label')).toBe('Show comments sidebar');
  });

  it('clicking the floating "Show comments" button toggles the sidebar back open', async () => {
    const ipc = makeIpc();
    const { body } = await mountDoc(ipc);
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
    (body.querySelector('[data-test="sidebar-show"]') as HTMLButtonElement).click();
    expect(body.hasAttribute('data-sidebar')).toBe(false);
  });

  it('a new thread-created event auto-shows the sidebar even if it was hidden', async () => {
    const ipc = makeIpc();
    const { body } = await mountDoc(ipc);
    // Hide the sidebar first.
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
    // Document.ts dispatches `thread-created` (bubbling) on the docRoot
    // when a new comment is posted via the SelectionPopover composer.
    const docRoot = body.querySelector('[data-view="document"]')!;
    docRoot.dispatchEvent(new CustomEvent('thread-created', { bubbles: true }));
    // Listener is synchronous; refresh fires async but visibility flag flips
    // immediately.
    expect(body.hasAttribute('data-sidebar')).toBe(false);
  });

  it('sidebar visibility persists across a refresh()', async () => {
    const ipc = makeIpc();
    const { body, handle } = await mountDoc(ipc);
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
    await handle.refresh();
    // After refresh the body is re-built but the sidebar visibility flag
    // is in-session state on the closure, so it survives.
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
  });

  it('sidebar visibility persists across switching tabs', async () => {
    const ipc = makeIpc();
    const ids = ['t-a', 't-b'];
    (ipc.listOpenDocuments as any).mockImplementation(() =>
      Promise.resolve(ids.map((id) => ({ id, path: `/docs/${id}.md` }))),
    );
    (ipc.openDocument as any).mockImplementation(async (path: string) => ({
      kind: 'document',
      tab_id: path.endsWith('t-a.md') ? 't-a' : 't-b',
      path,
      html: '<p>hi</p>',
      threads: [],
    }));
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-a',
      path: '/docs/t-a.md',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    const body = root.querySelector<HTMLElement>('[data-region="body"]')!;
    expect(body.getAttribute('data-sidebar')).toBe('hidden');

    // Click the second tab — the body re-mounts but the flag survives.
    const tabs = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
    tabs[1].click();
    await new Promise((r) => setTimeout(r, 10));
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
  });

  it('updates the status-bar link preview on mdviewer:link-hover events', async () => {
    const ipc = makeIpc();
    const root = document.createElement('div');
    document.body.appendChild(root);
    await mountWorkspace(root, ipc);
    const preview = root.querySelector<HTMLElement>('[data-test="link-preview"]')!;
    expect(preview.textContent).toBe('');
    document.dispatchEvent(
      new CustomEvent('mdviewer:link-hover', { detail: { href: 'https://example.com/x' } }),
    );
    expect(preview.textContent).toBe('https://example.com/x');
    document.dispatchEvent(
      new CustomEvent('mdviewer:link-hover', { detail: { href: null } }),
    );
    expect(preview.textContent).toBe('');
  });

  it('toggle is a no-op when StartPage is mounted (no document, sidebar element absent)', async () => {
    const ipc = makeIpc();
    const root = document.createElement('div');
    document.body.appendChild(root);
    await mountWorkspace(root, ipc);
    const body = root.querySelector<HTMLElement>('[data-region="body"]')!;
    expect(body.querySelector('[data-region="sidebar"]')).toBeNull();
    // Listener still tracks the flag; it just has no visible effect because
    // there's no sidebar to hide. Toggling should not throw.
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    expect(body.getAttribute('data-sidebar')).toBe('hidden');
  });
});

describe('Workspace — Drive status pill (A8)', () => {
  it('mounts the Drive status pill in the status bar', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    const status = root.querySelector('[data-region="status"]')!;
    const pill = status.querySelector('[data-test="drive-status-pill"]');
    expect(pill).toBeTruthy();
    // The pill carries .drive-status-pill so app.css can target it.
    expect(pill!.classList.contains('drive-status-pill')).toBe(true);
  });

  it('subscribes to drive-status-changed events', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    expect(tauriListeners['drive-status-changed']?.length ?? 0).toBeGreaterThan(0);
  });

  it('updates the pill text when a drive-status-changed event fires (synced)', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    tauriListeners['drive-status-changed']![0]!({
      payload: {
        connected: true,
        account_email: 'alice@example.com',
        online: true,
        pending_count: 0,
      },
    });
    const pill = root.querySelector<HTMLElement>('[data-test="drive-status-pill"]')!;
    expect(pill.textContent).toMatch(/synced/i);
    expect(pill.dataset.connected).toBe('true');
    expect(pill.dataset.online).toBe('true');
  });

  it('reflects offline state with pending count', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    tauriListeners['drive-status-changed']![0]!({
      payload: {
        connected: true,
        account_email: 'alice@example.com',
        online: false,
        pending_count: 3,
      },
    });
    const pill = root.querySelector<HTMLElement>('[data-test="drive-status-pill"]')!;
    expect(pill.textContent).toMatch(/offline/i);
    expect(pill.textContent).toContain('3');
    expect(pill.dataset.online).toBe('false');
  });

  it('reflects pending uploads when online', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    tauriListeners['drive-status-changed']![0]!({
      payload: {
        connected: true,
        account_email: 'alice@example.com',
        online: true,
        pending_count: 5,
      },
    });
    const pill = root.querySelector<HTMLElement>('[data-test="drive-status-pill"]')!;
    expect(pill.textContent).toMatch(/pending/i);
    expect(pill.textContent).toContain('5');
  });

  it('shows "not connected" copy when DriveStatus.connected=false', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    tauriListeners['drive-status-changed']![0]!({
      payload: {
        connected: false,
        account_email: null,
        online: true,
        pending_count: 0,
      },
    });
    const pill = root.querySelector<HTMLElement>('[data-test="drive-status-pill"]')!;
    expect(pill.textContent).toMatch(/not connected/i);
    expect(pill.dataset.connected).toBe('false');
  });
});

// Branch-coverage gate (C5): three branches in Workspace.ts were uncovered
// after C5 removed the dead `if !feature_enabled` guards, dropping the
// branch denominator and exposing previously-tolerated low coverage:
//
//   - Lines 605-620: the `if (driveBacking)` chip-mount block in
//     remountSidebar — only fires when the active tab is Drive-backed.
//   - Lines 687-689: the catch arm of the `getDocPref` round-trip in the
//     tab-activation font-size hook — only fires when the IPC throws.
//
// These tests exercise both arms via the public mountWorkspace surface.
describe('Workspace — Drive-backed sidebar chip (C5 branch coverage)', () => {
  it('mounts a CollabChip in the sidebar header when the tab is Drive-backed (drive-api://)', async () => {
    // The drive-api:// path bypasses driveResolvePath's IPC entirely —
    // detectDriveBacking decodes the file_id from the URL and returns a
    // truthy backing, which steers remountSidebar into the chip-mount
    // branch (lines 605-620 in Workspace.ts).
    //
    // driveGetCollaborators still fires through the real ipc module and
    // throws because @tauri-apps/api/core's invoke isn't shimmed in
    // jsdom; the catch in detectDriveBacking yields an empty list and
    // the chip mounts with zero avatars. That's enough to cover the
    // chipHost insertion + mountCollabChip call branches without needing
    // a full IPC mock.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockResolvedValue([
      { id: 't-drive', path: 'drive-api://FID-123' },
    ]);
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-drive',
      path: 'drive-api://FID-123',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    // Two microtask turns let the CollabChip loader resolve and render.
    await Promise.resolve();
    await Promise.resolve();

    const sidebarHeader = root.querySelector('[data-region="sidebar-header"]');
    expect(sidebarHeader).toBeTruthy();
    // The chipHost <div> is appended by the if-driveBacking branch; the
    // mounted CollabChip exposes a .collab-chip class on its container.
    const chip = sidebarHeader!.querySelector('.collab-chip');
    expect(chip).toBeTruthy();

    document.body.removeChild(root);
  });

  it('does NOT mount a CollabChip when the tab is Local (no drive-api prefix, no resolve match)', async () => {
    // Negative branch: detectDriveBacking returns null for a plain on-disk
    // path because driveResolvePath rejects (no real Drive runtime), so
    // remountSidebar skips the chip block entirely. Pairing this against
    // the positive case above proves the if (driveBacking) gate flips both
    // ways under test rather than always-truthy / always-falsy.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockResolvedValue([
      { id: 't-local', path: '/docs/local.md' },
    ]);
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-local',
      path: '/docs/local.md',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    await Promise.resolve();
    await Promise.resolve();

    const sidebarHeader = root.querySelector('[data-region="sidebar-header"]');
    expect(sidebarHeader).toBeTruthy();
    expect(sidebarHeader!.querySelector('.collab-chip')).toBeNull();

    document.body.removeChild(root);
  });

  it('does NOT duplicate the CollabChip across multiple refresh() calls', async () => {
    // The branch guard inside the chip block also checks
    // `!sidebarHeader.querySelector('.collab-chip')` to avoid stacking
    // multiple chips when remountSidebar runs more than once. Two
    // back-to-back refreshes should leave exactly one chip behind.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockResolvedValue([
      { id: 't-drive', path: 'drive-api://FID-DUP' },
    ]);
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-drive',
      path: 'drive-api://FID-DUP',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    await Promise.resolve();
    await Promise.resolve();
    await handle.refresh();
    await Promise.resolve();
    await Promise.resolve();

    const chips = root.querySelectorAll('.collab-chip');
    expect(chips.length).toBe(1);

    document.body.removeChild(root);
  });
});

describe('Workspace — getDocPref failure path (C5 branch coverage)', () => {
  it('catches a getDocPref rejection on tab activation and clears the inline font override', async () => {
    // The font-size hook tries to read the per-doc preference and apply it
    // as `--doc-font-size`. When the IPC rejects (test/dev builds without
    // the doc-prefs handler, or a transient store error) the catch arm at
    // lines 687-689 wipes activeDocPref and removes any stale inline
    // property so the cascade falls back to the global default.
    document.documentElement.style.setProperty('--doc-font-size', '20px');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockResolvedValue([
      { id: 't-1', path: '/docs/x.md' },
    ]);
    (ipc.getDocPref as any).mockRejectedValue(new Error('store unavailable'));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();

    expect(ipc.getDocPref).toHaveBeenCalledWith('/docs/x.md');
    // The catch path removes the inline property regardless of what was
    // set before, so the readout falls back to the global default (14).
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('');
    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
    expect(readout.textContent).toBe('14');

    document.body.removeChild(root);
  });

  it('after a getDocPref failure, font-increase still mutates the inline override (no persisted pref to clamp against)', async () => {
    // Regression guard: when activeDocPref is null after the catch arm,
    // applyFontDelta should still operate on the cascade-default value
    // rather than no-op. Without this, a transient IPC error on tab
    // activation would freeze the font controls until the next reload.
    vi.useFakeTimers();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockResolvedValue([
      { id: 't-1', path: '/docs/x.md' },
    ]);
    (ipc.getDocPref as any).mockRejectedValue(new Error('store unavailable'));
    const handle = await mountWorkspace(root, ipc);
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('');

    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
    expect(document.documentElement.style.getPropertyValue('--doc-font-size')).toBe('15px');
    // Persist still attempts (per-doc path is valid), confirming the
    // post-catch state is workable rather than "stuck".
    vi.advanceTimersByTime(200);
    expect(ipc.setDocPref).toHaveBeenCalledTimes(1);

    document.documentElement.style.removeProperty('--doc-font-size');
    document.body.removeChild(root);
    vi.useRealTimers();
  });
});

describe('Workspace — File → "Open from remote…" menu wiring (B2)', () => {
  it('mounts the OpenRemoteDialog when the mdviewer:open-remote CustomEvent fires', async () => {
    // The menu-bridge layer (menuBridge.ts) translates the `menu-action`
    // Tauri event with payload `open-remote` into a `mdviewer:open-remote`
    // CustomEvent on document. Workspace listens for that and mounts the
    // dialog. We dispatch the CustomEvent directly so the test doesn't
    // have to plumb through the Tauri runtime — the bridge contract is
    // covered separately in tests/menuBridge.test.ts.
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      await mountWorkspace(root, makeIpc());
      expect(
        document.body.querySelector('[data-testid="open-remote-dialog"]'),
      ).toBeNull();
      document.dispatchEvent(new CustomEvent('mdviewer:open-remote'));
      expect(
        document.body.querySelector('[data-testid="open-remote-dialog"]'),
      ).toBeTruthy();
    } finally {
      // Cleanup so subsequent tests start with a clean body.
      document.body
        .querySelector('[data-testid="open-remote-dialog"]')
        ?.remove();
      document.body.removeChild(root);
    }
  });

  it('a second mdviewer:open-remote event after the dialog is dismissed re-mounts a fresh dialog', async () => {
    // Without proper close-on-Escape semantics the listener path can
    // either silently stack dialogs or, conversely, refuse to mount a
    // second one. Verify a sane "dismiss then reopen" cycle works.
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      await mountWorkspace(root, makeIpc());
      document.dispatchEvent(new CustomEvent('mdviewer:open-remote'));
      const first = document.body.querySelector(
        '[data-testid="open-remote-dialog"]',
      );
      expect(first).toBeTruthy();
      // Dismiss the dialog via Escape.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(
        document.body.querySelector('[data-testid="open-remote-dialog"]'),
      ).toBeNull();
      // Second menu click — must re-mount.
      document.dispatchEvent(new CustomEvent('mdviewer:open-remote'));
      const second = document.body.querySelector(
        '[data-testid="open-remote-dialog"]',
      );
      expect(second).toBeTruthy();
      // It's a fresh element, not the original.
      expect(second).not.toBe(first);
    } finally {
      document.body
        .querySelector('[data-testid="open-remote-dialog"]')
        ?.remove();
      document.body.removeChild(root);
    }
  });
});
