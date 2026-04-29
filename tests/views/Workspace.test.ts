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
  const recents = ['/docs/r1.md', '/docs/r2.md'];
  return {
    listOpenDocuments: vi.fn().mockResolvedValue(openIds),
    listRecents: vi.fn().mockResolvedValue(recents),
    openDocument: vi
      .fn()
      .mockResolvedValue({ kind: 'document', tab_id: 't1', path: '/x', html: '', threads: [] }),
    closeTab: vi.fn().mockResolvedValue(undefined),
    activateTab: vi.fn().mockResolvedValue(undefined),
    getSettings: vi.fn().mockResolvedValue({
      comments: { show_resolved: false, sidecar_pattern: '{name}.md.comments.json', reattachment_confidence: 75, auto_merge: 'manual' },
      editor: {},
    }),
    setSettings: vi.fn(),
    listThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    appInfo: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn().mockResolvedValue({ kind: 'orphan' }),
    saveDocument: vi.fn().mockResolvedValue(undefined),
    setDirty: vi.fn().mockResolvedValue(undefined),
    diffMd: vi.fn().mockResolvedValue([
      { kind: 'conflicting', local_text: 'l', incoming_text: 'r', local_range: [0, 1], incoming_range: [0, 1] },
    ]),
    exportDocument: vi.fn(),
  } as unknown as Ipc;
}

describe('Workspace', () => {
  it('mounts the workspace shell with all four regions', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, makeIpc());
    expect(root.querySelector('[data-view="workspace"]')).toBeTruthy();
    expect(root.querySelector('[data-region="titlebar"]')).toBeTruthy();
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

  it('refresh() picks up new tabs and replaces StartPage with Document', async () => {
    const root = document.createElement('div');
    let ids: string[] = [];
    const ipc = makeIpc();
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids));
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
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids));
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
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids));
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
    (ipc.listOpenDocuments as any).mockImplementation(() => Promise.resolve(ids));
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
