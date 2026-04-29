import type { Ipc, Settings, Thread } from '../ipc';
import { mountEdit, type EditView } from './Edit';

export interface DocumentMountArgs {
  tabId: string;
  html: string;
  threads: Thread[];
  /**
   * Source markdown for the Edit view. Optional so older A10 callers that
   * only render still work without changes. When omitted, the View/Edit
   * toggle is suppressed.
   */
  source?: string;
  /** Absolute path used by Edit's autosave IPC. Required alongside `source`. */
  path?: string;
  /** Settings snapshot — Edit reads `editor.*` and `comments.reattachment_confidence`. */
  settings?: Settings;
  /**
   * Called whenever the View/Edit transition recomputes orphan threads —
   * used by Workspace to refresh the sidebar's orphan section.
   */
  onOrphansChanged?(orphans: Thread[]): void;
}

export type DocumentMode = 'view' | 'edit';

export interface DocumentView {
  currentSelectionOffsets(): { start: number; end: number; exact: string } | null;
  refreshHighlights(): Promise<void>;
  /** Switch between View and Edit; re-resolves anchors when returning to View. */
  setMode(mode: DocumentMode): Promise<void>;
  mode(): DocumentMode;
  /** Threads whose latest resolveAnchor returned `orphan`. */
  orphanThreads(): Thread[];
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

  // Toolbar carries the View/Edit toggle button when the caller supplied
  // both `source` and `path`. We always create the element so the test
  // selector exists, but suppress its display when there's no edit target.
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-region', 'doc-toolbar');
  const toggleBtn = document.createElement('button');
  toggleBtn.setAttribute('data-action', 'toggle-edit');
  toggleBtn.textContent = 'Edit';
  if (args.source === undefined || args.path === undefined) {
    toggleBtn.hidden = true;
  }
  toolbar.appendChild(toggleBtn);

  // C3 wire-up: Share button that dispatches a `share-requested` custom
  // event the Workspace listens for to mount the ShareDialog. Hidden when
  // there's no path (no document → nothing to share).
  const shareBtn = document.createElement('button');
  shareBtn.setAttribute('data-action', 'share');
  shareBtn.textContent = 'Share…';
  if (args.path === undefined) {
    shareBtn.hidden = true;
  }
  shareBtn.addEventListener('click', () => {
    if (!args.path) return;
    view.dispatchEvent(
      new CustomEvent('share-requested', {
        bubbles: true,
        detail: { tabId: args.tabId, path: args.path },
      }),
    );
  });
  toolbar.appendChild(shareBtn);
  view.appendChild(toolbar);

  const render = document.createElement('div');
  render.setAttribute('data-region', 'render');

  // Trusted server-rendered HTML — but we still parse it via DOMParser rather
  // than assigning to a live element's innerHTML. This keeps the no-innerHTML
  // house style intact and lets the parser run once on a detached document.
  function paintRenderFromHtml(html: string): void {
    render.replaceChildren();
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    for (const node of Array.from(parsed.body.childNodes)) {
      render.appendChild(node);
    }
  }
  paintRenderFromHtml(args.html);
  view.appendChild(render);

  // Edit-mode container — created once, populated only when the user toggles.
  const editRegion = document.createElement('div');
  editRegion.setAttribute('data-region', 'edit');
  editRegion.hidden = true;
  view.appendChild(editRegion);

  root.appendChild(view);

  // Lazy-load Mermaid only when the rendered HTML contains a mermaid block.
  // Static-importing mermaid would roughly double the WebView bundle even
  // when no diagrams are present.
  if (render.querySelector('.mermaid')) {
    const mermaid = await import('mermaid');
    mermaid.default.initialize({ startOnLoad: false, theme: 'default' });
    await mermaid.default.run({ querySelector: '.mermaid' });
  }

  // Track which threads landed as orphans on the most recent View render.
  // Phase B1's resolve_anchor_with_threshold returns `orphan` when the
  // Rust-side similarity score falls below `comments.reattachment_confidence`,
  // so the wire-format `kind: 'orphan'` is the source of truth here.
  let orphans: Thread[] = [];

  async function resolveAndPaintAll(threads: Thread[]): Promise<Thread[]> {
    const nextOrphans: Thread[] = [];
    for (const t of threads) {
      const r = await ipc.resolveAnchor(args.tabId, t.anchor);
      if (r.kind === 'resolved') {
        paintHighlight(render, t.id, r.start, r.end);
      } else {
        nextOrphans.push(t);
      }
    }
    return nextOrphans;
  }

  // Resolve anchors for existing threads via IPC and paint highlights.
  // Orphans get routed to the orphan list (sidebar surface) instead.
  orphans = await resolveAndPaintAll(args.threads);
  args.onOrphansChanged?.(orphans);

  let currentMode: DocumentMode = 'view';
  let currentSource: string = args.source ?? '';
  // The threads list can grow during a session (createThread); we hold the
  // most recent set passed in so re-render after mode toggle re-resolves
  // the same threads against the freshly saved source.
  let currentThreads: Thread[] = [...args.threads];
  let editView: EditView | null = null;

  async function enterEdit(): Promise<void> {
    if (currentMode === 'edit') return;
    if (args.source === undefined || args.path === undefined || args.settings === undefined) {
      // Caller didn't supply edit-mode args — refuse silently. The toggle
      // button is hidden in that branch, so this is a defensive guard.
      return;
    }
    render.hidden = true;
    editRegion.hidden = false;
    editRegion.replaceChildren();
    editView = mountEdit(editRegion, ipc, {
      tabId: args.tabId,
      path: args.path,
      source: currentSource,
      autoSave: args.settings.editor.auto_save,
      autoSaveDebounceMs: args.settings.editor.auto_save_debounce_ms,
      wordWrap: args.settings.editor.word_wrap,
      showWhitespace: args.settings.editor.show_whitespace,
    });
    currentMode = 'edit';
    toggleBtn.textContent = 'View';
  }

  async function enterView(): Promise<void> {
    if (currentMode === 'view') return;
    if (editView) {
      // Flush any pending autosave so the next renderMarkdown call sees the
      // user's latest bytes — without this the round-trip would re-render
      // the *previous* save's HTML and miss in-flight edits.
      await editView.forceSave();
      currentSource = editView.currentSource();
      editView.destroy();
      editView = null;
    }
    editRegion.hidden = true;
    editRegion.replaceChildren();
    // Re-render markdown from the freshly-saved bytes and re-resolve anchors.
    // Orphans here are recomputed off the new source, which is the only
    // moment in the session where reattachment_confidence is consulted.
    const next = await ipc.renderMarkdown(currentSource);
    paintRenderFromHtml(next.html);
    render.hidden = false;
    orphans = await resolveAndPaintAll(currentThreads);
    args.onOrphansChanged?.(orphans);
    currentMode = 'view';
    toggleBtn.textContent = 'Edit';
  }

  toggleBtn.addEventListener('click', () => {
    if (currentMode === 'view') void enterEdit();
    else void enterView();
  });

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
    setMode: async (mode) => {
      if (mode === 'edit') await enterEdit();
      else await enterView();
    },
    mode: () => currentMode,
    orphanThreads: () => orphans.slice(),
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
