import { syntaxTree } from '@codemirror/language';
import {
  type Extension,
  type EditorState,
  type Range,
  StateField,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
} from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';

import type { RenderResult } from '../../types-generated';

/**
 * Subset of the Ipc surface this extension consumes. Accepting just the one
 * IPC method (instead of the whole `Ipc`) keeps the extension testable —
 * tests pass a `vi.fn()` and assert on call counts without constructing a
 * full Ipc stub.
 */
export interface BlockWidgetsIpc {
  renderMarkdown(source: string): Promise<RenderResult>;
}

export interface BlockWidgetsOptions {
  renderMarkdown: BlockWidgetsIpc['renderMarkdown'];
}

/**
 * Discriminated tag stored on each widget. Drives both the
 * `data-block-widget="…"` DOM attribute (which tests inspect) and the
 * mermaid-only post-render side effect.
 */
type WidgetKind = 'mermaid' | 'code' | 'html' | 'image' | 'table';

/**
 * Identifies one block of source we want to replace with an atomic widget.
 * `kind` drives the rendered tag; `source` is the slice of state.doc that
 * gets sent through `renderMarkdown` to produce the widget body.
 *
 * `infoString` carries the raw FencedCode info-string (e.g. "python",
 * "mermaid", "python {.hl}") when `kind` is "code" or "mermaid". Other
 * kinds default to "" — the widget root carries `data-lang=""` for
 * non-fenced widgets which is harmless (the wysiwyg specs only select
 * `[data-lang="python"]` / `[data-lang="mermaid"]`).
 */
interface BlockSpec {
  kind: WidgetKind;
  from: number;
  to: number;
  source: string;
  infoString: string;
}

/**
 * Cached widget HTML keyed by `source`. The Decoration RangeSet is recomputed
 * every transaction (so caret-in/out toggles cost no IPC), but the rendered
 * HTML for a given source is stable — caching by source string means a
 * caret-in / caret-out round trip costs zero `renderMarkdown` calls. The
 * cache lives in the closure of `blockWidgets(...)` so it survives across
 * all transactions and across StateField/ViewPlugin boundaries.
 */
type RenderCache = Map<string, string>;

/**
 * Walks the current lezer tree and produces a `BlockSpec` for every block
 * the spec asks us to replace:
 *
 *   - FencedCode whose CodeInfo starts with "mermaid" → mermaid widget
 *   - any other FencedCode → code widget
 *   - HTMLBlock → html widget
 *   - Image whose direct parent Paragraph contains ONLY that image →
 *     block-level image widget. (Paragraph-internal images with sibling
 *     text are handled by A.5's inlineMarks.) The detection rule is
 *     "Image.from == Paragraph.from && Image.to == Paragraph.to" which is
 *     a structural test that doesn't require iterating Paragraph children.
 *   - Table → table widget
 */
function findBlocks(state: EditorState): BlockSpec[] {
  const out: BlockSpec[] = [];
  const tree = syntaxTree(state);

  // We capture the most recently-entered Paragraph so the Image-detection
  // branch can compare bounds without walking children. Paragraphs cannot
  // nest in CommonMark, so a single variable is enough.
  let currentParagraph: { from: number; to: number } | null = null;

  tree.iterate({
    enter(node: SyntaxNodeRef) {
      switch (node.name) {
        case 'Paragraph':
          currentParagraph = { from: node.from, to: node.to };
          return;
        case 'FencedCode': {
          const source = state.doc.sliceString(node.from, node.to);
          const infoString = readCodeInfo(state, node);
          const kind: WidgetKind = infoString.toLowerCase().startsWith('mermaid')
            ? 'mermaid'
            : 'code';
          out.push({ kind, from: node.from, to: node.to, source, infoString });
          // Don't descend — CodeMark / CodeInfo / CodeText are
          // internal-only and we've already classified the block.
          return false;
        }
        case 'HTMLBlock': {
          const source = state.doc.sliceString(node.from, node.to);
          out.push({ kind: 'html', from: node.from, to: node.to, source, infoString: '' });
          return false;
        }
        case 'Image': {
          // "Image-as-only-paragraph-child" test: the direct-parent
          // Paragraph's bounds match the Image's bounds. When they don't
          // match (the paragraph contains text alongside the image),
          // we yield to A.5's inlineMarks.
          if (
            currentParagraph &&
            currentParagraph.from === node.from &&
            currentParagraph.to === node.to
          ) {
            const source = state.doc.sliceString(node.from, node.to);
            out.push({ kind: 'image', from: node.from, to: node.to, source, infoString: '' });
            return false;
          }
          return;
        }
        case 'Table': {
          const source = state.doc.sliceString(node.from, node.to);
          out.push({ kind: 'table', from: node.from, to: node.to, source, infoString: '' });
          // Don't descend — TableHeader / TableRow / TableCell are
          // collapsed under the atomic widget in Phase 1. (Phase 2's
          // tables extension will reach into these for per-cell editing.)
          return false;
        }
        default:
          return;
      }
    },
    leave(node: SyntaxNodeRef) {
      if (node.name === 'Paragraph') currentParagraph = null;
    },
  });

  return out;
}

