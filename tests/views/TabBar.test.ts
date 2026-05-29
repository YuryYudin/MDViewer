import { describe, it, expect, vi } from 'vitest';
import { mountTabBar } from '../../src/views/TabBar';
import type { Ipc, WindowSummary } from '../../src/ipc';
import type { WorkspaceState } from '../../src/views/Workspace';

// E1: the Move-to-Window submenu excludes the CURRENT window. TabBar resolves
// the current label via `getCurrentWindow().label` (guarded for jsdom). Mock
// the window API so the current label is deterministic in unit tests.
const currentWindow = { label: 'main' };
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => currentWindow,
}));

function makeIpc(overrides?: Partial<Ipc>): Ipc {
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
    openInNewWindow: vi.fn().mockResolvedValue(undefined),
    // E1: defaults — two windows (current `main` + a `win-b` target), and a
    // resolving move. Individual tests override via `overrides`.
    listWindows: vi.fn().mockResolvedValue([
      { label: 'main', active_doc_name: 'a.md', tab_count: 1, focused: true },
      { label: 'win-b', active_doc_name: 'report.md', tab_count: 1, focused: false },
    ] satisfies WindowSummary[]),
    moveTab: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Ipc;
}

/**
 * Drain the task + microtask queues for the async submenu population to
 * settle. `populateMoveToWindow` awaits `import('@tauri-apps/api/window')`
 * which resolves on a macrotask, so a microtask-only flush is not enough.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
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

  // -------------------------------------------------------------------
  // D2: per-tab right-click context menu (wireframe 02-tab-context-menu)
  // -------------------------------------------------------------------

  function rightClick(el: HTMLElement): void {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  }

  it('opens an in-DOM context menu on right-click of a tab', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    // No menu before the right-click.
    expect(root.querySelector('[data-test="tab-context-menu"]')).toBeNull();

    rightClick(root.querySelectorAll<HTMLElement>('[data-test="tab"]')[1]);

    const menu = root.querySelector('[data-test="tab-context-menu"]');
    expect(menu).toBeTruthy();
    expect(menu!.querySelector('[data-test="ctx-open-new-window"]')).toBeTruthy();
    expect(menu!.querySelector('[data-test="ctx-move-to-window"]')).toBeTruthy();
    expect(menu!.querySelector('[data-test="ctx-close"]')).toBeTruthy();
  });

  it('renders the Move to Window submenu container on right-click', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    const submenu = root.querySelector('[data-test="move-to-window-submenu"]');
    expect(submenu).toBeTruthy();
  });

  it('preventDefault is called on contextmenu so the OS menu does not appear', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    root.querySelector<HTMLElement>('[data-test="tab"]')!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Open in New Window RELOCATES (detaches) the tab via detach_tab and dismisses the menu', async () => {
    const root = document.createElement('div');
    // A tab is an already-open doc; under one-owner, open_in_new_window would
    // merely focus the existing window. "Open in New Window" must detach the
    // tab into a brand-new window instead (wireframe 02 / G2 S2).
    const ipc = makeIpc({ detachTab: vi.fn().mockResolvedValue(undefined) });
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    rightClick(root.querySelectorAll<HTMLElement>('[data-test="tab"]')[1]);
    (root.querySelector('[data-test="ctx-open-new-window"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.detachTab).toHaveBeenCalledWith('t2');
    expect(ipc.openInNewWindow).not.toHaveBeenCalled();
    // Activating an item dismisses the menu.
    expect(root.querySelector('[data-test="tab-context-menu"]')).toBeNull();
  });

  it('Close in the context menu calls closeTab and fires onAfterClose', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    const onAfterClose = vi.fn();
    mountTabBar(root, ipc, state, { onAfterClose });
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    (root.querySelector('[data-test="ctx-close"]') as HTMLElement).click();
    await Promise.resolve();
    await Promise.resolve();
    expect(ipc.closeTab).toHaveBeenCalledWith('t1');
    expect(onAfterClose).toHaveBeenCalled();
    expect(root.querySelector('[data-test="tab-context-menu"]')).toBeNull();
  });

  it('dismisses the context menu on an outside click', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    expect(root.querySelector('[data-test="tab-context-menu"]')).toBeTruthy();
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(root.querySelector('[data-test="tab-context-menu"]')).toBeNull();
    root.remove();
  });

  it('re-opening the context menu on another tab replaces the prior menu', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    const tabs = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
    rightClick(tabs[0]);
    rightClick(tabs[1]);
    // Only a single menu is mounted at a time.
    expect(root.querySelectorAll('[data-test="tab-context-menu"]').length).toBe(1);
  });

  // -------------------------------------------------------------------
  // E1: Move to Window submenu — populate from list_windows (S4)
  // (wireframe 03-move-to-window-submenu)
  // -------------------------------------------------------------------

  it('populates the submenu with only OTHER windows (current excluded), labeled by active_doc_name', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      listWindows: vi.fn().mockResolvedValue([
        { label: 'main', active_doc_name: 'a.md', tab_count: 1, focused: true },
        { label: 'win-b', active_doc_name: 'report.md', tab_count: 1, focused: false },
        { label: 'win-c', active_doc_name: 'notes.md', tab_count: 2, focused: false },
      ] satisfies WindowSummary[]),
    });
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    await settle();

    const targets = root.querySelectorAll<HTMLElement>(
      '[data-test="move-to-window-submenu"] [data-test="move-target"]',
    );
    // The current window (`main`) is excluded — only win-b and win-c remain.
    expect(targets.length).toBe(2);
    const labels = Array.from(targets).map((t) => t.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(['report.md', 'notes.md']));
    // The current window must NOT appear as a move target.
    const targetWindowLabels = Array.from(targets).map((t) =>
      t.getAttribute('data-window-label'),
    );
    expect(targetWindowLabels).not.toContain('main');
    expect(targetWindowLabels).toEqual(expect.arrayContaining(['win-b', 'win-c']));
    expect(ipc.listWindows).toHaveBeenCalled();
  });

  it('uses a placeholder label for a target window with no active document', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      listWindows: vi.fn().mockResolvedValue([
        { label: 'main', active_doc_name: 'a.md', tab_count: 1, focused: true },
        { label: 'win-b', active_doc_name: null, tab_count: 0, focused: false },
      ] satisfies WindowSummary[]),
    });
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    await settle();

    const target = root.querySelector<HTMLElement>(
      '[data-test="move-to-window-submenu"] [data-test="move-target"]',
    );
    expect(target).toBeTruthy();
    // A placeholder (non-empty) label stands in for the empty window so the
    // row is still pickable and not blank.
    expect(target!.textContent?.trim().length).toBeGreaterThan(0);
    expect(target!.getAttribute('data-window-label')).toBe('win-b');
  });

  it('picking a target invokes moveTab(tabId, targetLabel) and dismisses the menu', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc();
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    await settle();

    const target = root.querySelector<HTMLElement>(
      '[data-test="move-target"][data-window-label="win-b"]',
    )!;
    target.click();
    await settle();

    expect(ipc.moveTab).toHaveBeenCalledWith('t1', 'win-b');
    // Picking a target dismisses the menu.
    expect(root.querySelector('[data-test="tab-context-menu"]')).toBeNull();
  });

  it('a move_tab rejection toasts the error and refreshes (no crash)', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      moveTab: vi.fn().mockRejectedValue(new Error('unknown tab')),
    });
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    const onAfterClose = vi.fn();
    const toast = vi.fn();
    document.addEventListener('mdviewer:toast', toast);
    mountTabBar(root, ipc, state, { onAfterClose });
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    await settle();

    const target = root.querySelector<HTMLElement>(
      '[data-test="move-target"][data-window-label="win-b"]',
    )!;
    target.click();
    await settle();

    expect(ipc.moveTab).toHaveBeenCalledWith('t1', 'win-b');
    // The rejection surfaces a toast …
    expect(toast).toHaveBeenCalled();
    const detail = (toast.mock.calls[0][0] as CustomEvent).detail;
    expect(detail.level).toBe('error');
    expect(String(detail.message)).toContain('unknown tab');
    // … and refreshes the source strip so the UI matches backend truth.
    expect(onAfterClose).toHaveBeenCalled();
    document.removeEventListener('mdviewer:toast', toast);
  });

  it('disables the Move to Window item when only one window is open', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      listWindows: vi.fn().mockResolvedValue([
        { label: 'main', active_doc_name: 'a.md', tab_count: 1, focused: true },
      ] satisfies WindowSummary[]),
    });
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    await settle();

    const moveItem = root.querySelector<HTMLElement>('[data-test="ctx-move-to-window"]')!;
    expect(moveItem.getAttribute('aria-disabled')).toBe('true');
    expect(moveItem.classList.contains('disabled')).toBe(true);
    // No move targets when there is nowhere to move to.
    expect(
      root.querySelectorAll('[data-test="move-to-window-submenu"] [data-test="move-target"]')
        .length,
    ).toBe(0);
  });

  it('disables the Move to Window item when list_windows rejects (no crash)', async () => {
    const root = document.createElement('div');
    const ipc = makeIpc({
      listWindows: vi.fn().mockRejectedValue(new Error('enumeration failed')),
    });
    const state: WorkspaceState = {
      tabs: [{ id: 't1', path: '/docs/a.md' }],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    rightClick(root.querySelector<HTMLElement>('[data-test="tab"]')!);
    await settle();

    const moveItem = root.querySelector<HTMLElement>('[data-test="ctx-move-to-window"]')!;
    expect(moveItem.getAttribute('aria-disabled')).toBe('true');
    expect(
      root.querySelectorAll('[data-test="move-to-window-submenu"] [data-test="move-target"]')
        .length,
    ).toBe(0);
  });

  // -------------------------------------------------------------------
  // G1: drag a tab off the strip to detach (wireframe 05-drag-detach, S10)
  // -------------------------------------------------------------------

  /**
   * Stamp a deterministic bounding rect on the tab strip so the dragend
   * handler can decide "clear of the strip" vs "inside the strip" without a
   * real layout pass (jsdom doesn't compute geometry).
   */
  function stubStripRect(root: HTMLElement, rect: Partial<DOMRect>): void {
    const strip = root.querySelector<HTMLElement>('[data-test="tabbar"]')!;
    const full: DOMRect = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 40,
      width: 300,
      height: 40,
      toJSON: () => ({}),
      ...rect,
    } as DOMRect;
    strip.getBoundingClientRect = () => full;
  }

  function fireDragEnd(tab: HTMLElement, clientX: number, clientY: number): void {
    // jsdom has no DragEvent ctor; a MouseEvent carries clientX/clientY which
    // is all the dragend handler reads. Name it 'dragend' so the listener fires.
    const ev = new MouseEvent('dragend', { bubbles: true, clientX, clientY });
    tab.dispatchEvent(ev);
  }

  it('marks tabs draggable', () => {
    const root = document.createElement('div');
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, makeIpc(), state);
    const tabs = root.querySelectorAll<HTMLElement>('[data-test="tab"]');
    expect(tabs.length).toBe(2);
    for (const tab of Array.from(tabs)) {
      expect(tab.draggable).toBe(true);
    }
  });

  it('S10: dragend CLEAR of the strip rect detaches the tab into a new window', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc({ detachTab: vi.fn().mockResolvedValue(undefined) });
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    // Strip occupies 0,0 → 300,40.
    stubStripRect(root, { left: 0, top: 0, right: 300, bottom: 40 });
    const tab = root.querySelectorAll<HTMLElement>('[data-test="tab"]')[1];
    // Release well below the strip — clear of its bounding rect.
    fireDragEnd(tab, 150, 400);
    expect(ipc.detachTab).toHaveBeenCalledWith('t2');
    root.remove();
  });

  it('S10: dragend INSIDE the strip rect is a no-op (no detach, no reorder)', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const ipc = makeIpc({ detachTab: vi.fn().mockResolvedValue(undefined) });
    const state: WorkspaceState = {
      tabs: [
        { id: 't1', path: '/docs/a.md' },
        { id: 't2', path: '/docs/b.md' },
      ],
      activeId: 't1',
    };
    mountTabBar(root, ipc, state);
    stubStripRect(root, { left: 0, top: 0, right: 300, bottom: 40 });
    const tab = root.querySelectorAll<HTMLElement>('[data-test="tab"]')[1];
    // Release inside the strip's rect — a no-op (intra-strip drag).
    fireDragEnd(tab, 120, 20);
    expect(ipc.detachTab).not.toHaveBeenCalled();
    root.remove();
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
});
