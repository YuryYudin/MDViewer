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
    saveDocument: vi.fn().mockResolvedValue(undefined),
    renderMarkdown: vi.fn().mockResolvedValue({
      html: '<p><span data-src-offset="0" data-src-end="5">Hello</span></p>',
      text_spans: [],
    }),
  } as unknown as Ipc;
}

function settings(): import('../../src/ipc').Settings {
  return {
    profile: { user_id: 'u', display_name: 'U', color: '#000' },
    appearance: { theme: 'light', font_size_px: 14, line_height: 1.5, density: 'comfortable' },
    editor: {
      default_open_mode: 'view',
      auto_save: true,
      auto_save_debounce_ms: 100,
      external_change_behavior: 'ask',
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
      render_line_breaks: true,
    },
    comments: {
      auto_merge: 'ask',
      reattachment_confidence: 0.7,
      sidecar_pattern: '{name}.comments.json',
      show_resolved: true,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: {},
    onboarding: { cli_install_prompt_seen_for: '' },
  };
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

  it('restores initialScrollTop and reports scroll changes via onScrollChange', async () => {
    const root = makeRoot();
    const changes: number[] = [];
    await mountDocument(root, ipc(), {
      tabId: 't',
      html,
      threads: [],
      initialScrollTop: 137,
      onScrollChange: (top) => changes.push(top),
    });
    const render = root.querySelector('[data-region="render"]') as HTMLElement;
    // Restore applied on mount (so a tab switch returns to where the reader was).
    expect(render.scrollTop).toBe(137);
    // Subsequent scrolls are reported up so the Workspace keeps the offset current.
    render.scrollTop = 260;
    render.dispatchEvent(new Event('scroll'));
    expect(changes).toContain(260);
  });

  it('defaults to top (scrollTop 0) when no initialScrollTop is given', async () => {
    const root = makeRoot();
    await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
    const render = root.querySelector('[data-region="render"]') as HTMLElement;
    expect(render.scrollTop).toBe(0);
  });

  // Regression guard for the orphan-on-long-selection bug. The anchor's
  // `exact` must be derived from the source markdown bytes between `start`
  // and `end` — not from `sel.toString()`, which returns rendered text
  // with markdown syntax stripped (`**bold**` → `bold`, list bullets gone,
  // heading markers gone, etc.). For any selection crossing a formatted
  // span, `sel.toString()` ≠ source bytes, so the resolver's Phase-1
  // verbatim substring search misses and the thread lands as orphan.
  //
  // We also verify `prefix` / `suffix` are populated from the source
  // around the selection — those were previously hard-coded to '' in
  // SelectionPopover, defeating the resolver's disambiguation pass when
  // the same `exact` appears multiple times in the document.
  it('captures exact/prefix/suffix from source bytes, not rendered text', async () => {
    // The renderer emits a data-src-offset span pointing into the source
    // markdown's "Hello world" region (offsets 2..13), which sits between
    // the surrounding `**` bold markers. The rendered text inside the
    // span happens to equal the source slice ("Hello world"), but the
    // prefix/suffix only show the difference: source has the markers,
    // rendered DOM does not.
    const source = '**Hello world**';
    const formattedHtml =
      '<p><strong><span data-src-offset="2" data-src-end="13">Hello world</span></strong></p>';
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), {
      tabId: 't',
      html: formattedHtml,
      threads: [],
      source,
      path: '/x.md',
      settings: settings(),
    });
    const span = root.querySelector('[data-src-offset="2"]')!;
    const textNode = span.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const offsets = view.currentSelectionOffsets()!;
    expect(offsets.start).toBe(2);
    expect(offsets.end).toBe(13);
    expect(offsets.exact).toBe('Hello world');
    // `prefix` / `suffix` come from the source — they carry the markdown
    // markers the renderer stripped, which is exactly the context the
    // resolver needs to disambiguate repeated quotes.
    expect(offsets.prefix).toBe('**');
    expect(offsets.suffix).toBe('**');
  });

  // Round-trip regression: an anchor built from `currentSelectionOffsets`
  // against a source containing markdown formatting MUST be resolvable
  // by the verbatim-substring code path on the Rust side. If we ever
  // reintroduce `sel.toString()` as the source of `exact`, this test
  // fails because the rendered text isn't a substring of the source.
  it('anchor captured from formatted source is found verbatim in source', async () => {
    const source = '**Hello world**';
    const formattedHtml =
      '<p><strong><span data-src-offset="2" data-src-end="13">Hello world</span></strong></p>';
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), {
      tabId: 't',
      html: formattedHtml,
      threads: [],
      source,
      path: '/x.md',
      settings: settings(),
    });
    const span = root.querySelector('[data-src-offset="2"]')!;
    const textNode = span.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, textNode.data.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const offsets = view.currentSelectionOffsets()!;
    // Mimic what the Rust verbatim resolver does: locate `exact` in the
    // source. Before the fix this would have been `Hello world` from
    // rendered text — still inside this source, but in a real doc with
    // any markdown inside the selection the rendered text wouldn't
    // appear verbatim.
    expect(source.includes(offsets.exact)).toBe(true);
    // Stronger guarantee: `exact` lives at exactly [start, end].
    expect(source.slice(offsets.start, offsets.end)).toBe(offsets.exact);
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

  describe('share button', () => {
    it('hides the share button when no path is supplied', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="share"]')!;
      expect(btn.hidden).toBe(true);
    });

    it('dispatches share-requested with tabId+path on click', async () => {
      const root = makeRoot();
      document.body.appendChild(root);
      const listener = vi.fn();
      root.addEventListener('share-requested', listener as EventListener);
      await mountDocument(root, ipc(), {
        tabId: 't-7',
        path: '/tmp/x.md',
        source: 'hi',
        settings: settings(),
        html,
        threads: [],
      });
      (root.querySelector('[data-action="share"]') as HTMLButtonElement).click();
      expect(listener).toHaveBeenCalled();
      const ev = listener.mock.calls[0]![0] as CustomEvent;
      expect(ev.detail).toEqual({ tabId: 't-7', path: '/tmp/x.md' });
      document.body.removeChild(root);
    });
  });

  describe('mode toggle', () => {
    it('hides the toggle button when source/path are not provided', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-edit"]')!;
      expect(btn.hidden).toBe(true);
    });

    it('shows the toggle button and switches to Edit mode on click', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'Hello',
        settings: settings(),
        html,
        threads: [],
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-edit"]')!;
      expect(btn.hidden).toBe(false);
      btn.click();
      // Microtask drain so the async enterEdit completes.
      await Promise.resolve();
      await Promise.resolve();
      expect(view.mode()).toBe('edit');
      expect(root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')).toBeTruthy();
      const render = root.querySelector<HTMLElement>('[data-region="render"]')!;
      expect(render.hidden).toBe(true);
    });

    it('returns to View, calls renderMarkdown, and re-resolves anchors', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      const view = await mountDocument(root, ipcStub, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'Hello',
        settings: settings(),
        html,
        threads: [],
      });
      await view.setMode('edit');
      // User edits the textarea.
      const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
      ta.value = 'Hello world!';
      await view.setMode('view');
      expect(view.mode()).toBe('view');
      // B2: saveDocument now takes tabId (not path).
      expect(ipcStub.saveDocument).toHaveBeenCalledWith('t', 'Hello world!');
      expect(ipcStub.renderMarkdown).toHaveBeenCalledWith('Hello world!');
    });

    it('routes orphan threads into orphanThreads() and onOrphansChanged', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: 'orphan',
      });
      const onOrphansChanged = vi.fn();
      const orphanThread = {
        id: 't-orph',
        anchor: { start: 0, end: 5, exact: 'gone', prefix: '', suffix: '' },
        comments: [],
        resolved: false,
      } as unknown as never;
      const view = await mountDocument(root, ipcStub, {
        tabId: 't',
        html,
        threads: [orphanThread],
        onOrphansChanged,
      });
      expect(view.orphanThreads().map((t) => t.id)).toEqual(['t-orph']);
      expect(onOrphansChanged).toHaveBeenCalledTimes(1);
      expect(onOrphansChanged.mock.calls[0][0].map((t: { id: string }) => t.id)).toEqual([
        't-orph',
      ]);
    });

    it('setMode is a no-op when called with the current mode', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      const view = await mountDocument(root, ipcStub, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'Hello',
        settings: settings(),
        html,
        threads: [],
      });
      // Already in view; calling setMode('view') again should not trigger
      // renderMarkdown/saveDocument.
      const renderCallsBefore = (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mock.calls
        .length;
      await view.setMode('view');
      expect(
        (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(renderCallsBefore);
    });

    it('button click toggles back to View when currently in Edit', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'Hello',
        settings: settings(),
        html,
        threads: [],
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-edit"]')!;
      // First click → edit.
      btn.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(view.mode()).toBe('edit');
      // Second click → view.
      btn.click();
      // Several microtask drains for the chained awaits inside enterView.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(view.mode()).toBe('view');
    });

    it('refuses Edit when path/source/settings are missing (defensive)', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      await view.setMode('edit');
      expect(view.mode()).toBe('view');
      expect(root.querySelector('[data-test="editor"]')).toBeNull();
    });

    it('refreshHighlights() resolves without throwing on the new return type', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      await expect(view.refreshHighlights()).resolves.toBeUndefined();
    });
  });

  describe('font-zoom cluster', () => {
    it('renders a span[data-region="font-zoom"].zoom with the three controls in order', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const cluster = root.querySelector<HTMLSpanElement>(
        '[data-region="doc-toolbar"] span[data-region="font-zoom"]',
      );
      expect(cluster).toBeTruthy();
      expect(cluster!.tagName.toLowerCase()).toBe('span');
      expect(cluster!.classList.contains('zoom')).toBe(true);
      // The three controls in order: decrease, readout/reset, increase
      const buttons = Array.from(cluster!.querySelectorAll('button'));
      expect(buttons.length).toBe(3);
      expect(buttons[0]!.getAttribute('data-action')).toBe('font-decrease');
      expect(buttons[1]!.getAttribute('data-action')).toBe('font-reset');
      expect(buttons[1]!.getAttribute('data-test')).toBe('font-readout');
      expect(buttons[2]!.getAttribute('data-action')).toBe('font-increase');
    });

    it('cluster sits after the Share button in the toolbar', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const toolbar = root.querySelector<HTMLDivElement>('[data-region="doc-toolbar"]')!;
      const shareIdx = Array.from(toolbar.children).findIndex(
        (c) => c.getAttribute('data-action') === 'share',
      );
      const clusterIdx = Array.from(toolbar.children).findIndex(
        (c) => c.getAttribute('data-region') === 'font-zoom',
      );
      expect(shareIdx).toBeGreaterThanOrEqual(0);
      expect(clusterIdx).toBeGreaterThan(shareIdx);
    });

    it('readout reflects the configured value (default 14)', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
      expect(readout.textContent).toBe('14');
    });

    it('readout reflects an explicit fontSizePx prop', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        fontSizePx: 18,
      });
      const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
      expect(readout.textContent).toBe('18');
    });

    it('clicking decrease dispatches mdviewer:font-decrease on document', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const listener = vi.fn();
      document.addEventListener('mdviewer:font-decrease', listener as EventListener);
      try {
        const btn = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
        btn.click();
        expect(listener).toHaveBeenCalledTimes(1);
        const ev = listener.mock.calls[0]![0] as CustomEvent;
        expect(ev.type).toBe('mdviewer:font-decrease');
        // No payload — Workspace.ts owns the deltas, not Document.ts
        expect(ev.detail).toBeNull();
      } finally {
        document.removeEventListener('mdviewer:font-decrease', listener as EventListener);
      }
    });

    it('clicking the readout (reset) dispatches mdviewer:font-reset', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const listener = vi.fn();
      document.addEventListener('mdviewer:font-reset', listener as EventListener);
      try {
        const btn = root.querySelector<HTMLButtonElement>('[data-action="font-reset"]')!;
        btn.click();
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0]![0] as CustomEvent).type).toBe('mdviewer:font-reset');
      } finally {
        document.removeEventListener('mdviewer:font-reset', listener as EventListener);
      }
    });

    it('clicking increase dispatches mdviewer:font-increase', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const listener = vi.fn();
      document.addEventListener('mdviewer:font-increase', listener as EventListener);
      try {
        const btn = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
        btn.click();
        expect(listener).toHaveBeenCalledTimes(1);
        expect((listener.mock.calls[0]![0] as CustomEvent).type).toBe(
          'mdviewer:font-increase',
        );
      } finally {
        document.removeEventListener('mdviewer:font-increase', listener as EventListener);
      }
    });

    it('at the minimum (10 px) the decrease button is disabled and titled', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        fontSizePx: 10,
      });
      const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
      const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
      expect(dec.disabled).toBe(true);
      expect(dec.getAttribute('title')).toBe('Already at minimum (10 px)');
      expect(inc.disabled).toBe(false);
    });

    it('at the maximum (24 px) the increase button is disabled and titled', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        fontSizePx: 24,
      });
      const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
      const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
      expect(inc.disabled).toBe(true);
      expect(inc.getAttribute('title')).toBe('Already at maximum (24 px)');
      expect(dec.disabled).toBe(false);
    });

    it('at a mid value (14 px) neither bound button is disabled', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        fontSizePx: 14,
      });
      const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
      const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
      expect(dec.disabled).toBe(false);
      expect(inc.disabled).toBe(false);
    });

    it('the readout reset button is never disabled', async () => {
      // At min and at max, the readout still needs to be clickable to reset.
      for (const px of [10, 14, 24]) {
        const root = makeRoot();
        await mountDocument(root, ipc(), { tabId: 't', html, threads: [], fontSizePx: px });
        const readout = root.querySelector<HTMLButtonElement>('[data-action="font-reset"]')!;
        expect(readout.disabled).toBe(false);
      }
    });

    it('cluster is visible in BOTH View and Edit modes', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'Hello',
        settings: settings(),
        html,
        threads: [],
      });
      // View mode: visible
      let cluster = root.querySelector<HTMLSpanElement>('[data-region="font-zoom"]')!;
      expect(cluster.hidden).toBe(false);
      // Switch to Edit mode
      await view.setMode('edit');
      cluster = root.querySelector<HTMLSpanElement>('[data-region="font-zoom"]')!;
      expect(cluster.hidden).toBe(false);
    });
  });

  describe('link click + hover', () => {
    function ipcWithOpener() {
      const i = ipc() as unknown as Record<string, ReturnType<typeof vi.fn>>;
      i.openExternalUrl = vi.fn().mockResolvedValue(undefined);
      return i as unknown as Ipc & { openExternalUrl: ReturnType<typeof vi.fn> };
    }

    it('clicking an external link calls openExternalUrl and prevents default navigation', async () => {
      const root = makeRoot();
      const i = ipcWithOpener();
      await mountDocument(root, i, {
        tabId: 't',
        html: '<p><a href="https://example.com/x">click</a></p>',
        threads: [],
      });
      const link = root.querySelector('a[href]') as HTMLAnchorElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(i.openExternalUrl).toHaveBeenCalledWith('https://example.com/x');
      expect(event.defaultPrevented).toBe(true);
    });

    it('rendered <a> elements get a `title` attribute equal to the href so the native tooltip shows the URL', async () => {
      const root = makeRoot();
      await mountDocument(root, ipcWithOpener(), {
        tabId: 't',
        html: '<p><a href="https://example.com/x">click</a> <a href="https://anchor.example/y">two</a></p>',
        threads: [],
      });
      const links = root.querySelectorAll<HTMLAnchorElement>('a[href]');
      expect(links[0].getAttribute('title')).toBe('https://example.com/x');
      expect(links[1].getAttribute('title')).toBe('https://anchor.example/y');
    });

    it('does not set a title on in-page anchor links so the tooltip stays clean', async () => {
      const root = makeRoot();
      await mountDocument(root, ipcWithOpener(), {
        tabId: 't',
        html: '<p><a href="#heading">jump</a></p>',
        threads: [],
      });
      const link = root.querySelector('a[href]') as HTMLAnchorElement;
      expect(link.hasAttribute('title')).toBe(false);
    });

    it('in-page anchor links (#fragment) do NOT call openExternalUrl and do not preventDefault', async () => {
      const root = makeRoot();
      const i = ipcWithOpener();
      await mountDocument(root, i, {
        tabId: 't',
        html: '<p><a href="#section-2">jump</a></p>',
        threads: [],
      });
      const link = root.querySelector('a[href]') as HTMLAnchorElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(i.openExternalUrl).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it('hovering an external link dispatches mdviewer:link-hover with the href', async () => {
      const root = makeRoot();
      await mountDocument(root, ipcWithOpener(), {
        tabId: 't',
        html: '<p><a href="https://example.com/hov">x</a></p>',
        threads: [],
      });
      const events: (string | null)[] = [];
      document.addEventListener('mdviewer:link-hover', (ev) => {
        events.push((ev as CustomEvent<{ href: string | null }>).detail.href);
      });
      const link = root.querySelector('a[href]') as HTMLAnchorElement;
      link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(events).toEqual(['https://example.com/hov']);
      link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      expect(events).toEqual(['https://example.com/hov', null]);
    });

    it('hovering an in-page anchor link does NOT fire link-hover events', async () => {
      const root = makeRoot();
      await mountDocument(root, ipcWithOpener(), {
        tabId: 't',
        html: '<p><a href="#h">jump</a></p>',
        threads: [],
      });
      const handler = vi.fn();
      document.addEventListener('mdviewer:link-hover', handler);
      const link = root.querySelector('a[href]') as HTMLAnchorElement;
      link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      expect(handler).not.toHaveBeenCalled();
    });
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

describe('Document render-complete handshake (D1)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@tauri-apps/api/event');
  });

  it("emits 'mdviewer:render-complete' after the initial paint settles", async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    vi.doMock('@tauri-apps/api/event', () => ({ emit, listen: vi.fn() }));

    const { mountDocument: mount } = await import('../../src/views/Document');
    const root = makeRoot();
    await mount(root, ipc(), { tabId: 't', html, threads: [] });

    // The emit is fired from a guarded lazy `import(...)`; flush the macrotask
    // queue so the dynamic import + await chain resolves.
    await new Promise((r) => setTimeout(r, 0));

    expect(emit).toHaveBeenCalledWith('mdviewer:render-complete');
  });
});