/**
 * Inspect the FencedCode node's direct children for a CodeInfo and return
 * the raw info-string text (trimmed). Returns "" when no CodeInfo is
 * present (info-string-less fence like ```` ``` ````). Callers downstream
 * lowercase + first-token-split for `data-lang`, and `.startsWith("mermaid")`
 * for mermaid detection (case-insensitively).
 */
function readCodeInfo(state: EditorState, fence: SyntaxNodeRef): string {
  const node = fence.node;
  let child = node.firstChild;
  while (child) {
    if (child.name === 'CodeInfo') {
      return state.doc.sliceString(child.from, child.to).trim();
    }
    child = child.nextSibling;
  }
  return '';
}

/**
 * Normalize a CodeInfo string into the value emitted on `data-lang`:
 * first whitespace-separated token, lowercased. "JavaScript" → "javascript";
 * "python {.hl}" → "python"; "" → "".
 */
function normalizeLang(infoString: string): string {
  return infoString.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

/**
 * Returns true when the editor's main selection range intersects [from, to].
 * "Intersects" includes touching either edge — caret AT `from` or AT `to`
 * is treated as caret-in so the user can keep typing without the widget
 * snapping back over their cursor.
 */
function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  const main = state.selection.main;
  return !(main.to < from || main.from > to);
}

/**
 * Mermaid library handle cache. The dynamic `import('mermaid')` is shared
 * across all mermaid widgets in a session — initialising mermaid more than
 * once costs a noticeable amount of CPU and the library itself warns about
 * double-init.
 */
let mermaidPromise: Promise<{ run: (opts: { nodes: HTMLElement[] }) => Promise<unknown> }> | null =
  null;
/** Test seam: reset the cached mermaid module between vi.doMock cycles. */
export function __resetMermaidCacheForTests(): void {
  mermaidPromise = null;
}
function loadMermaid(): Promise<{ run: (opts: { nodes: HTMLElement[] }) => Promise<unknown> }> {
  if (!mermaidPromise) {
    mermaidPromise = (async () => {
      const mod = (await import('mermaid')) as unknown as {
        default: {
          initialize: (cfg: { startOnLoad: boolean; theme?: string }) => void;
          run: (opts: { nodes: HTMLElement[] }) => Promise<unknown>;
        };
      };
      mod.default.initialize({ startOnLoad: false, theme: 'default' });
      return mod.default;
    })();
  }
  return mermaidPromise;
}

/**
 * Side-effect bookkeeping for the widget population path. The StateField
 * holds the Decoration RangeSet (block widgets require state-side
 * provision per CodeMirror's "no block widgets from plugins" rule), but
 * the IPC fire-and-forget happens lazily inside `toDOM`. We thread the
 * cache + IPC fn through the WidgetType via constructor params; both come
 * from the closure of `blockWidgets(...)` so they stay stable across
 * StateField updates.
 */
interface WidgetCtx {
  readonly cache: RenderCache;
  readonly ipcRenderMarkdown: BlockWidgetsIpc['renderMarkdown'];
  readonly inFlight: Set<string>;
  /**
   * Called after each successful renderMarkdown so the host view can
   * request a re-measure — async-resolved widget bodies can change line
   * height (mermaid SVGs in particular).
   */
  readonly onRendered: () => void;
}

/**
 * The widget body. Each instance owns one block of source — `source` is the
 * cache key, so two widgets over identical source dedupe to the same
 * cached HTML.
 */
class BlockWidget extends WidgetType {
  constructor(
    readonly kind: WidgetKind,
    readonly source: string,
    readonly infoString: string,
    private readonly ctx: WidgetCtx,
  ) {
    super();
  }

