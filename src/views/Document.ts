import type { Ipc, Settings, Thread } from '../ipc';
import { mountEdit, type EditView } from './Edit';
import { attachSelectionPopover } from './SelectionPopover';

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
  /**
   * Initial value rendered in the doc-toolbar's font-zoom readout, used to
   * pick the disabled state for the `−` / `+` buttons. Defaults to 14 px to
   * match the wireframe's default panel. Workspace.ts (A9) updates the
   * readout text + disabled states as the size changes after mount; this
   * prop only seeds the first render so the displayed number agrees with
   * whatever the active tab's effective size is at mount time.
   */
  fontSizePx?: number;
  /**
   * Scroll offset (px) to restore on the render region after mount. The
   * Workspace remembers this per tab so switching tabs returns to where the
   * reader left off instead of snapping to the top (refresh() rebuilds this
   * element on every switch). Defaults to 0.
   */
  initialScrollTop?: number;
  /**
   * Called whenever the render region scrolls, so the Workspace can keep the
   * per-tab scroll offset current for the next `initialScrollTop`.
   */
  onScrollChange?(scrollTop: number): void;
}

/**
 * Lower / upper bounds for the per-document font-size override. The Settings
 * panel slider uses the same `[10, 24]` range; A9's Workspace listener clamps
 * to the same bounds before persisting via IPC.
 */
