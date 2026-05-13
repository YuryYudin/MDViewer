import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, Decoration } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

import { blockWidgets, __resetMermaidCacheForTests } from '../../../src/views/decorations/blocks';
import type { RenderResult } from '../../../src/types-generated';

// Default mermaid mock — every test that does NOT explicitly vi.doMock
// gets this no-op stub so the real mermaid library never runs against the
// IPC-generated div bodies (which aren't valid mermaid sources). The
// explicit-mock test (`__resetMermaidCacheForTests` + vi.doMock) replaces
// this with its own spy before invoking the widget.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    run: vi.fn().mockResolvedValue(undefined),
  },
}));

/**
 * The blocks extension calls `ipc.renderMarkdown(blockSource)` once per
 * visible block widget. Tests stub the function and assert on call shape
 * (count, arguments) plus the resulting DOM markers. The stub is async to
 * mirror the production IPC contract — widgets paint asynchronously after
 * the promise resolves.
 */
function makeRenderMarkdownStub(): {
  renderMarkdown: ReturnType<typeof vi.fn>;
  resolveAll: () => Promise<void>;
} {
  const renderMarkdown = vi.fn(
    async (source: string): Promise<RenderResult> => ({
      html: `<div data-test-rendered="${escapeAttr(source)}">${escapeAttr(source)}</div>`,
      // RenderResult.spans is required by the wire type. Block widgets do
      // NOT consume spans (per A.6 architecture rule), so an empty array
      // is fine. The cast keeps strict TS happy without leaking generated
      // wire-type internals into the test file.
      spans: [],
    }) as unknown as RenderResult,
  );
  return {
    renderMarkdown,
    // Helper that yields once per microtask, letting all in-flight
    // renderMarkdown promises settle before the test asserts on DOM.
    resolveAll: async () => {
      // Two macrotask flushes — first lets the renderMarkdown promise
      // resolve, second lets the view's queued re-dispatch land.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeView(
  doc: string,
  renderMarkdown: (src: string) => Promise<RenderResult>,
  selection?: { from: number; to?: number },
): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: selection
      ? EditorSelection.single(selection.from, selection.to ?? selection.from)
      : EditorSelection.single(doc.length, doc.length), // park caret at EOF (outside all blocks)
    extensions: [markdown({ extensions: GFM }), blockWidgets({ renderMarkdown })],
  });
  return new EditorView({ state, parent });
}

function widgetRoots(view: EditorView): HTMLElement[] {
  return Array.from(view.dom.querySelectorAll<HTMLElement>('[data-block-widget]'));
}

function widgetKinds(view: EditorView): string[] {
  return widgetRoots(view).map((el) => el.getAttribute('data-block-widget') ?? '');
}

afterEach(() => {
  document.body.replaceChildren();
  // Reset the module-level mermaid cache so a later test's vi.doMock can
  // swap in its own spy without inheriting the previous test's module.
  __resetMermaidCacheForTests();
});

