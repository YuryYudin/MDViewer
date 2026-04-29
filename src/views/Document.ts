import type { Ipc, Thread } from '../ipc';

export interface DocumentMountArgs {
  tabId: string;
  html: string;
  threads: Thread[];
}

export interface DocumentView {
  currentSelectionOffsets(): { start: number; end: number; exact: string } | null;
  refreshHighlights(): Promise<void>;
}

/**
 * Mount the rendered-document view. The Rust backend has already produced
 * pre-escaped HTML with `data-src-offset` / `data-src-end` attributes on the
 * inline carrier elements (`<span>`, `<code>`); we parse it via DOMParser and
 * graft the body children into the live tree so we never assign to a live
 * element's `innerHTML`. Lazy-loads Mermaid only when a `.mermaid` block is
 * actually present, keeping the WebView payload small for plain prose docs.
 */
export async function mountDocument(
  root: HTMLElement,
  ipc: Ipc,
  args: DocumentMountArgs,
): Promise<DocumentView> {
  root.replaceChildren();
  const view = document.createElement('div');
  view.setAttribute('data-view', 'document');
  const render = document.createElement('div');
  render.setAttribute('data-region', 'render');

  // Trusted server-rendered HTML — but we still parse it via DOMParser rather
  // than assigning to a live element's innerHTML. This keeps the no-innerHTML
  // house style intact and lets the parser run once on a detached document.
  const parsed = new DOMParser().parseFromString(args.html, 'text/html');
  for (const node of Array.from(parsed.body.childNodes)) {
    render.appendChild(node);
  }
  view.appendChild(render);
  root.appendChild(view);

  // Lazy-load Mermaid only when the rendered HTML contains a mermaid block.
  // Static-importing mermaid would roughly double the WebView bundle even
  // when no diagrams are present.
  if (render.querySelector('.mermaid')) {
    const mermaid = await import('mermaid');
    mermaid.default.initialize({ startOnLoad: false, theme: 'default' });
    await mermaid.default.run({ querySelector: '.mermaid' });
  }

  // Resolve anchors for existing threads via IPC and paint highlights.
  // Orphans (anchor.kind === 'orphan') stay listed in the sidebar but get
  // no body highlight — orphan UX (wireframe 09) lands in B4.
  for (const t of args.threads) {
    const r = await ipc.resolveAnchor(args.tabId, t.anchor);
    if (r.kind === 'resolved') paintHighlight(render, t.id, r.start, r.end);
  }

  function offsetsFromSelection(): { start: number; end: number; exact: string } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const startEl = closestSrcEl(range.startContainer);
    const endEl = closestSrcEl(range.endContainer);
    if (!startEl || !endEl) return null;
    // textContent on an Element is always a string (never null); the cast
    // narrows the type for the TEXT-node-vs-element branch below.
    const endText = endEl.textContent as string;
    const baseStart = parseInt(startEl.getAttribute('data-src-offset')!, 10);
    const baseEnd = parseInt(endEl.getAttribute('data-src-end')!, 10);

    // range.startOffset/endOffset semantics depend on the container kind:
    // - Text node container: offset is char position within that text node.
    // - Element container: offset is child-NODE index (NOT char count).
    // For element containers we substitute the char count of the rendered
    // text inside the element so the result matches the user's visual
    // selection rather than DOM topology.
    const startCharOffset =
      range.startContainer.nodeType === Node.TEXT_NODE ? range.startOffset : 0;
    const endCharOffset =
      range.endContainer.nodeType === Node.TEXT_NODE ? range.endOffset : endText.length;

    const start = baseStart + startCharOffset;
    const end = Math.min(baseEnd, baseStart + endCharOffset);
    return { start, end, exact: sel.toString() };
  }

  function closestSrcEl(n: Node): HTMLElement | null {
    let el: Element | null = n instanceof Element ? n : n.parentElement;
    while (el && !el.hasAttribute('data-src-offset')) el = el.parentElement;
    return el as HTMLElement | null;
  }

  return {
    currentSelectionOffsets: offsetsFromSelection,
    refreshHighlights: async () => {
      /* called on thread change events; B-phase wires this up. */
    },
  };
}

/**
 * Wrap the matching slice of the inline carrier element's first text node in
 * `<mark data-anchor="…">` so the highlighted phrase is visible. If the range
 * crosses element boundaries (rare in Phase 1 because selections normally
 * stay within a paragraph), we walk all containing elements and wrap each
 * per-element subrange.
 */
function paintHighlight(root: HTMLElement, threadId: string, start: number, end: number): void {
  const carriers = Array.from(
    root.querySelectorAll<HTMLElement>('[data-src-offset][data-src-end]'),
  );
  for (const el of carriers) {
    const elStart = parseInt(el.getAttribute('data-src-offset')!, 10);
    const elEnd = parseInt(el.getAttribute('data-src-end')!, 10);
    if (end <= elStart || start >= elEnd) continue; // no overlap

    const localStart = Math.max(0, start - elStart);
    const localEnd = Math.min(elEnd - elStart, end - elStart);
    const text = el.firstChild;
    // A5's emitter guarantees the carrier's first child is a Text node with
    // the slice's contents — but a syntax-highlighter or post-processor can
    // wrap the text in nested spans, in which case we skip rather than break
    // the document layout. The Phase-1 success-criterion test exercises the
    // text-first-child case.
    if (!text || text.nodeType !== Node.TEXT_NODE) continue;
    const data = (text as Text).data;

    const before = data.slice(0, localStart);
    const inside = data.slice(localStart, localEnd);
    const after = data.slice(localEnd);

    const beforeNode = document.createTextNode(before);
    const mark = document.createElement('mark');
    mark.setAttribute('data-anchor', threadId);
    mark.textContent = inside;
    const afterNode = document.createTextNode(after);

    el.replaceChild(afterNode, text);
    el.insertBefore(mark, afterNode);
    el.insertBefore(beforeNode, mark);
  }
}
