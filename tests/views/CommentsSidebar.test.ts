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
});
