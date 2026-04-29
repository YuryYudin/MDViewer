import { describe, it, expect, vi, afterEach } from 'vitest';
import { mountDocument } from '../../src/views/Document';
import type { Ipc } from '../../src/ipc';

const html =
  '<p><span data-src-offset="0" data-src-end="5">Hello</span> <span data-src-offset="6" data-src-end="11">world</span>.</p>';

function ipc(): Ipc {
  return {
    resolveAnchor: vi.fn().mockResolvedValue({ kind: 'resolved', start: 0, end: 5 }),
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
    listThreads: vi.fn().mockResolvedValue([]),
  } as unknown as Ipc;
}

function makeRoot(): HTMLElement {
  // jsdom only honors Selection on nodes attached to the document — keep
  // the test root in document.body so Range.set{Start,End} work.
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

describe('Document', () => {
  it('mounts rendered html and reads data-src-offset on selection', async () => {
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
    expect(root.querySelector('[data-view="document"]')).toBeTruthy();
    const span = root.querySelector('[data-src-offset="0"]')!;
    // Range over the span's child Text node, not the span element itself.
    const textNode = span.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const offsets = view.currentSelectionOffsets();
    expect(offsets).toEqual({ start: 0, end: 5, exact: 'Hello' });
  });

  it('paints highlights for threads loaded from the sidecar', async () => {
    // Phase-1 success criterion 5 verification at the view layer. The inline
    // <span> is what carries data-src-offset/data-src-end (block <p> does not).
    const sample =
      '<p><span data-src-offset="0" data-src-end="11">Hello world</span></p>';
    const root = makeRoot();
    const ipcStub = ipc();
    (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'resolved',
      start: 0,
      end: 5,
    });
    await mountDocument(root, ipcStub, {
      tabId: 't',
      html: sample,
      threads: [
        {
          id: 't-1',
          anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: ' world' },
          comments: [],
          resolved: false,
        },
      ] as unknown as never,
    });
    const mark = root.querySelector('[data-anchor="t-1"]') as HTMLElement | null;
    expect(mark).toBeTruthy();
    expect(mark!.tagName.toLowerCase()).toBe('mark');
    expect(mark!.textContent).toBe('Hello');
    expect(ipcStub.resolveAnchor).toHaveBeenCalledTimes(1);
  });

  it('skips highlights for orphan resolveAnchor outcomes', async () => {
    const root = makeRoot();
    const ipcStub = ipc();
    (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'orphan',
    });
    await mountDocument(root, ipcStub, {
      tabId: 't',
      html,
      threads: [
        {
          id: 't-orphan',
          anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
          comments: [],
          resolved: false,
        },
      ] as unknown as never,
    });
    expect(root.querySelector('[data-anchor="t-orphan"]')).toBeNull();
  });

  it('returns null offsets when there is no selection', async () => {
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
    window.getSelection()!.removeAllRanges();
    expect(view.currentSelectionOffsets()).toBeNull();
  });

  it('returns null offsets when the selection is collapsed', async () => {
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
    const span = root.querySelector('[data-src-offset="0"]')!;
    const textNode = span.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 2); // collapsed
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(view.currentSelectionOffsets()).toBeNull();
  });

  it('returns null offsets when the range is outside any data-src-offset carrier', async () => {
    const root = makeRoot();
    // No data-src-offset attributes anywhere — selection within plain <p>.
    const view = await mountDocument(root, ipc(), {
      tabId: 't',
      html: '<p>plain text without carriers</p>',
      threads: [],
    });
    const p = root.querySelector('p')!;
    const text = p.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.data.length);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(view.currentSelectionOffsets()).toBeNull();
  });

  it('exposes refreshHighlights() that resolves without throwing', async () => {
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
    await expect(view.refreshHighlights()).resolves.toBeUndefined();
  });

  it('lazy-loads mermaid only when the rendered HTML contains a .mermaid block', async () => {
    const initialize = vi.fn();
    const run = vi.fn().mockResolvedValue(undefined);
    vi.doMock('mermaid', () => ({ default: { initialize, run } }));
    try {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html: '<div class="mermaid">graph LR;A-->B;</div>',
        threads: [],
      });
      expect(initialize).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith({ querySelector: '.mermaid' });
    } finally {
      vi.doUnmock('mermaid');
    }
  });

  it('skips paintHighlight when the carrier element has no text-node first child', async () => {
    // The carrier <span> wraps another <span> rather than raw text, so its
    // firstChild is an Element node not a Text node — paintHighlight should
    // skip it without throwing.
    const sample =
      '<p><span data-src-offset="0" data-src-end="5"><b>Hello</b></span></p>';
    const root = makeRoot();
    const ipcStub = ipc();
    (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'resolved',
      start: 0,
      end: 5,
    });
    await mountDocument(root, ipcStub, {
      tabId: 't',
      html: sample,
      threads: [
        {
          id: 't-skip',
          anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
          comments: [],
          resolved: false,
        },
      ] as unknown as never,
    });
    expect(root.querySelector('[data-anchor="t-skip"]')).toBeNull();
  });

  it('skips paintHighlight when the resolved range falls outside any carrier', async () => {
    // resolveAnchor returns a range that does not overlap any carrier, so
    // paintHighlight short-circuits via the no-overlap guard and never wraps.
    const sample =
      '<p><span data-src-offset="0" data-src-end="5">Hello</span></p>';
    const root = makeRoot();
    const ipcStub = ipc();
    (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: 'resolved',
      start: 100,
      end: 105,
    });
    await mountDocument(root, ipcStub, {
      tabId: 't',
      html: sample,
      threads: [
        {
          id: 't-out',
          anchor: { start: 100, end: 105, exact: '?????', prefix: '', suffix: '' },
          comments: [],
          resolved: false,
        },
      ] as unknown as never,
    });
    expect(root.querySelector('[data-anchor="t-out"]')).toBeNull();
  });

  it('uses textContent length when the selection container is an element (not a text node)', async () => {
    const root = makeRoot();
    // The span carrier itself has data-src-offset; setting the range's start
    // and end on the span element (rather than on its child Text node) makes
    // startContainer/endContainer Element nodes, which exercises the
    // element-container branch of offsetsFromSelection (offsets become 0 /
    // textContent.length rather than char positions inside a text node).
    const view = await mountDocument(root, ipc(), {
      tabId: 't',
      html: '<p><span data-src-offset="0" data-src-end="5">Hello</span></p>',
      threads: [],
    });
    const span = root.querySelector('[data-src-offset="0"]')! as HTMLElement;
    const range = document.createRange();
    // selectNodeContents sets startContainer/endContainer to the element
    // itself, with offsets equal to child-node count (1 here).
    range.selectNodeContents(span);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    const offsets = view.currentSelectionOffsets();
    // baseStart=0; element-container path uses 0 for start and
    // textContent.length (5) for end, producing the full span range.
    expect(offsets).toEqual({ start: 0, end: 5, exact: 'Hello' });
  });
});
