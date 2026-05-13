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
    // Path is a basename to dodge the `/` inside the HTML tag, which
    // would otherwise look like a directory separator to basename().
    // The point of this test is that the rendered DOM has no <b> child.
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '<b>nope<-b>.md' }],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    const tab = root.querySelector('[data-test="tab"]')!;
    expect(tab.querySelector('b')).toBeNull();
    expect(tab.textContent).toContain('<b>nope<-b>.md');
  });

  it('shows the file basename as the label, not the opaque tab id', () => {
    // Regression: list_open_documents used to return bare ids and
    // Workspace.ts mapped `path: id`, so the tab strip showed the UUID
    // instead of the filename. The fix: IPC now returns {id, path} and
    // TabBar renders basename(path).
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [
        {
          id: 'tab-uuid-abcdef-12345',
          path: '/Users/x/notes/2026-04-29/Compute Permissions.md',
        },
      ],
      activeId: 'tab-uuid-abcdef-12345',
    };
    mountTabBar(root, makeIpc(), state);
    const label = root.querySelector('.tab-label')!.textContent;
    expect(label).toBe('Compute Permissions.md');
    // Full path is preserved as a tooltip so the user can recover the
    // location on hover.
    expect(root.querySelector<HTMLElement>('[data-test="tab"]')!.title).toBe(
      '/Users/x/notes/2026-04-29/Compute Permissions.md',
    );
  });

  it('renders bare basenames when path has no directory separator', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: 'standalone.md' }],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    expect(root.querySelector('.tab-label')!.textContent).toBe('standalone.md');
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

  it('fires onAfterClose after closeTab so the workspace can repaint', async () => {
    // Regression: clicking × removed the tab on the Rust side but the
    // tab strip never repainted because the workspace had no signal to
    // re-run refresh(). Without this hook the tab stayed visible.
    const root = document.createElement('div');
    const ipc = makeIpc();
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    const onAfterClose = vi.fn();
    mountTabBar(root, ipc, state, { onAfterClose });
    (root.querySelector('[data-test="tab-close"]') as HTMLElement).click();
    // Drain the microtask queue so the async closeTab → onAfterClose
    // chain has a chance to settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.closeTab).toHaveBeenCalledWith('t1');
    expect(onAfterClose).toHaveBeenCalled();
  });

  it('fires onActivate (NOT activateTab) on tab click — host owns the doc swap', async () => {
    // Regression: clicking another tab called ipc.activateTab(id) which
    // updates Rust's active id but does NOT refresh the host's cached
    // document payload. The host has to re-load the doc (typically via
    // ipc.openDocument(path) which both activates the tab and returns
    // its OpenResult). Without this, the rendered HTML stayed at the
    // previously-active tab and the click appeared to do nothing.
    const root = document.createElement('div');
    const ipc = makeIpc();
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    const onActivate = vi.fn();
    mountTabBar(root, ipc, state, { onActivate });
    const tabs = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
    tabs[1].click();
    await Promise.resolve();
    await Promise.resolve();
    expect(onActivate).toHaveBeenCalledWith({ id: 't2', path: '/docs/b.md' });
    // ipc.activateTab is NOT called from TabBar when onActivate is
    // provided — the host owns the activation flow (typically via
    // openDocument which activates as a side-effect).
    expect(ipc.activateTab).not.toHaveBeenCalled();
  });

  it('falls back to ipc.activateTab when no onActivate callback is provided', async () => {
    // Defensive: without a host wiring (e.g. unit tests that exercise
    // just the dispatch), TabBar still calls activateTab so behavior
    // doesn't silently break.
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
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.activateTab).toHaveBeenCalledWith('t2');
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
    // Label is the basename — the full path is reachable via the title attribute.
    expect(active!.textContent).toContain('b.md');
  });

  describe('dirty indicator', () => {
    it('renders .tab-dirty as first child with hidden set from getDirtyState', () => {
      const root = document.createElement('div');
      const state: WorkspaceState = {
        tabs: [
          { id: 't1', path: '/clean.md' },
          { id: 't2', path: '/dirty.md' },
        ],
        activeId: 't1',
      };
      const getDirtyState = (path: string): boolean => path === '/dirty.md';
      mountTabBar(root, makeIpc(), state, { getDirtyState });
      const pills = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
      expect(pills.length).toBe(2);
      expect(pills[0].firstElementChild?.classList.contains('tab-dirty')).toBe(true);
      expect(pills[0].firstElementChild?.getAttribute('data-testid')).toBe('tab-dirty');
      expect(pills[0].firstElementChild?.hasAttribute('hidden')).toBe(true);
      expect(pills[1].firstElementChild?.classList.contains('tab-dirty')).toBe(true);
      expect(pills[1].firstElementChild?.hasAttribute('hidden')).toBe(false);
    });

    it('carries data-path attribute on each pill', () => {
      const root = document.createElement('div');
      const state: WorkspaceState = {
        tabs: [{ id: 't1', path: 'C:\\Users\\x\\a.md' }],
        activeId: 't1',
      };
      mountTabBar(root, makeIpc(), state, { getDirtyState: () => false });
      const pill = root.querySelector<HTMLElement>('[data-test="tab"]');
      expect(pill?.dataset.path).toBe('C:\\Users\\x\\a.md');
    });

    it('toggles hidden on matching pill when mdviewer:tab-dirty event fires (incl. CSS-special paths)', () => {
      const root = document.createElement('div');
      const pathWithSpecials = '/some path/[v1.0]:file.md';
      const registry = new Map<string, boolean>();
      const getDirtyState = (p: string): boolean => registry.get(p) === true;
      const setTabDirty = (p: string, dirty: boolean): void => {
        if (dirty) registry.set(p, true);
        else registry.delete(p);
      };
      const state: WorkspaceState = {
        tabs: [{ id: 't1', path: pathWithSpecials }],
        activeId: 't1',
      };
      mountTabBar(root, makeIpc(), state, { getDirtyState, setTabDirty });
      document.dispatchEvent(
        new CustomEvent('mdviewer:tab-dirty', {
          detail: { path: pathWithSpecials, dirty: true },
        }),
      );
      const pill = root.querySelector<HTMLElement>('[data-test="tab"]');
      expect(pill?.firstElementChild?.hasAttribute('hidden')).toBe(false);
      expect(registry.get(pathWithSpecials)).toBe(true);
      document.dispatchEvent(
        new CustomEvent('mdviewer:tab-dirty', {
          detail: { path: pathWithSpecials, dirty: false },
        }),
      );
      expect(pill?.firstElementChild?.hasAttribute('hidden')).toBe(true);
      expect(registry.has(pathWithSpecials)).toBe(false);
    });

    it('preserves dirty state across tab-bar re-renders by reading the registry', () => {
      const root = document.createElement('div');
      const registry = new Map<string, boolean>();
      const getDirtyState = (p: string): boolean => registry.get(p) === true;
      const setTabDirty = (p: string, dirty: boolean): void => {
        if (dirty) registry.set(p, true);
        else registry.delete(p);
      };
      registry.set('/a.md', true);
      const state1: WorkspaceState = {
        tabs: [{ id: 't1', path: '/a.md' }],
        activeId: 't1',
      };
      mountTabBar(root, makeIpc(), state1, { getDirtyState, setTabDirty });
      // Re-render with another tab added — the existing dirty state must
      // be reflected on /a.md's pill from the registry.
      const state2: WorkspaceState = {
        tabs: [
          { id: 't1', path: '/a.md' },
          { id: 't2', path: '/b.md' },
        ],
        activeId: 't1',
      };
      mountTabBar(root, makeIpc(), state2, { getDirtyState, setTabDirty });
      const pillA = Array.from(root.querySelectorAll<HTMLElement>('[data-test="tab"]')).find(
        (p) => p.dataset.path === '/a.md',
      );
      const pillB = Array.from(root.querySelectorAll<HTMLElement>('[data-test="tab"]')).find(
        (p) => p.dataset.path === '/b.md',
      );
      expect(pillA?.firstElementChild?.hasAttribute('hidden')).toBe(false);
      expect(pillB?.firstElementChild?.hasAttribute('hidden')).toBe(true);
    });
  });
});
