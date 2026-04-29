import { describe, it, expect, vi } from 'vitest';
import { mountTabBar } from '../../src/views/TabBar';
import type { Ipc } from '../../src/ipc';
import type { WorkspaceState } from '../../src/views/Workspace';

function makeIpc(): Ipc {
  return {
    listOpenDocuments: vi.fn(),
    listRecents: vi.fn(),
    openDocument: vi.fn(),
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

describe('TabBar', () => {
  it('renders one tab per open document', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    const tabs = root.querySelectorAll('[data-test="tab"]');
    expect(tabs.length).toBe(2);
  });

  it('renders a + new-tab button', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = { tabs: [], activeId: null };
    mountTabBar(root, makeIpc(), state);
    expect(root.querySelector('[data-test="new-tab"]')).toBeTruthy();
  });

  it('uses textContent for tab labels (no markup injection)', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '<b>nope</b>.md' }],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    const tab = root.querySelector('[data-test="tab"]')!;
    expect(tab.querySelector('b')).toBeNull();
    expect(tab.textContent).toContain('<b>nope</b>.md');
  });

  it('dispatches activateTab on tab click', () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    const tabs = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
    tabs[1].click();
    expect(ipc.activateTab).toHaveBeenCalledWith('t2');
  });

  it('dispatches closeTab on X click and stops propagation', () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    const close = root.querySelector('[data-test="tab-close"]') as HTMLElement;
    close.click();
    expect(ipc.closeTab).toHaveBeenCalledWith('t1');
    expect(ipc.activateTab).not.toHaveBeenCalled();
  });

  it('new-tab + button dispatches mdviewer:open-file on document', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = { tabs: [], activeId: null };
    mountTabBar(root, makeIpc(), state);
    const handler = vi.fn();
    document.addEventListener('mdviewer:open-file', handler, { once: true });
    (root.querySelector('[data-test="new-tab"]') as HTMLElement).click();
    expect(handler).toHaveBeenCalled();
  });

  it('marks the active tab', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/a.md' },
        { id: 't2', path: '/b.md' },
      ],
      activeId: 't2',
    };
    mountTabBar(root, makeIpc(), state);
    const active = root.querySelector('[data-test="tab"][data-active="true"]');
    expect(active).toBeTruthy();
    expect(active!.textContent).toContain('/b.md');
  });
});