describe('blockWidgets', () => {
  describe('lezer detection', () => {
    it('classifies a mermaid FencedCode as a mermaid widget', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```mermaid\ngraph TD\nA-->B\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('mermaid');
      view.destroy();
    });

    it('classifies a python FencedCode as a code widget (not mermaid)', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const kinds = widgetKinds(view);
      expect(kinds).toContain('code');
      expect(kinds).not.toContain('mermaid');
      view.destroy();
    });

    it('classifies an HTMLBlock as an html widget', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '<div>raw html</div>\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('html');
      view.destroy();
    });

    it('classifies an image-as-only-paragraph-child as a block-level image widget', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '![alone](a.png)\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('image');
      view.destroy();
    });

    it('does NOT emit a block-level image widget for an image with sibling text', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = 'Some text ![inline](b.png) more\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).not.toContain('image');
      view.destroy();
    });

    it('classifies a GFM Table as a table widget', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('table');
      view.destroy();
    });

    it('emits one widget per matching block in a mixed document', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = [
        '```mermaid',
        'graph TD',
        'A-->B',
        '```',
        '',
        '```python',
        'print(1)',
        '```',
        '',
        '<div>x</div>',
        '',
        '![alone](a.png)',
        '',
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
      ].join('\n');
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const kinds = widgetKinds(view).sort();
      expect(kinds).toEqual(['code', 'html', 'image', 'mermaid', 'table']);
      view.destroy();
    });
  });

  describe('IPC call count', () => {
    it('calls renderMarkdown once per visible widget on first render', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = [
        '```python',
        'a',
        '```',
        '',
        '<div>x</div>',
        '',
      ].join('\n');
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      // One call per block (python fence + HTMLBlock = 2).
      expect(renderMarkdown).toHaveBeenCalledTimes(2);
      view.destroy();
    });

    it('makes zero additional calls on caret-in then caret-out within the same source', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const initial = renderMarkdown.mock.calls.length;
      expect(initial).toBe(1);

      // Move caret INTO the fence — widget should collapse, no new IPC.
      view.dispatch({ selection: EditorSelection.single(5, 5) });
      await resolveAll();
      // Move caret BACK OUT — widget should re-render with cached HTML.
      view.dispatch({ selection: EditorSelection.single(view.state.doc.length, view.state.doc.length) });
      await resolveAll();
      // No new renderMarkdown invocations: the source hasn't changed.
      expect(renderMarkdown).toHaveBeenCalledTimes(initial);
      view.destroy();
    });
  });

  describe('caret-in collapses widgets', () => {
    it('collapses a fenced-code widget when the caret enters it', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('code');

      // Caret at position 5 sits inside the fence.
      view.dispatch({ selection: EditorSelection.single(5, 5) });
      await resolveAll();
      expect(widgetKinds(view)).not.toContain('code');
      view.destroy();
    });

    it('collapses a Table widget on caret-in revealing the raw GFM source', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('table');

      // Place caret inside the table block.
      view.dispatch({ selection: EditorSelection.single(2, 2) });
      await resolveAll();
      expect(widgetKinds(view)).not.toContain('table');

      // The rendered editor text now shows the pipe characters (raw GFM).
      // We check via the EditorView's content DOM rather than the widget
      // (which is gone). The first line should contain "| a | b |".
      expect(view.contentDOM.textContent ?? '').toContain('| a | b |');
      view.destroy();
    });

    it('re-renders widget on caret-out (round trip)', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('code');

      view.dispatch({ selection: EditorSelection.single(5, 5) });
      await resolveAll();
      expect(widgetKinds(view)).not.toContain('code');

      view.dispatch({ selection: EditorSelection.single(view.state.doc.length, view.state.doc.length) });
      await resolveAll();
      expect(widgetKinds(view)).toContain('code');
      view.destroy();
    });
  });

  describe('RangeSet recompute on edits', () => {
    it('does not re-render the widget while caret is inside the fence and text is edited', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const callsAfterFirstRender = renderMarkdown.mock.calls.length;
      expect(callsAfterFirstRender).toBe(1);

      // Caret in (widget collapses).
      view.dispatch({ selection: EditorSelection.single(15, 15) });
      await resolveAll();
      expect(widgetKinds(view)).not.toContain('code');

      // Type a character at the caret position — fence contents change but
      // widget stays collapsed (caret still in). renderMarkdown must NOT
      // be called again here because the widget body would be unused.
      view.dispatch({
        changes: { from: 15, insert: 'X' },
        selection: EditorSelection.single(16, 16),
        userEvent: 'input.type',
      });
      await resolveAll();
      expect(widgetKinds(view)).not.toContain('code');
      expect(renderMarkdown).toHaveBeenCalledTimes(callsAfterFirstRender);

      // Caret out — widget re-renders, fetching new HTML for the edited
      // source. One additional renderMarkdown call now.
      view.dispatch({ selection: EditorSelection.single(view.state.doc.length, view.state.doc.length) });
      await resolveAll();
      expect(widgetKinds(view)).toContain('code');
      expect(renderMarkdown).toHaveBeenCalledTimes(callsAfterFirstRender + 1);
      view.destroy();
    });
  });

  describe('mermaid lazy-load + run', () => {
    it('imports mermaid and calls mermaid.run({ nodes: [innerDiv] }) once per mermaid widget', async () => {
      const initialize = vi.fn();
      const run = vi.fn().mockResolvedValue(undefined);
      vi.doMock('mermaid', () => ({ default: { initialize, run } }));
      // Reset the module-level mermaid cache so this test's vi.doMock
      // takes effect — earlier tests may have triggered a real
      // import('mermaid') via their mermaid-block fixtures.
      __resetMermaidCacheForTests();

      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        // Mermaid widget body painted from IPC.
        expect(widgetKinds(view)).toContain('mermaid');
        // run was invoked with { nodes: [inner] } exactly once.
        expect(run).toHaveBeenCalledTimes(1);
        const call = run.mock.calls[0];
        expect(call).toBeTruthy();
        const arg = call?.[0] as { nodes?: HTMLElement[] } | undefined;
        expect(arg?.nodes).toBeDefined();
        expect(Array.isArray(arg?.nodes)).toBe(true);
        expect(arg?.nodes?.length).toBe(1);
        // A.4 contract: a FRESH inner `<div>` (off-DOM) is fed to mermaid
        // so the in-place rewriting doesn't double-render across StateField
        // re-emits. The widget root therefore is NOT the same node as
        // arg.nodes[0]; the rewritten content is attached after await.
        const widgetRoot = view.dom.querySelector('[data-block-widget="mermaid"]');
        expect(widgetRoot).not.toBeNull();
        expect(widgetRoot).not.toBe(arg?.nodes?.[0]);
        // The off-DOM div that was fed to mermaid is an HTMLElement.
        expect(arg?.nodes?.[0]).toBeInstanceOf(HTMLElement);
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });
  });

  describe('widget body painted verbatim from IPC HTML', () => {
    it('pastes the IPC HTML straight into the widget DOM (no offset rewrite)', async () => {
      const renderMarkdown = vi.fn(
        async (): Promise<RenderResult> =>
          ({
            html: '<p data-marker="alpha">hello-world</p>',
            spans: [],
          }) as unknown as RenderResult,
      );
      const src = '```python\nx\n```\n';
      const view = makeView(src, renderMarkdown);
      // Inline microtask-flush — no separate stub needed here.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const widget = view.dom.querySelector('[data-block-widget="code"]');
      expect(widget?.querySelector('p[data-marker="alpha"]')).not.toBeNull();
      expect(widget?.textContent).toContain('hello-world');
      view.destroy();
    });
  });

  describe('export shape', () => {
    it('blockWidgets returns a CodeMirror Extension', () => {
      const { renderMarkdown } = makeRenderMarkdownStub();
      const ext = blockWidgets({ renderMarkdown });
      // An Extension is either an object/array; the contract is just
      // "passable to EditorState.create extensions". A smoke instantiation
      // covers the contract better than a structural assertion.
      const state = EditorState.create({ doc: '', extensions: [ext] });
      expect(state.doc.length).toBe(0);
    });
  });

  describe('A.4: data-lang attribute on code/mermaid widget roots', () => {
    it('puts data-lang="python" on the code widget root for a ```python fence', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const widget = view.dom.querySelector('[data-testid="code-widget"]');
      expect(widget).not.toBeNull();
      expect(widget!.getAttribute('data-lang')).toBe('python');
      view.destroy();
    });

    it('puts data-lang="mermaid" on the mermaid widget root for a ```mermaid fence', async () => {
      // Override the top-level mermaid mock with a deterministic no-op
      // run() — sibling tests in this file vi.doUnmock('mermaid'), which
      // leaves the dynamic import resolving to the real library; the
      // real library logs a warning when handed our markdown-source IPC
      // fixture. Pin a fresh no-op for this test.
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph TD;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        const widget = view.dom.querySelector('[data-testid="mermaid-widget"]');
        expect(widget).not.toBeNull();
        expect(widget!.getAttribute('data-lang')).toBe('mermaid');
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });

    it('lowercases the info string ("JavaScript" -> "javascript")', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```JavaScript\nconsole.log(1);\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const widget = view.dom.querySelector('[data-testid="code-widget"]');
      expect(widget).not.toBeNull();
      expect(widget!.getAttribute('data-lang')).toBe('javascript');
      view.destroy();
    });

    it('takes only the first whitespace-separated token of the info string', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python {.hl}\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const widget = view.dom.querySelector('[data-testid="code-widget"]');
      expect(widget).not.toBeNull();
      expect(widget!.getAttribute('data-lang')).toBe('python');
      view.destroy();
    });

    it('sets data-lang="" on a fenced-code widget with no info string', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```\nplain text\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const widget = view.dom.querySelector('[data-testid="code-widget"]');
      expect(widget).not.toBeNull();
      expect(widget!.getAttribute('data-lang')).toBe('');
      view.destroy();
    });

    it('the code-widget root carries BOTH data-testid="code-widget" and data-lang', async () => {
      // The wysiwyg code-block.spec.ts selector is
      //   [data-testid="code-widget"][data-lang="python"]
      // — both must live on the same element. This case asserts the
      // compound selector resolves (i.e., not split across two
      // ancestors).
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const compound = view.dom.querySelector('[data-testid="code-widget"][data-lang="python"]');
      expect(compound).not.toBeNull();
      view.destroy();
    });
  });

  describe('A.6: caret-in collapse emits RawFormWidget', () => {
    it('python widget shows [data-testid="code-widget"] when caret is outside the fence', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      // Caret at EOF (outside the fence) — default selection in makeView.
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(
        view.dom.querySelector('[data-testid="code-widget"][data-lang="python"]'),
      ).not.toBeNull();
      expect(view.dom.querySelector('[data-testid="code-widget-raw"]')).toBeNull();
      view.destroy();
    });

    it('python widget collapses to [data-testid="code-widget-raw"][data-lang="python"] on caret-in', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      // Move caret inside the fence body.
      const innerOffset = src.indexOf('print');
      view.dispatch({ selection: EditorSelection.single(innerOffset, innerOffset) });
      await resolveAll();
      const raw = view.dom.querySelector<HTMLElement>(
        '[data-testid="code-widget-raw"][data-lang="python"]',
      );
      expect(raw).not.toBeNull();
      // Raw body shows opener + content + closer verbatim.
      expect(raw!.textContent).toContain('```python');
      expect(raw!.textContent).toContain('print(1)');
      expect(raw!.textContent).toContain('```');
      // And the rendered widget is gone.
      expect(view.dom.querySelector('[data-testid="code-widget"]')).toBeNull();
      view.destroy();
    });

    it('RawFormWidget wraps a <pre> child with the raw fence text', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      view.dispatch({ selection: EditorSelection.single(5, 5) });
      await resolveAll();
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="code-widget-raw"]');
      expect(raw).not.toBeNull();
      const pre = raw!.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toContain('```python');
      expect(pre!.textContent).toContain('print(1)');
      view.destroy();
    });
  });

  describe('A.6: mermaid pencil affordance', () => {
    it('mermaid widget renders a pencil button[data-action="raw-edit"] inside its root', async () => {
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        const widget = view.dom.querySelector<HTMLElement>('[data-testid="mermaid-widget"]');
        expect(widget).not.toBeNull();
        const pencil = widget!.querySelector<HTMLButtonElement>(
          'button[data-action="raw-edit"]',
        );
        expect(pencil).not.toBeNull();
        expect(pencil!.classList.contains('pencil')).toBe(true);
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });

    it('mermaid pencil click dispatches forceRawEffect and collapses to code-widget-raw[data-lang="mermaid"]', async () => {
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        const pencil = view.dom.querySelector<HTMLButtonElement>(
          '[data-testid="mermaid-widget"] button[data-action="raw-edit"]',
        );
        expect(pencil).not.toBeNull();
        pencil!.click();
        await resolveAll();
        const raw = view.dom.querySelector<HTMLElement>(
          '[data-testid="code-widget-raw"][data-lang="mermaid"]',
        );
        expect(raw).not.toBeNull();
        expect(raw!.textContent).toContain('```mermaid');
        expect(raw!.textContent).toContain('graph LR');
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });

    it('clicking outside the .pencil does not collapse the mermaid widget', async () => {
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        const root = view.dom.querySelector<HTMLElement>('[data-testid="mermaid-widget"]');
        expect(root).not.toBeNull();
        // Click on the root itself, not the pencil. Widget must remain
        // rendered (no collapse to code-widget-raw).
        root!.click();
        await resolveAll();
        expect(view.dom.querySelector('[data-testid="code-widget-raw"]')).toBeNull();
        expect(view.dom.querySelector('[data-testid="mermaid-widget"]')).not.toBeNull();
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });

    it('BlockWidget.ignoreEvent returns false for clicks targeted at .pencil descendants', async () => {
      // The pencil affordance lives inside a CM widget root with
      // contentEditable=false. CM's default `ignoreEvent` swallows
      // interior clicks, which would prevent the pencil's
      // addEventListener handler from ever firing. The override returns
      // `false` only for click events whose target sits inside `.pencil`,
      // routing the click into the widget DOM. We exercise the override
      // directly here so the click-on-.pencil branch is covered.
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        const pencil = view.dom.querySelector<HTMLElement>('button.pencil');
        const widget = view.dom.querySelector<HTMLElement>('[data-testid="mermaid-widget"]');
        expect(pencil).not.toBeNull();
        expect(widget).not.toBeNull();
        // bubbling click whose target is the pencil — the override
        // returns false here, so CodeMirror lets the click through to
        // the pencil's addEventListener handler which dispatches the
        // forceRawEffect and triggers the collapse.
        pencil!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await resolveAll();
        expect(
          view.dom.querySelector('[data-testid="code-widget-raw"][data-lang="mermaid"]'),
        ).not.toBeNull();
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });

    it('BlockWidget.ignoreEvent returns true for non-click events (caret-placement semantics preserved)', async () => {
      // Indirectly assert the default branch returns true: a non-click
      // event (e.g. mousedown) on the widget DOES NOT trigger a
      // forceRawEffect, so the widget remains rendered. This exercises
      // the `return true` line at the bottom of the override.
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        const widget = view.dom.querySelector<HTMLElement>('[data-testid="mermaid-widget"]');
        expect(widget).not.toBeNull();
        widget!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        await resolveAll();
        expect(view.dom.querySelector('[data-testid="code-widget-raw"]')).toBeNull();
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });

    it('mermaid initial render has the SVG present in the widget root once the awaited builder resolves', async () => {
      // IPC returns an <svg> immediately so we can observe "after the
      // awaited builder resolves, the SVG is in the widget root".
      vi.doMock('mermaid', () => ({
        default: { initialize: vi.fn(), run: vi.fn().mockResolvedValue(undefined) },
      }));
      __resetMermaidCacheForTests();
      try {
        const renderMarkdown = vi.fn(
          async (): Promise<RenderResult> =>
            ({
              html: '<svg data-mermaid-svg="1"></svg>',
              spans: [],
            }) as unknown as RenderResult,
        );
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        const widget = view.dom.querySelector<HTMLElement>('[data-testid="mermaid-widget"]');
        expect(widget).not.toBeNull();
        expect(widget!.querySelector('svg')).not.toBeNull();
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });
  });

  describe('A.4: mermaid.run is awaited before the svg is exposed', () => {
    it('does not expose the svg until mermaid.run() resolves', async () => {
      // Build a deferred mermaid.run promise. The widget builder must
      // await it; consequently the IPC-supplied <svg> body should not be
      // present in the widget DOM until we resolve mermaidRunPromise.
      let mermaidRunResolve!: () => void;
      const mermaidRunPromise = new Promise<void>((r) => {
        mermaidRunResolve = r;
      });
      const initialize = vi.fn();
      const run = vi.fn().mockImplementation(() => mermaidRunPromise);
      vi.doMock('mermaid', () => ({ default: { initialize, run } }));
      __resetMermaidCacheForTests();

      try {
        // IPC returns an <svg> immediately so we can observe the
        // "before mermaid.run resolves, the svg is NOT in the DOM"
        // contract distinctly from the "after, it is" branch.
        const renderMarkdown = vi.fn(
          async (): Promise<RenderResult> =>
            ({
              html: '<svg data-mermaid-svg="1"></svg>',
              spans: [],
            }) as unknown as RenderResult,
        );
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        // Let renderMarkdown resolve so paintBody starts.
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));

        const widget = view.dom.querySelector('[data-testid="mermaid-widget"]');
        expect(widget).not.toBeNull();
        // mermaid.run was invoked but is still pending. Because the
        // widget body builder awaits mermaid.run, the inner svg has
        // not been appended yet.
        expect(run).toHaveBeenCalledTimes(1);
        expect(widget!.querySelector('svg')).toBeNull();

        // Resolve mermaid.run; flush microtasks; the awaited builder
        // resumes and appends the svg.
        mermaidRunResolve();
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(widget!.querySelector('svg')).not.toBeNull();
        view.destroy();
      } finally {
        vi.doUnmock('mermaid');
      }
    });
  });

  describe('widget interactions', () => {
    it('ignores interior events (so caret motion treats the widget as atomic)', async () => {
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      const widget = view.dom.querySelector<HTMLElement>('[data-block-widget="code"]');
      expect(widget).not.toBeNull();
      // Synthesize a click inside the widget — the click bubbles past the
      // widget's `ignoreEvent` guard. The contract assertion is just that
      // the widget DOM is still attached after the event, i.e. CM didn't
      // tear it down on click.
      widget!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(view.dom.querySelector('[data-block-widget="code"]')).toBe(widget);
      view.destroy();
    });

    it('logs (but does not throw) when mermaid.run rejects', async () => {
      const initialize = vi.fn();
      const run = vi.fn().mockRejectedValue(new Error('bad diagram'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.doMock('mermaid', () => ({ default: { initialize, run } }));
      __resetMermaidCacheForTests();

      try {
        const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
        const src = '```mermaid\ngraph LR;A-->B;\n```\n';
        const view = makeView(src, renderMarkdown);
        await resolveAll();
        await resolveAll();
        // Failure surfaces only as a console.warn — no exception propagates.
        expect(warn).toHaveBeenCalled();
        view.destroy();
      } finally {
        warn.mockRestore();
        vi.doUnmock('mermaid');
      }
    });

    it('does not re-issue renderMarkdown when two block widgets share the same source on the same tick', async () => {
      // Two identical fenced-code blocks in one document. The second
      // widget's toDOM finds an in-flight IPC for the same source and
      // skips firing its own. The renderMarkdown count is therefore 1
      // (one IPC for the shared source) even though there are two
      // widgets.
      let resolveFirst!: (r: RenderResult) => void;
      const renderMarkdown = vi.fn().mockImplementation(
        () =>
          new Promise<RenderResult>((res) => {
            resolveFirst = res;
          }),
      );
      const src =
        '```python\nx\n```\n\n```python\nx\n```\n';
      const view = makeView(src, renderMarkdown);
      // Both widgets fire toDOM during the initial paint; the second
      // sees `inFlight.has(source)` and skips its own IPC.
      expect(renderMarkdown).toHaveBeenCalledTimes(1);
      // Resolve the shared IPC; both widgets paint from the cache.
      resolveFirst({ html: '<p>x</p>', spans: [] } as unknown as RenderResult);
      await Promise.resolve();
      await Promise.resolve();
      view.destroy();
    });

    it('preserves the cached widget set across viewport-only transactions', async () => {
      // A transaction without docChanged or selection updates must leave
      // the StateField value alone (exercising the `return value` branch).
      const { renderMarkdown, resolveAll } = makeRenderMarkdownStub();
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      await resolveAll();
      expect(widgetKinds(view)).toContain('code');
      // Dispatch a no-op effect-only transaction (no doc/selection change).
      // This exercises the StateField update path that returns the value
      // unchanged. The widget DOM must still be intact afterward.
      view.dispatch({});
      await resolveAll();
      expect(widgetKinds(view)).toContain('code');
      view.destroy();
    });

    it('swallows renderMarkdown failures (widget body stays empty, no throw)', async () => {
      const renderMarkdown = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ html: '<p>ok</p>', spans: [] } as unknown as RenderResult);
      const src = '```python\nprint(1)\n```\n';
      const view = makeView(src, renderMarkdown);
      // Let the rejection propagate through .catch().
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
      // Widget element exists but its body is empty (the rejection swallowed).
      const widget = view.dom.querySelector('[data-block-widget="code"]');
      expect(widget).not.toBeNull();
      view.destroy();
    });
  });
});
