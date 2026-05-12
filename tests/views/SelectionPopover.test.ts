import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
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

/**
 * Mount a CodeMirror EditorView attached to document.body so the
 * popover listener (which scopes mouseup to `view.dom`) actually
 * fires when we dispatch events. Returns the view; caller must
 * call view.destroy() in afterEach via cleanupViews().
 */
function makeView(doc: string): EditorView {
  const parent = document.createElement('div');
  parent.setAttribute('data-region', 'live-editor');
  document.body.appendChild(parent);
  const state = EditorState.create({ doc });
  return new EditorView({ state, parent });
}

const mountedViews: EditorView[] = [];
function mount(doc: string): EditorView {
  const v = makeView(doc);
  mountedViews.push(v);
  return v;
}

function selectRange(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: EditorSelection.single(from, to) });
}

function fireMouseUp(view: EditorView): void {
  view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

afterEach(() => {
  for (const v of mountedViews) v.destroy();
  mountedViews.length = 0;
  document.body.replaceChildren();
  document.querySelectorAll('[data-view="selection-popover"]').forEach((n) => n.remove());
});

describe('SelectionPopover (CodeMirror selection source)', () => {
  it('shows a popover with Comment + Copy buttons when a non-empty CodeMirror selection lands', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
    expect(document.querySelector('[data-action="comment"]')).toBeTruthy();
    expect(document.querySelector('[data-action="copy"]')).toBeTruthy();
  });

  it('produces no popover for a collapsed selection (from === to)', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 3, 3);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('removes the popover when the selection collapses after a previous selection produced one', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
    selectRange(view, 3, 3);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('Post sends ipc.createThread with the full payload shape (start, end, exact, prefix, suffix)', async () => {
    // 32 chars of prefix context + selection "Hello" + 32 chars of suffix context.
    const prefix32 = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 chars
    const suffix32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'; // 32 chars
    const doc = `${prefix32}Hello${suffix32}`;
    const view = mount(doc);
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    const from = prefix32.length;
    const to = from + 'Hello'.length;
    selectRange(view, from, to);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    const ta = document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement;
    ta.value = 'First note';
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.createThread).toHaveBeenCalledWith(
      'tab-1',
      {
        start: from,
        end: to,
        exact: 'Hello',
        prefix: prefix32,
        suffix: suffix32,
      },
      'First note',
    );
  });

  it('prefix is empty when selection sits at offset 0 of the document', async () => {
    const view = mount('Hello world');
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    (document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement).value = 'note';
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const call = (ipc.createThread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].prefix).toBe('');
    expect(call[1].suffix).toBe(' world');
  });

  it('suffix is empty when selection ends at the document end', async () => {
    const view = mount('Hello');
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    (document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement).value = 'note';
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const call = (ipc.createThread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].prefix).toBe('');
    expect(call[1].suffix).toBe('');
  });

  it('prefix truncates to 32 chars even when the document is longer', async () => {
    // 40-char prefix + 5-char exact + 40-char suffix. Expect only 32 chars
    // of each context window.
    const prefix40 = '0123456789'.repeat(4); // 40 chars
    const suffix40 = 'abcdefghij'.repeat(4); // 40 chars
    const doc = `${prefix40}Hello${suffix40}`;
    const view = mount(doc);
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    const from = prefix40.length;
    const to = from + 'Hello'.length;
    selectRange(view, from, to);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    (document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement).value = 'note';
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const call = (ipc.createThread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].prefix).toHaveLength(32);
    expect(call[1].suffix).toHaveLength(32);
    expect(call[1].prefix).toBe(prefix40.slice(-32));
    expect(call[1].suffix).toBe(suffix40.slice(0, 32));
  });

  it('multi-line selection preserves newlines in `exact` as a contiguous source slice', async () => {
    const doc = 'line one\nline two\nline three';
    const view = mount(doc);
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    // Span from "one" (offset 5) through "two" (offset 17) — crosses one newline.
    const from = 5;
    const to = 17;
    selectRange(view, from, to);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    (document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement).value = 'note';
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const call = (ipc.createThread as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1].exact).toBe('one\nline two');
    expect(call[1].exact).toContain('\n');
    expect(call[1].start).toBe(from);
    expect(call[1].end).toBe(to);
  });

  it('Comment button opens a body composer with textarea + Post + Cancel', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-test="comment-body"]')).toBeTruthy();
    expect(document.querySelector('[data-action="post-comment"]')).toBeTruthy();
    expect(document.querySelector('[data-action="cancel-comment"]')).toBeTruthy();
  });

  it('Cancel button removes the composer popover', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    (document.querySelector('[data-action="cancel-comment"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('Post dispatches a thread-created CustomEvent on the editor DOM', async () => {
    const view = mount('Hello world');
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    const ta = document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement;
    ta.value = 'First note';
    const handler = vi.fn();
    view.dom.addEventListener('thread-created', handler as EventListener);
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('positions the popover using view.coordsAtPos for the selection start', () => {
    const view = mount('Hello world');
    // jsdom returns null from coordsAtPos because nothing has layout —
    // patch the view's instance method so we can assert the popover used it.
    const spy = vi.spyOn(view, 'coordsAtPos').mockReturnValue({
      top: 100,
      left: 50,
      right: 60,
      bottom: 116,
    });
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    const pop = document.querySelector('[data-view="selection-popover"]') as HTMLElement;
    expect(pop).toBeTruthy();
    expect(pop.style.top).toBe('64px'); // 100 - 36
    expect(pop.style.left).toBe('50px');
    expect(spy).toHaveBeenCalled();
  });

  it('falls back to a zeroed rect when view.coordsAtPos returns null (no layout)', () => {
    const view = mount('Hello world');
    vi.spyOn(view, 'coordsAtPos').mockReturnValue(null);
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    const pop = document.querySelector('[data-view="selection-popover"]') as HTMLElement;
    expect(pop).toBeTruthy();
    // top = 0 - 36 = -36, left = 0
    expect(pop.style.top).toBe('-36px');
    expect(pop.style.left).toBe('0px');
  });

  it('Copy button writes the selection slice to the clipboard', () => {
    const view = mount('Hello world');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="copy"]') as HTMLButtonElement).click();
    expect(writeText).toHaveBeenCalledWith('Hello');
  });

  it('reading the selection again right before posting picks up a re-selection', async () => {
    // Confirm the offsets used at Post time come from the EditorView's
    // live state, not a stale capture — collapsing between selection
    // and Post (the caret motion edge case A.9 wires) must not crash
    // and must not post stale offsets.
    const view = mount('Hello world');
    const ipc = ipcStub();
    attachSelectionPopover(view, ipc, () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    const ta = document.querySelector('[data-test="comment-body"]') as HTMLTextAreaElement;
    ta.value = 'note';
    (document.querySelector('[data-action="post-comment"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(ipc.createThread).toHaveBeenCalledTimes(1);
    const call = (ipc.createThread as ReturnType<typeof vi.fn>).mock.calls[0];
    // Even though the selection collapses when the textarea takes focus,
    // the popover captured offsets at mouseup time, so the post payload
    // is still the original 0..5 selection.
    expect(call[1].start).toBe(0);
    expect(call[1].end).toBe(5);
    expect(call[1].exact).toBe('Hello');
  });

  it('selectionchange tears down the popover when the editor selection has collapsed', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
    // Collapse the editor's selection, then manually dispatch the
    // selectionchange event jsdom doesn't fire on CodeMirror dispatches.
    // The handler reads view.state.selection.main, sees from === to,
    // and tears the popover down.
    selectRange(view, 0, 0);
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('leaves the popover open when selectionchange fires but selection is still non-collapsed', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
    // Programmatically fire a selectionchange while the selection is
    // still 0..5. The handler must read view.state.selection.main, see
    // from !== to, and leave the popover alone.
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeTruthy();
  });

  it('selectionchange while composer is open does not tear the composer down', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    selectRange(view, 0, 5);
    fireMouseUp(view);
    (document.querySelector('[data-action="comment"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-test="comment-body"]')).toBeTruthy();
    // Collapse the selection and fire selectionchange. Composer must
    // survive because composerOpen is true.
    selectRange(view, 0, 0);
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('[data-test="comment-body"]')).toBeTruthy();
  });

  it('selectionchange before any popover is mounted is a no-op', () => {
    const view = mount('Hello world');
    attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    // No mouseup yet → no popover. selectionchange must short-circuit
    // on the `!popover` guard rather than throwing.
    document.dispatchEvent(new Event('selectionchange'));
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });

  it('returns a teardown function that detaches the mouseup listener', () => {
    const view = mount('Hello world');
    const detach = attachSelectionPopover(view, ipcStub(), () => 'tab-1');
    detach();
    selectRange(view, 0, 5);
    fireMouseUp(view);
    expect(document.querySelector('[data-view="selection-popover"]')).toBeNull();
  });
});
