import { describe, it, expect, vi } from 'vitest';
import { mountCommentsSidebar } from '../../src/views/CommentsSidebar';
import type { Ipc, Thread } from '../../src/ipc';

function ipcStub(): Ipc {
  return {
    listThreads: vi.fn().mockResolvedValue([]),
  } as unknown as Ipc;
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't-1',
    anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
    comments: [
      {
        id: 'c-1',
        author: 'Mira',
        color: '#c98a2b',
        body: 'First note',
        created_at: '2026-04-28T00:00:00Z',
      },
    ],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  } as Thread;
}

describe('CommentsSidebar', () => {
  it('mounts an empty-state when there are no threads', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(root, ipcStub(), [], { showResolved: false });
    expect(root.getAttribute('data-view')).toBe('sidebar-comments');
    expect(root.querySelector('[data-empty="true"]')).toBeTruthy();
    expect(root.textContent).toContain('No comments');
  });

  it('renders one entry per visible thread with the first comment body', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(
      root,
      ipcStub(),
      [thread({ id: 't-1' }), thread({ id: 't-2' })],
      { showResolved: true },
    );
    const items = root.querySelectorAll('[data-test="thread"]');
    expect(items.length).toBe(2);
    expect(items[0].getAttribute('data-thread-id')).toBe('t-1');
    expect(items[0].querySelector('[data-test="comment-body-rendered"]')!.textContent).toBe(
      'First note',
    );
  });

  it('hides resolved threads when showResolved is off', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(
      root,
      ipcStub(),
      [thread({ id: 't-1' }), thread({ id: 't-2', resolved: true })],
      { showResolved: false },
    );
    const items = root.querySelectorAll('[data-test="thread"]');
    expect(items.length).toBe(1);
    expect(items[0].getAttribute('data-thread-id')).toBe('t-1');
  });

  it('keeps resolved threads in the list when showResolved is on and tags them with the .resolved class', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(
      root,
      ipcStub(),
      [thread({ id: 't-2', resolved: true })],
      { showResolved: true },
    );
    const item = root.querySelector('[data-test="thread"]')!;
    expect(item.classList.contains('resolved')).toBe(true);
  });

  it('uses textContent for author and body so HTML cannot be injected', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(
      root,
      ipcStub(),
      [
        thread({
          comments: [
            {
              id: 'c-x',
              author: '<img src=x onerror=alert(1)>',
              color: '#000',
              body: '<script>bad()</script>',
              created_at: '2026-04-28T00:00:00Z',
            },
          ],
        }),
      ],
      { showResolved: false },
    );
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>bad()</script>');
  });

  it('dispatches a thread-activate event on click with the thread id', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(root, ipcStub(), [thread({ id: 't-7' })], { showResolved: false });
    const handler = vi.fn();
    root.addEventListener('thread-activate', handler as EventListener);
    (root.querySelector('[data-test="thread"]') as HTMLElement).click();
    expect(handler).toHaveBeenCalledTimes(1);
    const evt = handler.mock.calls[0][0] as CustomEvent<{ id: string }>;
    expect(evt.detail.id).toBe('t-7');
  });

  it('falls back to empty strings when a thread has no comments', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(
      root,
      ipcStub(),
      [thread({ id: 't-empty', comments: [] })],
      { showResolved: true },
    );
    const item = root.querySelector('[data-test="thread"]')!;
    expect(item.querySelector('[data-test="thread-author"]')!.textContent).toBe('');
    expect(item.querySelector('[data-test="comment-body-rendered"]')!.textContent).toBe('');
  });

  it('rerenders cleanly when called twice (no leftover entries)', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(root, ipcStub(), [thread({ id: 't-1' })], { showResolved: false });
    mountCommentsSidebar(root, ipcStub(), [], { showResolved: false });
    expect(root.querySelectorAll('[data-test="thread"]').length).toBe(0);
    expect(root.querySelector('[data-empty="true"]')).toBeTruthy();
  });

  describe('header + close button', () => {
    it('mounts a sidebar header with title + close button', () => {
      const root = document.createElement('div');
      mountCommentsSidebar(root, ipcStub(), [], { showResolved: false });
      const header = root.querySelector('[data-region="sidebar-header"]');
      expect(header).toBeTruthy();
      expect(header!.textContent).toContain('Comments');
      const close = header!.querySelector<HTMLButtonElement>('[data-test="sidebar-close"]');
      expect(close).toBeTruthy();
      expect(close!.getAttribute('aria-label')).toBe('Hide comments sidebar');
    });

    it('clicking the close button dispatches mdviewer:toggle-sidebar on document', () => {
      const root = document.createElement('div');
      mountCommentsSidebar(root, ipcStub(), [], { showResolved: false });
      const handler = vi.fn();
      document.addEventListener('mdviewer:toggle-sidebar', handler as EventListener, {
        once: true,
      });
      (root.querySelector('[data-test="sidebar-close"]') as HTMLElement).click();
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('the header survives a re-mount (close button remains reachable)', () => {
      const root = document.createElement('div');
      mountCommentsSidebar(root, ipcStub(), [thread({ id: 't-1' })], { showResolved: false });
      mountCommentsSidebar(root, ipcStub(), [thread({ id: 't-2' })], { showResolved: false });
      const closeButtons = root.querySelectorAll('[data-test="sidebar-close"]');
      expect(closeButtons.length).toBe(1);
    });
  });

  describe('orphan section', () => {
    it('mounts the orphan region above the thread list when orphans is non-empty', () => {
      const root = document.createElement('div');
      mountCommentsSidebar(
        root,
        ipcStub(),
        [thread({ id: 't-1' })],
        { showResolved: false, orphans: [thread({ id: 't-orph' })] },
      );
      const orphans = root.querySelector('[data-region="orphans"]');
      expect(orphans).toBeTruthy();
      expect(orphans!.querySelector('[data-orphan-id="t-orph"]')).toBeTruthy();
      // Orphan region must precede the regular thread items in DOM order.
      const orphanIdx = Array.from(root.children).indexOf(orphans as Element);
      const firstThread = root.querySelector('[data-test="thread"]') as Element;
      const threadIdx = Array.from(root.children).indexOf(firstThread);
      expect(orphanIdx).toBeLessThan(threadIdx);
    });

    it('does not mount the orphan region when orphans is empty or undefined', () => {
      const root = document.createElement('div');
      mountCommentsSidebar(root, ipcStub(), [thread({ id: 't-1' })], {
        showResolved: false,
        orphans: [],
      });
      expect(root.querySelector('[data-region="orphans"]')).toBeNull();
    });

    it('Relocate click on an orphan dispatches mdviewer:relocate-orphan and calls onRelocateOrphan', () => {
      const root = document.createElement('div');
      const onRelocateOrphan = vi.fn();
      const handler = vi.fn();
      root.addEventListener('mdviewer:relocate-orphan', handler as EventListener);
      mountCommentsSidebar(root, ipcStub(), [], {
        showResolved: false,
        orphans: [thread({ id: 't-r' })],
        onRelocateOrphan,
      });
      (root.querySelector('[data-action="relocate"]') as HTMLButtonElement).click();
      expect(onRelocateOrphan).toHaveBeenCalledWith('t-r');
      expect(handler).toHaveBeenCalledTimes(1);
      const evt = handler.mock.calls[0][0] as CustomEvent<{ id: string }>;
      expect(evt.detail.id).toBe('t-r');
    });

    it('Delete click on an orphan dispatches mdviewer:delete-thread when confirmed', () => {
      const root = document.createElement('div');
      const originalConfirm = window.confirm;
      window.confirm = (() => true) as typeof window.confirm;
      try {
        const onDeleteOrphan = vi.fn();
        const handler = vi.fn();
        root.addEventListener('mdviewer:delete-thread', handler as EventListener);
        mountCommentsSidebar(root, ipcStub(), [], {
          showResolved: false,
          orphans: [thread({ id: 't-d' })],
          onDeleteOrphan,
        });
        (root.querySelector('[data-action="delete"]') as HTMLButtonElement).click();
        expect(onDeleteOrphan).toHaveBeenCalledWith('t-d');
        expect(handler).toHaveBeenCalledTimes(1);
      } finally {
        window.confirm = originalConfirm;
      }
    });

    it('Keep click on an orphan calls onKeepOrphan', () => {
      const root = document.createElement('div');
      const onKeepOrphan = vi.fn();
      mountCommentsSidebar(root, ipcStub(), [], {
        showResolved: false,
        orphans: [thread({ id: 't-k' })],
        onKeepOrphan,
      });
      (root.querySelector('[data-action="keep"]') as HTMLButtonElement).click();
      expect(onKeepOrphan).toHaveBeenCalledWith('t-k');
    });
  });
});
