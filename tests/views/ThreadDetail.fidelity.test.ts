import { describe, it, expect, vi } from 'vitest';
import { mountThreadDetail } from '../../src/views/ThreadDetail';
import type { Ipc, Thread } from '../../src/ipc';

/**
 * Wireframe-05/06 fidelity for ThreadDetail. Pre-existing
 * ThreadDetail.test.ts checks behavior (Post calls postReply, Resolve
 * calls resolveThread); this file is the layout half — Post and
 * Resolve sit on a single inline `.thread-actions` row, NOT stacked
 * vertically. Stacking was the bug the user reported: two big
 * vertically-arranged buttons per thread eat sidebar real estate.
 */

function ipcStub(): Ipc {
  return {
    appInfo: vi.fn(),
    openDocument: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    listOpenDocuments: vi.fn(),
    listRecents: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn(),
  } as unknown as Ipc;
}

function thread(): Thread {
  return {
    id: 't-1',
    anchor: { start: 0, end: 5, exact: 'hello', prefix: '', suffix: '' },
    comments: [{ id: 'c-1', author: 'Alice', color: '#f80', body: 'Looks good', created_at: '2026-04-01T00:00:00Z' }],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
  };
}

describe('ThreadDetail — wireframe-05 actions row', () => {
  it('places Post + Resolve on a single .thread-actions row, in that order', () => {
    const root = document.createElement('div');
    mountThreadDetail(root, ipcStub(), thread(), () => 't');
    const actions = root.querySelector<HTMLElement>('.thread-actions');
    expect(actions).toBeTruthy();
    const buttons = Array.from(actions!.querySelectorAll('button'));
    expect(buttons.map((b) => b.getAttribute('data-action'))).toEqual([
      'post-reply',
      'resolve',
    ]);
    expect(buttons[0].textContent).toBe('Post');
    expect(buttons[1].textContent).toBe('Resolve');
  });

  it('keeps the actions row inside the composer (below the textarea)', () => {
    const root = document.createElement('div');
    mountThreadDetail(root, ipcStub(), thread(), () => 't');
    const composer = root.querySelector<HTMLElement>('.composer')!;
    const textarea = composer.querySelector('[data-test="reply-body"]')!;
    const actions = composer.querySelector('.thread-actions')!;
    // Document order: textarea before actions
    const tIdx = Array.from(composer.children).indexOf(textarea);
    const aIdx = Array.from(composer.children).indexOf(actions);
    expect(tIdx).toBeLessThan(aIdx);
  });
});
