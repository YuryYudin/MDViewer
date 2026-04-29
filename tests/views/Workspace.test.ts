import { describe, it, expect, vi } from 'vitest';
import { mountWorkspace } from '../../src/views/Workspace';
import type { Ipc } from '../../src/ipc';

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
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    appInfo: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn(),
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
});