  /**
   * Two widget instances are equal when they represent the same block kind
   * and the same source slice. CodeMirror uses `eq` to decide whether to
   * reuse the existing DOM — without this, every transaction would rebuild
   * the widget DOM (and re-issue the mermaid.run call). The `infoString`
   * intentionally does NOT participate in equality: it's derived purely
   * from `source` (same fence text → same info string) so structural eq
   * already covers it.
   */
  eq(other: WidgetType): boolean {
    return (
      other instanceof BlockWidget && other.kind === this.kind && other.source === this.source
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-block-widget', this.kind);
    // `data-lang` mirrors the fence info-string (first whitespace token,
    // lowercased) so the wysiwyg `[data-testid="code-widget"][data-lang="…"]`
    // compound selector resolves. Non-fenced widgets carry data-lang=""
    // which is harmless — no spec selects them by language.
    root.setAttribute('data-lang', normalizeLang(this.infoString));
    // `data-testid` is the wysiwyg spec contract: `code-widget` for code
    // fences, `mermaid-widget` for mermaid fences. Other kinds don't
    // need a testid alias yet (no spec selects them this way).
    if (this.kind === 'code') {
      root.setAttribute('data-testid', 'code-widget');
    } else if (this.kind === 'mermaid') {
      root.setAttribute('data-testid', 'mermaid-widget');
    }
    // Atomic block widgets are non-editable surfaces. CM 6 needs the
    // `contenteditable=false` hint so caret motion via arrow keys skips
    // over the widget instead of landing inside its DOM.
    root.contentEditable = 'false';

    const cached = this.ctx.cache.get(this.source);
    if (cached !== undefined) {
      paintBody(root, this.kind, cached);
    } else if (this.ctx.inFlight.has(this.source)) {
      // Another widget instance for the same source has already fired the
      // IPC; just wait for the cache to fill. (Same-source dedup matters
      // only when two block widgets share the same source on the same
      // tick — e.g. two identical fenced-code blocks.)
    } else {
      this.ctx.inFlight.add(this.source);
      void this.ctx
        .ipcRenderMarkdown(this.source)
        .then((res) => {
          this.ctx.inFlight.delete(this.source);
          this.ctx.cache.set(this.source, res.html);
          // Patch the DOM in place. CodeMirror's update path doesn't need
          // to know — the next transaction's StateField recompute will
          // produce a structurally identical RangeSet (same `eq` result),
          // so the existing DOM stays.
          paintBody(root, this.kind, res.html);
          this.ctx.onRendered();
        })
        .catch(() => {
          this.ctx.inFlight.delete(this.source);
          // Swallow render failures. The widget stays empty; better than
          // throwing into CodeMirror's transaction pipeline.
        });
    }
    return root;
  }

  /**
   * Atomic widgets ignore every interior event. The widget body has no
   * interactive children in Phase 1; events fall through to the editor.
   */
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Paste the IPC HTML into the widget root. We parse via DOMParser instead
 * of assigning `innerHTML` to keep the no-innerHTML house style consistent
 * with `Document.ts`'s `paintRenderFromHtml`.
 *
 * For non-mermaid widgets the paint is synchronous: parse, replace
 * children, return.
 *
 * For mermaid widgets the paint is two-phased and **awaits**
 * `mermaid.run` before exposing the rendered body to the DOM. The wysiwyg
 * code-block.spec.ts polls for the `<svg>` inside `[data-testid="mermaid-widget"]`
 * and expects it to land within the spec's timeout; a fire-and-forget
 * `mermaid.run` lets the spec race against the mermaid module's async
 * import and rendering pipeline, so we await deterministically.
 *
 * The fresh inner `<div>` strategy: parse the IPC HTML into an off-DOM
 * `<div>`, hand THAT node to `mermaid.run` (so mermaid's in-place
 * rewriting doesn't double-render if the StateField re-emits the same
 * widget on the next transaction), then attach the rewritten content to
 * the widget root after the await resolves. Failures fall through to
 * attaching the IPC HTML as-is (so the user at least sees the source).
 */
function paintBody(root: HTMLElement, kind: WidgetKind, html: string): void {
  if (kind === 'mermaid') {
    void paintMermaidBody(root, html);
    return;
  }
  root.replaceChildren();
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const node of Array.from(parsed.body.childNodes)) {
    root.appendChild(node);
  }
}

/**
 * Awaited mermaid render path. The fresh inner `<div>` is created off-DOM,
 * IPC HTML is parsed into it, `mermaid.run({ nodes: [inner] })` is awaited
 * (logging-not-throwing on failure), and then the inner div's children
 * are attached to the widget root. The widget root remains empty until
 * mermaid.run completes — that's the contract the wysiwyg spec polls on.
 */
async function paintMermaidBody(root: HTMLElement, html: string): Promise<void> {
  const inner = document.createElement('div');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const node of Array.from(parsed.body.childNodes)) {
    inner.appendChild(node);
  }
  try {
    const m = await loadMermaid();
    await m.run({ nodes: [inner] });
  } catch (err) {
    // Mermaid failures are logged-but-not-thrown so a bad diagram doesn't
    // crash the editor; we still attach the (un-rewritten) IPC HTML so
    // the user sees the source rather than an empty widget.
    // eslint-disable-next-line no-console
    console.warn('mermaid.run failed:', err);
  }
  // Move inner's children into the widget root only AFTER mermaid.run
  // settled. Use a while-shift loop instead of children iteration so we
  // don't observe the live HTMLCollection mutating under us.
  root.replaceChildren();
  while (inner.firstChild) {
    root.appendChild(inner.firstChild);
  }
}

