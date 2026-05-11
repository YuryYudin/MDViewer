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
    // `data-view='sidebar-comments'` now lives on an inner scroll host so the
    // outer `[data-region='sidebar']` rule's `overflow: hidden` doesn't beat
    // the inner `overflow: auto` on specificity (see CommentsSidebar.ts).
    expect(root.querySelector('[data-view="sidebar-comments"]')).toBeTruthy();
    expect(root.querySelector('[data-empty="true"]')).toBeTruthy();
    expect(root.textContent).toContain('No comments');
  });

  // Regression guard for the "no scrollbar" bug: when `[data-view=
  // sidebar-comments]` was on the same element as `[data-region=sidebar]`,
  // the outer selector's `overflow: hidden` beat the inner `overflow: auto`
  // on specificity and the sidebar silently clipped overflowing content.
  // The fix mounts a dedicated scroll host as a child; ALL sidebar content
  // (header, counts, orphans, threads) must live inside it so it actually
  // becomes the scroll container.
  it('mounts header, counts, and threads inside the scroll-host child of root', () => {
    const root = document.createElement('div');
    mountCommentsSidebar(
      root,
      ipcStub(),
      [thread({ id: 't-a' }), thread({ id: 't-b' })],
      { showResolved: false, orphans: [thread({ id: 't-orph' })] },
    );
    const scrollHost = root.querySelector('[data-view="sidebar-comments"]');
    expect(scrollHost).toBeTruthy();
    // The scroll host must be a direct child of root (not root itself) so
    // the outer-element CSS rule and the inner-content CSS rule apply to
    // separate nodes.
    expect(scrollHost!.parentElement).toBe(root);
    expect(root.children.length).toBe(1);
    expect(root.firstElementChild).toBe(scrollHost);
    // Everything the user sees in the sidebar must be inside the scroll
    // host so that scroll host's `overflow: auto` actually scrolls it.
    expect(scrollHost!.querySelector('[data-region="sidebar-header"]')).toBeTruthy();
    expect(scrollHost!.querySelector('[data-region="thread-counts"]')).toBeTruthy();
    expect(scrollHost!.querySelector('[data-region="orphans"]')).toBeTruthy();
    expect(scrollHost!.querySelectorAll('[data-test="thread"]').length).toBe(2);
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
      // Everything is mounted inside the `[data-view='sidebar-comments']`
      // scroll host (so the parent's `overflow: hidden` doesn't suppress
      // scrolling), so traverse one level down.
      const scrollHost = root.querySelector('[data-view="sidebar-comments"]') as Element;
      const orphanIdx = Array.from(scrollHost.children).indexOf(orphans as Element);
      const firstThread = root.querySelector('[data-test="thread"]') as Element;
      const threadIdx = Array.from(scrollHost.children).indexOf(firstThread);
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

  // B6: Pending pill — thread-level state derived from comments without a
  // drive_id. We render once per thread (next to the header), not per
  // comment, so a multi-comment thread with one pending comment shows a
  // single pill. The pill is only rendered when the active backend is a
  // Drive backend; pure local docs never have Drive ids and a "Pending"
  // chip there would be nonsense.
  describe('Pending pill', () => {
    it('renders on a thread whose only comment lacks a drive_id (drive backend)', () => {
      const root = document.createElement('div');
      const t = thread({
        id: 'L1',
        comments: [
          {
            id: 'L1-c1',
            author: 'Mira',
            color: '#000',
            body: 'first',
            created_at: '2026-04-30T00:00:00Z',
            drive_id: null,
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_desktop',
      });
      expect(root.querySelector('.thread .pending-pill')).toBeTruthy();
    });

    it('omits the pill once every comment has a drive_id', () => {
      const root = document.createElement('div');
      const t = thread({
        id: 'L1',
        comments: [
          {
            id: 'L1-c1',
            author: 'Mira',
            color: '#000',
            body: 'first',
            created_at: '2026-04-30T00:00:00Z',
            drive_id: 'DID-1',
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_desktop',
      });
      expect(root.querySelector('.thread .pending-pill')).toBeFalsy();
    });

    it('omits the pill on Local-backend tabs even when drive_id is null', () => {
      // Local docs never round-trip through Drive — a "Pending" chip there
      // would be nonsense. The pill is opt-in via the backend prop.
      const root = document.createElement('div');
      const t = thread({
        id: 'L1',
        comments: [
          {
            id: 'L1-c1',
            author: 'Mira',
            color: '#000',
            body: 'first',
            created_at: '2026-04-30T00:00:00Z',
            drive_id: null,
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'local',
      });
      expect(root.querySelector('.thread .pending-pill')).toBeFalsy();
    });

    it('renders one pill per thread, not one per pending comment', () => {
      const root = document.createElement('div');
      const t = thread({
        id: 'L1',
        comments: [
          {
            id: 'L1-c1',
            author: 'Mira',
            color: '#000',
            body: 'first',
            created_at: '2026-04-30T00:00:00Z',
            drive_id: null,
          },
          {
            id: 'L1-c2',
            author: 'Iris',
            color: '#111',
            body: 'reply',
            created_at: '2026-04-30T00:01:00Z',
            drive_id: null,
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_api',
      });
      const pills = root.querySelectorAll('.thread .pending-pill');
      expect(pills.length).toBe(1);
    });

    it('renders the pill when at least one comment in the thread is pending (mixed)', () => {
      // A thread where the parent comment landed but a reply hasn't yet
      // is still "Pending" — the pill reflects thread-level state.
      const root = document.createElement('div');
      const t = thread({
        id: 'L1',
        comments: [
          {
            id: 'L1-c1',
            author: 'Mira',
            color: '#000',
            body: 'parent',
            created_at: '2026-04-30T00:00:00Z',
            drive_id: 'DID-1',
          },
          {
            id: 'L1-c2',
            author: 'Iris',
            color: '#111',
            body: 'reply',
            created_at: '2026-04-30T00:01:00Z',
            drive_id: null,
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_desktop',
      });
      expect(root.querySelector('.thread .pending-pill')).toBeTruthy();
    });
  });

  // C1: thread-author avatars sourced from the active tab's collaborator list.
  // Drive Comments don't carry rich author metadata — the comment record only
  // has the email — so we look up the matching DriveCollaborator and render
  // the same initials chip the CollabChip uses in the sidebar header.
  describe('thread-author avatars (Drive backend)', () => {
    it('renders an initials avatar for the first comment author when a matching collaborator exists', () => {
      const root = document.createElement('div');
      const t = thread({
        id: 'T1',
        comments: [
          {
            id: 'C1',
            author: 'Alice',
            color: '#000',
            body: 'hi',
            created_at: '2026-04-30T00:00:00Z',
            author_email: 'alice@example.com',
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_desktop',
        collaborators: [
          { display_name: 'Alice Anderson', email_address: 'alice@example.com' },
        ],
      });
      expect(root.querySelector('.thread .author-avatar')?.textContent).toBe('AA');
    });

    it('omits the avatar on Local-backend tabs even when collaborators is non-empty', () => {
      const root = document.createElement('div');
      const t = thread({
        id: 'T1',
        comments: [
          {
            id: 'C1',
            author: 'Alice',
            color: '#000',
            body: 'hi',
            created_at: '2026-04-30T00:00:00Z',
            author_email: 'alice@example.com',
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'local',
        collaborators: [
          { display_name: 'Alice Anderson', email_address: 'alice@example.com' },
        ],
      });
      expect(root.querySelector('.thread .author-avatar')).toBeFalsy();
    });

    it("falls back to '?' when the comment author isn't in the collaborator list", () => {
      const root = document.createElement('div');
      const t = thread({
        id: 'T1',
        comments: [
          {
            id: 'C1',
            author: 'Stranger',
            color: '#000',
            body: 'hi',
            created_at: '2026-04-30T00:00:00Z',
            author_email: 'stranger@example.com',
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_desktop',
        collaborators: [
          { display_name: 'Alice Anderson', email_address: 'alice@example.com' },
        ],
      });
      expect(root.querySelector('.thread .author-avatar')?.textContent).toBe('?');
    });

    it('omits the avatar entirely when collaborators is empty', () => {
      // Drive backend but no collaborators loaded yet (the loader hasn't
      // resolved or the file has zero permissions). Don't render a "?"
      // chip in that case — wait for collaborators to land.
      const root = document.createElement('div');
      const t = thread({
        id: 'T1',
        comments: [
          {
            id: 'C1',
            author: 'Alice',
            color: '#000',
            body: 'hi',
            created_at: '2026-04-30T00:00:00Z',
            author_email: 'alice@example.com',
          },
        ],
      });
      mountCommentsSidebar(root, ipcStub(), [t], {
        showResolved: false,
        backend: 'drive_desktop',
        collaborators: [],
      });
      expect(root.querySelector('.thread .author-avatar')).toBeFalsy();
    });
  });
});
