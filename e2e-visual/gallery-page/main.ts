import { StateEffect, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

import { mountLiveEditor } from '../../src/views/LiveEditor';
import { inlineMarks, inlineMarksKeymap } from '../../src/views/decorations/inlineMarks';
import { blockWidgets } from '../../src/views/decorations/blocks';
import { tables } from '../../src/views/decorations/tables';
import { commentHighlights } from '../../src/views/decorations/commentHighlights';
import '../../src/views/decorations/decorations.css';
import '../../src/views/decorations/comment-highlights.css';
import { extractBlockTree } from '../../src/views/render/blockTree';
import type { RenderResult, ResolveOutcome, SaveOutcome, Thread } from '../../src/types-generated';
import { defaultSettings } from './defaultSettings';

// Path inside the served publicDir. We co-located the gallery sidecar
// in e2e/fixtures/ so both the .md and the .comments.json sit one
// fetch hop away.
const GALLERY_URL = '/render-gallery.md';
const SIDECAR_URL = '/render-gallery.md.comments.json';

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status}`);
  return r.text();
}

/**
 * Minimal `renderMarkdown` stub for the gallery host.
 *
 * `blockWidgets` (src/views/decorations/blocks.ts) calls this once per
 * fenced-code / html / image block to populate the widget body. The
 * mermaid kind never reaches this path — its body is painted by the
 * Vite-aliased `mermaid-stub.ts` instead, via the dynamic
 * `import('mermaid')` inside blocks.ts.
 *
 * For the visual gallery we only need:
 *   - a deterministic, paint-stable HTML payload (so the snapshot diff
 *     doesn't depend on a real Markdown→HTML renderer being plumbed in),
 *   - the same `<pre><code class="language-XXX">…</code></pre>` shape the
 *     production renderer emits (so the widget DOM matches what
 *     `paintBody` and downstream selectors expect),
 *   - the original source text inside the `<code>` block, escaped for
 *     HTML safety.
 *
 * The `src_map` and `tasks` fields on `RenderResult` are `#[serde(default)]`
 * in Rust and unused on the frontend; we return empty arrays.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function renderMarkdownStub(source: string): Promise<RenderResult> {
  // Strip a leading fenced-code wrapper if present so the body shows the
  // code rather than the fence syntax. The block widget hands us the raw
  // fence (e.g. "```python\n…code…\n```") — we pull the language tag and
  // the inner content.
  const fenceMatch = source.match(/^```([^\n]*)\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    const lang = fenceMatch[1].trim().toLowerCase();
    const body = fenceMatch[2];
    const langClass = lang ? ` class="language-${lang}"` : '';
    return {
      html: `<pre><code${langClass}>${escapeHtml(body)}</code></pre>`,
      text_spans: [],
    };
  }
  return {
    html: `<p>${escapeHtml(source)}</p>`,
    text_spans: [],
  };
}

async function main() {
  const [source, sidecarText] = await Promise.all([
    fetchText(GALLERY_URL),
    fetchText(SIDECAR_URL),
  ]);
  const sidecar = JSON.parse(sidecarText) as { threads: Thread[] };

  const ipc = {
    async saveDocument(_tabId: string, _contents: string): Promise<SaveOutcome> {
      // Returns a benign `ok` outcome. auto_save is disabled in the
      // settings below, so this should never actually fire — but
      // returning `undefined` here would break callers that read
      // `outcome.kind`.
      return { kind: 'ok', etag: null };
    },
    async setDirty(_path: string, _dirty: boolean): Promise<void> {},
    async resolveAnchor(_tabId: string, anchor: Thread['anchor']): Promise<ResolveOutcome> {
      // Deterministic: echo the sidecar's stored offsets back.
      return { kind: 'resolved', start: anchor.start, end: anchor.end };
    },
    renderMarkdown: renderMarkdownStub,
  };

  const host = document.getElementById('editor-host')!;
  const live = mountLiveEditor(host, ipc, {
    tabId: 'gallery',
    path: '/fixtures/render-gallery.md',
    source,
    settings: defaultSettings(),
    threads: sidecar.threads,
    // Design doc lists `initialMode: 'edit'`, but the live-editor type
    // `LiveEditorMode` is the post-Phase-1 union `'render' | 'raw'`.
    // The mount-args table elsewhere specifies
    // `settings.editor.default_open_mode = 'render'`, so the matching
    // typed value here is `'render'`. Deviation documented in C1's
    // completion notes (Rule 3 — design-doc typo from pre-WYSIWYG era).
    initialMode: 'render',
  });

  // Append the decoration extensions exactly the way
  // `src/views/Document.ts` does it after mounting the LiveEditor.
  // Without these, the editor renders bare `.cm-line` divs and none
  // of the `.cm-md-h1`, `.cm-md-link`, `.cm-md-inline-image`,
  // `[data-testid="code-widget"]`, `[data-testid="mermaid-widget"]`,
  // or `[data-testid="table-widget"]` carriers the gallery spec
  // depends on ever materialize. (C3 fix — original C1 boot only
  // mounted the bare LiveEditor.)
  const decorationExtensions: Extension[] = [
    markdown({ base: markdownLanguage, extensions: [GFM] }),
    inlineMarks(),
    inlineMarksKeymap(),
    blockWidgets({ renderMarkdown: (s: string) => ipc.renderMarkdown(s) }),
    tables(),
    commentHighlights(),
  ];
  live.editorView.dispatch({
    effects: StateEffect.appendConfig.of(decorationExtensions),
  });

  // F2 fix: force CodeMirror to materialize every `.cm-line` in the
  // document. CM6 virtualizes lines outside the scroller viewport, so
  // the Layer 2 walker only sees what's in view. The Layer 1 pixel
  // diff also wants the editor at its full content height (no
  // scrollbar) so screenshot crops aren't clipped. Set the scroller
  // to auto height + no max + visible overflow so CM renders the
  // entire document.
  const scroller = live.editorView.scrollDOM as HTMLElement;
  scroller.style.height = 'auto';
  scroller.style.maxHeight = 'none';
  scroller.style.overflow = 'visible';

  // Flip data-ready AFTER mountLiveEditor returns AND one rAF tick so
  // CSS has had one paint cycle to settle. Playwright awaits this flag
  // before any screenshot.
  //
  // Wait two rAF ticks: the first tick lets the decoration extensions
  // (just appended) apply their first paint; the second gives the
  // async block-widget bodies one microtask to settle. Playwright then
  // performs its own per-locator wait-for-visible inside each shot, so
  // anything still in flight blocks the diff at the spec level rather
  // than the boot level.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  // F1 (oracle.spec.ts): expose extractBlockTree on window so the
  // Playwright oracle spec can call it inside page.evaluate against
  // both the View-mode HTML (built into a detached <div> from the
  // render-cli output) and the Edit-mode DOM (#editor-host).
  // jsdom can't host the full CodeMirror decoration stack faithfully,
  // which is why B3's vitest oracle stays skipped; the real-browser
  // Playwright spec is the actual oracle gate.
  (window as unknown as { __extractBlockTree: typeof extractBlockTree }).__extractBlockTree =
    extractBlockTree;

  document.body.setAttribute('data-ready', 'true');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('gallery boot failed', err);
});