/**
 * Build the DecorationSet for the current state. Skips blocks whose range
 * the main selection intersects (caret-in collapse). The returned ranges
 * are pre-sorted by `from` because `tree.iterate` visits in document order.
 */
function buildDecorations(state: EditorState, ctx: WidgetCtx): DecorationSet {
  const blocks = findBlocks(state);
  const ranges: Range<Decoration>[] = [];
  for (const b of blocks) {
    if (selectionIntersects(state, b.from, b.to)) continue;
    const widget = new BlockWidget(b.kind, b.source, b.infoString, ctx);
    ranges.push(
      Decoration.replace({
        widget,
        block: true,
      }).range(b.from, b.to),
    );
  }
  return Decoration.set(ranges);
}

/**
 * The CodeMirror extension. Block-level Decoration.replace ranges MUST come
 * from a StateField (the `decorations` ViewPlugin path is gated against
 * block widgets — see CodeMirror's "Block decorations may not be specified
 * via plugins" check). The StateField recomputes on every transaction;
 * caret-in / caret-out toggles ride this recompute path with no IPC cost
 * because the per-source HTML cache lives in the closure.
 */
export function blockWidgets(opts: BlockWidgetsOptions): Extension {
  const cache: RenderCache = new Map();
  const inFlight = new Set<string>();

  // `requestMeasure` lives on EditorView; the WidgetType only has access
  // to a `view` parameter inside `toDOM`/`updateDOM`. We thread the
  // currently-mounted view via a settable reference filled in by an
  // EditorView.updateListener — that's the canonical way to bridge from
  // a state-side StateField back into the View's measure pipeline.
  let liveView: EditorView | null = null;
  const ctx: WidgetCtx = {
    cache,
    ipcRenderMarkdown: opts.renderMarkdown,
    inFlight,
    onRendered: () => {
      // Without the nudge, an async-resolved HTML body would paint into
      // the existing widget DOM but the editor's viewport math wouldn't
      // notice — usually fine, but mermaid SVGs can change line height
      // after rendering.
      liveView?.requestMeasure();
    },
  };

  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, ctx);
    },
    update(value, tr: Transaction) {
      // Recompute on doc changes (the lezer tree shifted) and selection
      // changes (caret-in / caret-out toggle). Other transactions (e.g.
      // viewport-only scrolls) leave the widget set untouched.
      if (tr.docChanged || tr.selection) {
        return buildDecorations(tr.state, ctx);
      }
      return value;
    },
    // The StateField output IS the decoration set the view consumes.
    // Block widgets are permitted from a `provide` that hands the
    // DecorationSet directly (not through a function) to
    // `EditorView.decorations`. `Facet.from(field)` does exactly that.
    provide: (f) => EditorView.decorations.from(f),
  });

  // ViewPlugin that just maintains the `liveView` reference + flags
  // arrow-key motion across widgets as atomic. We can't put this on the
  // StateField because `atomicRanges` is view-side and we need the
  // EditorView handle for `requestMeasure`.
  const viewBinding = EditorView.updateListener.of((update) => {
    liveView = update.view;
  });

  // EditorView.atomicRanges expects a function over the view; the
  // function is allowed here because the underlying RangeSet still
  // originated in the StateField (block widgets check happens on the
  // decorations facet, not on atomicRanges).
  const atomicRangesExt = EditorView.atomicRanges.of(
    (view) => view.state.field(field, false) ?? Decoration.none,
  );

  return [field, viewBinding, atomicRangesExt];
}
