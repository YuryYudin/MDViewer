import { describe, it, expect, vi, afterEach } from 'vitest';
import { attachSelectionPopover } from '../../src/views/SelectionPopover';
import type { Ipc } from '../../src/ipc';

function ipcStub(): Ipc {
  return {
    createThread: vi.fn().mockResolvedValue({
      id: 't-new',
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
    }),
  } as unknown as Ipc;
}

function setupRoot(): HTMLElement {
  const root = document.createElement('div');
  root.setAttribute('data-region', 'render');
  const span = document.createElement('span');
  span.setAttribute('data-src-offset', '0');
  span.setAttribute('data-src-end', '5');
  span.textContent = 'Hello';
  root.appendChild(span);
  document.body.appendChild(root);
  return root;
}

function selectAll(el: HTMLElement): void {
  const text = el.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 0);
  range.setEnd(text, text.data.length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  document.body.replaceChildren();
  document.querySelectorAll('[data-view="selection-popover"]').forEach((n) => n.remove());
  window.getSelection()?.removeAllRanges();
});

describe('SelectionPopover', () => {
  it('shows a popover with Comment + Copy buttons when text is selected inside the document root', () => {
    const root = setupRoot();
    const ipc = ipcStub();
    attachSelectionPopover(
      root,
      ipc,
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
    expect(document.querySelector('[data-action="comment"]')).toBeTruthy();
    expect(document.querySelector('[data-action="copy"]')).toBeTruthy();
  });

  it('removes the popover when the selection collapses', () => {
    const root = setupRoot();
    attachSelectionPopover(
      root,
      ipcStub(),
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
    window.getSelection()!.removeAllRanges();
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('ignores selections whose anchor node is outside the document root', () => {
    const root = setupRoot();
    // Create a separate div outside the document root and select inside it.
    const outside = document.createElement('div');
    outside.textContent = 'outside';
    document.body.appendChild(outside);
    attachSelectionPopover(
      root,
      ipcStub(),
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    const text = outside.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.data.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('Comment button opens a body composer with textarea + Post + Cancel', () => {
    const root = setupRoot();
    attachSelectionPopover(
      root,
      ipcStub(),
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-test="comment-body"]')).toBeTruthy();
    expect(document.querySelector('[data-action="post-comment"]')).toBeTruthy();
    expect(document.querySelector('[data-action="cancel-comment"]')).toBeTruthy();
  });

  it('Cancel button removes the composer popover', () => {
    const root = setupRoot();
    attachSelectionPopover(
      root,
      ipcStub(),
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="cancel-comment"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('Comment with empty offsets is a no-op (popover stays open)', () => {
    const root = setupRoot();
    attachSelectionPopover(
      root,
      ipcStub(),
      () => 'tab-1',
      () => null,
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    // Stage 2 should not have rendered.
    expect(document.querySelector('[data-test="comment-body"]')).toBeNull();
  });

  it('Post calls ipc.createThread with the typed body and dispatches thread-created', async () => {
    const root = setupRoot();
    const ipc = ipcStub();
    attachSelectionPopover(
      root,
      ipc,
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    const ta = document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement;
    ta.value = 'First note';
    const handler = vi.fn();
    root.addEventListener('thread-created', handler as EventListener);
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    // Allow the async createThread promise chain to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.createThread).toHaveBeenCalledTimes(1);
    expect(ipc.createThread).toHaveBeenCalledWith(
      'tab-1',
      { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
      'First note',
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('uses range.getBoundingClientRect when jsdom provides one', () => {
    const root = setupRoot();
    // Patch Range.prototype to expose a getBoundingClientRect for this test
    // only, so the function-typed branch in the popover gets covered.
    const proto = Range.prototype as Range & {
      getBoundingClientRect?: () => DOMRect;
    };
    const spy = vi.fn(() => ({ top: 100, left: 50, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    proto.getBoundingClientRect = spy;
    try {
      attachSelectionPopover(
        root,
        ipcStub(),
        () => 'tab-1',
        () => ({ start: 0, end: 5, exact: 'Hello' }),
      );
      selectAll(root.querySelector('span')!);
      root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      const pop = document.querySelector('[data-view="selection-popover"]') as HTMLElement;
      expect(pop).toBeTruthy();
      expect(pop.style.top).toBe('64px'); // 100 - 36
      expect(pop.style.left).toBe('50px');
      expect(spy).toHaveBeenCalled();
    } finally {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    }
  });

  it('Copy button writes the selection to clipboard', () => {
    const root = setupRoot();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    attachSelectionPopover(
      root,
      ipcStub(),
      () => 'tab-1',
      () => ({ start: 0, end: 5, exact: 'Hello' }),
    );
    selectAll(root.querySelector('span')!);
    root.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    (document.querySelector('[data-action="copy"]') as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledWith('Hello');
  });
});