const FONT_SIZE_MIN_PX = 10;
const FONT_SIZE_MAX_PX = 24;

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

  // Font-zoom cluster — sits after Share, visible in BOTH View and Edit modes
  // (in Edit mode the actions only affect the next View render; the editor
  // textarea is intentionally unscaled per Non-Goals). The element types and
  // class match the existing `.doc-toolbar .zoom` CSS in `app.css`. Each
  // button dispatches a detail-less CustomEvent on `document`; A9's
  // Workspace listener owns the clamp / persist / readout update flow.
  const fontSizePx = args.fontSizePx ?? 14;
  const zoom = document.createElement('span');
  zoom.setAttribute('data-region', 'font-zoom');
  zoom.classList.add('zoom');

  const decreaseBtn = document.createElement('button');
  decreaseBtn.setAttribute('data-action', 'font-decrease');
  decreaseBtn.textContent = '−';
  decreaseBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:font-decrease'));
  });

  // The readout doubles as the Reset button — clicking it dispatches
  // mdviewer:font-reset. It is a real <button> (not a <span>) so it joins
  // the toolbar's Tab order and has implicit `role=button`.
  const readoutBtn = document.createElement('button');
  readoutBtn.setAttribute('data-action', 'font-reset');
  readoutBtn.setAttribute('data-test', 'font-readout');
  readoutBtn.setAttribute('title', 'Reset to global default');
  readoutBtn.textContent = String(fontSizePx);
  readoutBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:font-reset'));
  });

  const increaseBtn = document.createElement('button');
  increaseBtn.setAttribute('data-action', 'font-increase');
  increaseBtn.textContent = '+';
  increaseBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
  });

  // Bound state — disable + retitle the matching no-op button. Reset's title
  // never changes because reset is always a valid intent. The non-bound side
  // gets a plain "Decrease/Increase font size" tooltip.
  if (fontSizePx <= FONT_SIZE_MIN_PX) {
    decreaseBtn.disabled = true;
    decreaseBtn.setAttribute('title', `Already at minimum (${FONT_SIZE_MIN_PX} px)`);
  } else {
    decreaseBtn.setAttribute('title', 'Decrease font size');
  }
  if (fontSizePx >= FONT_SIZE_MAX_PX) {
    increaseBtn.disabled = true;
    increaseBtn.setAttribute('title', `Already at maximum (${FONT_SIZE_MAX_PX} px)`);
  } else {
    increaseBtn.setAttribute('title', 'Increase font size');
  }

  zoom.appendChild(decreaseBtn);
  zoom.appendChild(readoutBtn);
  zoom.appendChild(increaseBtn);
  toolbar.appendChild(zoom);

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

  // Per-tab scroll memory. `render` is freshly created on every tab switch
  // (refresh() rebuilds the document subtree), so without this each switch
  // snaps to the top. Report scroll changes up to the Workspace, and restore
  // the saved offset now that `render` is connected. The rAF re-apply lets
  // layout settle (and survives a synchronous height that isn't final yet);
  // setting scrollTop fires a 'scroll' event that re-saves the same value,
  // which is harmless.
  if (args.onScrollChange) {
    render.addEventListener('scroll', () => args.onScrollChange!(render.scrollTop), {
      passive: true,
    });
  }
  const initialScrollTop = args.initialScrollTop ?? 0;
  if (initialScrollTop > 0) {
    render.scrollTop = initialScrollTop;
    requestAnimationFrame(() => {
      render.scrollTop = initialScrollTop;
    });
  }

  // Wire SelectionPopover (wireframe-04) so triple-clicking a phrase shows
  // the Comment/Copy buttons. This was a pre-existing integration gap —
  // the popover module shipped in A10 but no caller mounted it, so the
  // comment-on-selection success criterion was effectively unreachable
  // outside the unit tests.
  attachSelectionPopover(render, ipc, () => args.tabId, () => offsetsFromSelection());

  // Link-click interceptor: a bare `<a href>` in the rendered HTML would
  // navigate the entire WKWebView to the URL, replacing the app interface
  // with the destination page. We intercept the click, preventDefault, and
  // hand the URL off to the system browser via the open_external_url IPC.
  // In-page `#fragment` links are allowed through so heading-jumps still
  // work. The URL is surfaced on hover via (a) a `title` attribute set
  // below for the native browser tooltip, and (b) a `mdviewer:link-hover`
  // CustomEvent the Workspace status bar listens for so the URL also
  // appears in the bottom-left status chip — same UX as a desktop browser.
  for (const a of render.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    // Don't title in-page anchors with the bare '#fragment' — the browser
    // tooltip would show garbage. The hover/click code below also short-
    // circuits on '#'.
    if (!href.startsWith('#')) a.setAttribute('title', href);
  }
  render.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest?.('a[href]');
    if (!(target instanceof HTMLAnchorElement)) return;
    const href = target.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    ev.preventDefault();
    void ipc.openExternalUrl(href).catch((err) => {
      // Surface the failure inline so the user isn't left wondering why
      // nothing happened (e.g. a non-http URL the Rust handler rejected).
      // eslint-disable-next-line no-console
      console.warn('open_external_url failed:', err);
    });
  });
  // Status-bar URL preview: bubble the hovered href up to Workspace via
  // a document-level CustomEvent. mouseleave fires `null` so the chip
  // clears when the cursor leaves a link.
  render.addEventListener('mouseover', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest?.('a[href]');
    if (!(target instanceof HTMLAnchorElement)) return;
    const href = target.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    document.dispatchEvent(
      new CustomEvent('mdviewer:link-hover', { detail: { href } }),
    );
  });
  render.addEventListener('mouseout', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest?.('a[href]');
    if (!(target instanceof HTMLAnchorElement)) return;
    const href = target.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    document.dispatchEvent(
      new CustomEvent('mdviewer:link-hover', { detail: { href: null } }),
    );
  });

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

  // B5: `mdviewer:save-document` is the canonical save event the keymap,
  // menu bridge, and WDIO specs (23/24) all dispatch. While in Edit mode
  // we flush the EditView's pending bytes via `forceSave` so the spec's
  // "Save the dirty buffer" assertion sees the same bytes the next
  // independent SSH read returns. Outside Edit mode the event is a no-op
  // (the only persistable surface is the editor — View mode has nothing
  // to flush). Listener attached to `document` so the keymap's
  // dispatchEvent at document level reaches it.
  const onSaveDocument = (): void => {
    if (currentMode !== 'edit' || !editView) return;
    void editView.forceSave();
  };
  document.addEventListener('mdviewer:save-document', onSaveDocument);

  function offsetsFromSelection():
    | { start: number; end: number; exact: string; prefix?: string; suffix?: string }
    | null {
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

    // Anchor `exact` must be source-markdown bytes, NOT the rendered text:
    // `sel.toString()` strips markdown syntax (`**bold**` → `bold`, list
    // markers, heading markers, link syntax, etc.). Phase-1 resolve does a
    // verbatim substring search against the saved source, so rendered text
    // misses on any selection crossing inline formatting. Slicing the
    // source at the offsets we just computed keeps the anchor round-trip-
    // exact when the document hasn't been edited.
    //
    // Prefix/suffix carry up to ~32 chars of source context for the
    // resolver's disambiguation pass when `exact` appears multiple times.
    // Falls back to `sel.toString()` when no source is wired in (the
    // read-only / unit-test mount path that doesn't pass `args.source`).
    const CONTEXT_LEN = 32;
    if (currentSource && start >= 0 && end <= currentSource.length && start <= end) {
      return {
        start,
        end,
        exact: currentSource.slice(start, end),
        prefix: currentSource.slice(Math.max(0, start - CONTEXT_LEN), start),
        suffix: currentSource.slice(end, Math.min(currentSource.length, end + CONTEXT_LEN)),
      };
    }
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
      // Re-fetch threads from the IPC and repaint all highlights. Called
      // when a new thread is posted (SelectionPopover dispatches
      // `thread-created`); without this the new thread sits in the sidebar
      // but has no visible <mark data-anchor> in the document.
      const fresh = await ipc.listThreads(args.tabId);
      // Clear existing highlights — paintHighlight only adds, never replaces.
      for (const m of Array.from(render.querySelectorAll('mark[data-anchor]'))) {
        const parent = m.parentNode;
        if (!parent) continue;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
      }
      orphans = await resolveAndPaintAll(fresh);
      args.onOrphansChanged?.(orphans);
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

