import { describe, it, expect, vi } from 'vitest';
import { mountConflict, mergeBytes } from '../../src/views/Conflict';
import type { Hunk, Ipc } from '../../src/ipc';

function ipcStub(hunks: Hunk[], save = vi.fn().mockResolvedValue(undefined)): Ipc {
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
    saveDocument: save,
    setDirty: vi.fn(),
    diffMd: vi.fn().mockResolvedValue(hunks),
  } as unknown as Ipc;
}

describe('Conflict', () => {
  it('renders one row per hunk with Accept Left / Accept Right / Hand-edit', async () => {
    const root = document.createElement('div');
    const ipc = ipcStub([
      {
        kind: 'conflicting',
        local_text: 'left',
        incoming_text: 'right',
        local_range: [0, 1],
        incoming_range: [0, 1],
      },
    ]);
    await mountConflict(root, ipc, { tabId: 't', path: '/tmp/a.md', local: 'left', incoming: 'right' });
    expect(root.querySelector('[data-view="conflict"]')).toBeTruthy();
    expect(root.querySelectorAll('[data-action="accept-left"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-action="accept-right"]')).toHaveLength(1);
    expect(root.querySelectorAll('[data-action="hand-edit"]')).toHaveLength(1);
    expect(root.querySelector('[data-action="finish-merge"]')).toBeTruthy();
  });

  it('clicking Finish merge calls save_document with the resolved bytes (default keeps local)', async () => {
    const root = document.createElement('div');
    const save = vi.fn().mockResolvedValue(undefined);
    const ipc = ipcStub(
      [
        {
          kind: 'conflicting',
          local_text: 'left',
          incoming_text: 'right',
          local_range: [0, 1],
          incoming_range: [0, 1],
        },
      ],
      save,
    );
    await mountConflict(root, ipc, { tabId: 't', path: '/tmp/a.md', local: 'left', incoming: 'right' });
    (root.querySelector('[data-action="finish-merge"]') as HTMLButtonElement).click();
    await Promise.resolve();
    // B2: saveDocument now takes tabId (not path).
    expect(save).toHaveBeenCalledWith('t', 'left');
  });

  it('Accept Right then Finish merge writes the incoming bytes', async () => {
    const root = document.createElement('div');
    const save = vi.fn().mockResolvedValue(undefined);
    const ipc = ipcStub(
      [
        {
          kind: 'conflicting',
          local_text: 'left',
          incoming_text: 'right',
          local_range: [0, 1],
          incoming_range: [0, 1],
        },
      ],
      save,
    );
    await mountConflict(root, ipc, { tabId: 't', path: '/tmp/a.md', local: 'left', incoming: 'right' });
    (root.querySelector('[data-action="accept-right"]') as HTMLButtonElement).click();
    (root.querySelector('[data-action="finish-merge"]') as HTMLButtonElement).click();
    await Promise.resolve();
    // B2: saveDocument now takes tabId (not path).
    expect(save).toHaveBeenCalledWith('t', 'right');
  });

  it('Hand-edit substitutes the textarea contents on Finish merge', async () => {
    const root = document.createElement('div');
    const save = vi.fn().mockResolvedValue(undefined);
    const ipc = ipcStub(
      [
        {
          kind: 'conflicting',
          local_text: 'left',
          incoming_text: 'right',
          local_range: [0, 1],
          incoming_range: [0, 1],
        },
      ],
      save,
    );
    await mountConflict(root, ipc, { tabId: 't', path: '/tmp/a.md', local: 'left', incoming: 'right' });
    (root.querySelector('[data-action="hand-edit"]') as HTMLButtonElement).click();
    const ta = root.querySelector<HTMLTextAreaElement>('textarea[data-role="hand-edit"]')!;
    expect(ta).toBeTruthy();
    ta.value = 'merged-by-hand';
    ta.dispatchEvent(new Event('input'));
    (root.querySelector('[data-action="finish-merge"]') as HTMLButtonElement).click();
    await Promise.resolve();
    // B2: saveDocument now takes tabId (not path).
    expect(save).toHaveBeenCalledWith('t', 'merged-by-hand');
  });

  it('emits conflict-resolved after saveDocument completes', async () => {
    const root = document.createElement('div');
    const ipc = ipcStub([
      {
        kind: 'conflicting',
        local_text: 'left',
        incoming_text: 'right',
        local_range: [0, 1],
        incoming_range: [0, 1],
      },
    ]);
    const listener = vi.fn();
    document.body.appendChild(root);
    root.addEventListener('conflict-resolved', listener);
    await mountConflict(root, ipc, { tabId: 't', path: '/tmp/a.md', local: 'left', incoming: 'right' });
    (root.querySelector('[data-action="finish-merge"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    document.body.removeChild(root);
  });

  it('status bar tracks the unresolved hunk count', async () => {
    const root = document.createElement('div');
    const ipc = ipcStub([
      { kind: 'conflicting', local_text: 'a', incoming_text: 'b', local_range: [0, 1], incoming_range: [0, 1] },
      { kind: 'conflicting', local_text: 'c', incoming_text: 'd', local_range: [2, 3], incoming_range: [2, 3] },
    ]);
    const handle = await mountConflict(root, ipc, { tabId: 't', path: '/tmp/a.md', local: 'a\nx\nc\n', incoming: 'b\nx\nd\n' });
    expect(handle.unresolvedCount()).toBe(2);
    (root.querySelector('[data-action="accept-right"]') as HTMLButtonElement).click();
    expect(handle.unresolvedCount()).toBe(1);
  });
});

describe('mergeBytes', () => {
  it('mixed-choice: hunk 1 keeps local, hunk 2 takes incoming, surrounding context preserved', () => {
    const local = 'line 1\nline 2 local\nline 3\nline 4 local\n';
    const incoming = 'line 1\nline 2 incoming\nline 3\nline 4 incoming\n';
    const hunks: Hunk[] = [
      {
        kind: 'conflicting',
        local_text: 'line 2 local\n',
        incoming_text: 'line 2 incoming\n',
        local_range: [1, 2],
        incoming_range: [1, 2],
      },
      {
        kind: 'conflicting',
        local_text: 'line 4 local\n',
        incoming_text: 'line 4 incoming\n',
        local_range: [3, 4],
        incoming_range: [3, 4],
      },
    ];
    const out = mergeBytes(local, incoming, hunks, ['local', 'incoming']);
    expect(out).toContain('line 1');
    expect(out).toContain('line 2 local');
    expect(out).toContain('line 3');
    expect(out).toContain('line 4 incoming');
    expect(out).not.toContain('line 2 incoming');
    expect(out).not.toContain('line 4 local');
  });

  it('no hunks → output equals local verbatim', () => {
    expect(mergeBytes('a\nb\nc', 'x\ny\nz', [], [])).toBe('a\nb\nc');
  });
});
