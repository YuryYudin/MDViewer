import { describe, it, expect, vi } from 'vitest';
import { mountThreadDetail } from '../../src/views/ThreadDetail';
import type { Ipc, Thread } from '../../src/ipc';

function ipcStub(): Ipc {
  return {
    postReply: vi.fn().mockResolvedValue(undefined),
    resolveThread: vi.fn().mockResolvedValue(undefined),
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
      {
        id: 'c-2',
        author: 'Aaron',
        color: '#2b8ac9',
        body: 'Second note',
        created_at: '2026-04-28T00:01:00Z',
      },
    ],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
    ...overrides,
  } as Thread;
}

describe('ThreadDetail', () => {
  it('renders all comments in the thread (header + body) via textContent', () => {
    const root = document.createElement('div');
    mountThreadDetail(root, ipcStub(), thread(), () => 'tab-1');
    expect(root.getAttribute('data-view')).toBe('thread-detail');
    const comments = root.querySelectorAll('[data-test="thread-comment"]');
    expect(comments.length).toBe(2);
    expect(comments[0].textContent).toContain('Mira');
    expect(comments[0].textContent).toContain('First note');
    expect(comments[1].textContent).toContain('Aaron');
    expect(comments[1].textContent).toContain('Second note');
  });

  it('uses textContent so HTML in author/body is not parsed', () => {
    const root = document.createElement('div');
    mountThreadDetail(
      root,
      ipcStub(),
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
      () => 'tab-1',
    );
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>bad()</script>');
  });

  it('Post calls ipc.postReply(tabId, threadId, body)', async () => {
    const root = document.createElement('div');
    const ipc = ipcStub();
    mountThreadDetail(root, ipc, thread({ id: 't-7' }), () => 'tab-9');
    const ta = root.querySelector('[data-test="reply-body"]') as HTMLTextAreaElement;
    ta.value = 'Reply body';
    (root.querySelector('[data-action="post-reply"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.postReply).toHaveBeenCalledTimes(1);
    expect(ipc.postReply).toHaveBeenCalledWith('tab-9', 't-7', 'Reply body');
  });

  it('Resolve calls ipc.resolveThread(tabId, threadId)', async () => {
    const root = document.createElement('div');
    const ipc = ipcStub();
    mountThreadDetail(root, ipc, thread({ id: 't-7' }), () => 'tab-9');
    (root.querySelector('[data-action="resolve"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.resolveThread).toHaveBeenCalledTimes(1);
    expect(ipc.resolveThread).toHaveBeenCalledWith('tab-9', 't-7');
  });

  it('clears the reply textarea after posting', async () => {
    const root = document.createElement('div');
    const ipc = ipcStub();
    mountThreadDetail(root, ipc, thread(), () => 'tab-1');
    const ta = root.querySelector('[data-test="reply-body"]') as HTMLTextAreaElement;
    ta.value = 'Reply body';
    (root.querySelector('[data-action="post-reply"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('');
  });

  it('rerenders cleanly when called twice', () => {
    const root = document.createElement('div');
    const ipc = ipcStub();
    mountThreadDetail(root, ipc, thread({ id: 't-1' }), () => 'tab-1');
    mountThreadDetail(root, ipc, thread({ id: 't-2' }), () => 'tab-1');
    // The Resolve / Post buttons should be present (no duplicates).
    expect(root.querySelectorAll('[data-action="resolve"]').length).toBe(1);
    expect(root.querySelectorAll('[data-action="post-reply"]').length).toBe(1);
  });
});
