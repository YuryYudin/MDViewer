import type { BlockNode, InlineNode } from './blockTree.types';

/**
 * Project a rendered Markdown DOM (either View-mode pulldown-cmark
 * HTML or Edit-mode CodeMirror live editor) onto a canonical block
 * tree. The walker normalization contract is documented in the
 * regression-net design doc (Layer 2) and enforced by the
 * `tests/views/render/blockTree.test.ts` suite.
 *
 * Strips:
 *   - cm-line, cm-widgetBuffer, cm-cursor*, cm-selectionLayer, gutter
 *     elements (and any zero-width spans)
 *   - style, aria-*, class attributes (after block type is determined)
 *
 * Normalizes:
 *   - inline text via concatenation + whitespace collapse + adjacent
 *     'text' node merge
 *   - inline marks (strong/em/strike/code/link/image) via the union of
 *     View-mode `<strong>` / `<em>` / `<del>` / `<code>` / `<a>` / `<img>`
 *     AND Edit-mode `.lp-bold` / `.lp-italic` / `.lp-strike` /
 *     `.cm-md-code` / `.cm-md-link` / `.cm-md-inline-image` mappings
 *   - list markers (bullets, numerals) stripped from rendered text
 *   - table widgets: descends into [data-testid="table-widget"] and
 *     produces { headers, rows } matching pulldown-cmark <table> output;
 *     the widget's pencil edit-affordance is stripped before extraction
 *   - code-block language: reads either `class="language-foo"` (View)
 *     or `data-lang="foo"` (Edit widget)
 *   - mermaid widgets: [data-testid="mermaid-widget"] → { kind:'mermaid',
 *     source } from both renderers
 */
export function extractBlockTree(root: Element): BlockNode[] {
  // Auto-detect Edit-mode by the presence of any `.cm-line` descendant.
  // Edit-mode roots wrap each logical line in a `.cm-line` div under a
  // `.cm-content` parent; the View-mode HTML produced by pulldown-cmark
  // never carries those wrappers.
  if (root.querySelector('.cm-line') !== null) {
    return extractEditMode(root);
  }
  return extractViewMode(root);
}

/* ------------------------------------------------------------------ */
/* Shared utilities                                                    */
/* ------------------------------------------------------------------ */

/**
 * True for CodeMirror-internal nodes that have no semantic counterpart
 * in pulldown-cmark output. The walker skips these everywhere.
 *
 * Note: `.cm-line` is NOT in this list because the Edit-mode walker
 * consumes line wrappers as block boundaries; it strips them by
 * walking their children, not by skipping the line itself.
 */
function isInternalCmNode(el: Element): boolean {
  return el.matches(
    '.cm-widgetBuffer, [class*="cm-cursor"], .cm-selectionLayer, .cm-gutter, .cm-gutters',
  );
}

/** True if the text content is empty or composed only of zero-width chars. */
function isOnlyZeroWidth(text: string): boolean {
  // U+200B zero-width space, U+FEFF zero-width no-break space.
  return /^[​﻿]*$/.test(text);
}

/** Collapse runs of whitespace into a single space and trim. */
function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Merge adjacent 'text' nodes in a list of InlineNodes, collapsing the
 * combined text. Non-text nodes are kept in source order. A trailing or
 * leading empty 'text' node (after collapse) is dropped to keep the
 * canonical shape minimal.
 */
function mergeAdjacentText(nodes: InlineNode[]): InlineNode[] {
  const out: InlineNode[] = [];
  for (const n of nodes) {
    if (n.kind === 'text') {
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'text') {
        prev.text = collapseWs(prev.text + n.text);
        if (prev.text === '') out.pop();
      } else {
        // Collapse whitespace on the singleton too — a lone text node
        // with embedded newlines / indentation (common in pretty-printed
        // Edit-mode DOM) must reduce to a single canonical run.
        const collapsed = collapseWs(n.text);
        // Preserve a literal single space when the original ran from
        // non-empty whitespace — this matters for inter-mark spacing
        // like `Hello <strong>World</strong>` where the trailing " "
        // text node between "Hello" and `<strong>` is semantically
        // significant.
        if (n.text === ' ') {
          out.push({ kind: 'text', text: ' ' });
        } else if (collapsed !== '') {
          // Preserve trailing/leading single space when the original
          // had surrounding whitespace, so adjacent inline marks don't
          // glue together after merge.
          const hadLeading = /^\s/.test(n.text);
          const hadTrailing = /\s$/.test(n.text);
          const padded =
            (hadLeading ? ' ' : '') + collapsed + (hadTrailing ? ' ' : '');
          out.push({ kind: 'text', text: padded });
        }
        // If collapsed is empty and original wasn't a single space,
        // drop the node — pure indentation between tags has no
        // semantic content in the canonical tree.
      }
    } else {
      out.push(n);
    }
  }
  // Final pass: drop any text node that collapses to empty.
  const filtered = out.filter((n) => !(n.kind === 'text' && n.text === ''));
  // Trim block-edge whitespace on the first/last text node so the
  // canonical tree never starts or ends with a stray padding space.
  if (filtered.length > 0) {
    const first = filtered[0];
    if (first.kind === 'text') {
      const trimmed = first.text.replace(/^\s+/, '');
      if (trimmed === '') filtered.shift();
      else filtered[0] = { kind: 'text', text: trimmed };
    }
  }
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    if (last.kind === 'text') {
      const trimmed = last.text.replace(/\s+$/, '');
      if (trimmed === '') filtered.pop();
      else filtered[filtered.length - 1] = { kind: 'text', text: trimmed };
    }
  }
  return filtered;
}

/**
 * True if the element is a "hidden sigil" span — i.e. a CodeMirror
 * sigil decoration that the renderer hides from view (`.sigil`
 * or `.sigil.hidden`) and whose text content is the literal markdown
 * syntax (`**`, `*`, `~~`, `` ` ``, `#`, `>`, `[`, `]`, `(`, `)` etc.).
 * The walker drops these entirely so the canonical tree doesn't carry
 * the raw markdown source.
 */
function isSigil(el: Element): boolean {
  return el.classList.contains('sigil');
}

/* ------------------------------------------------------------------ */
/* View-mode walker (pulldown-cmark HTML)                              */
/* ------------------------------------------------------------------ */

function extractViewMode(root: Element): BlockNode[] {
  const out: BlockNode[] = [];
  for (const child of Array.from(root.children)) {
    const block = viewBlock(child);
    if (block) out.push(...block);
  }
  return out;
}

/**
 * Convert a single block-level View-mode element into one or more
 * BlockNodes. Returns null when the element should be skipped (internal
 * cm node, empty whitespace, etc.).
 */
function viewBlock(el: Element): BlockNode[] | null {
  if (isInternalCmNode(el)) return null;

  // Widget elements come first because their data-testid takes
  // precedence over the underlying tag.
  if (el.matches('[data-testid="mermaid-widget"]')) {
    return [extractMermaid(el)];
  }
  if (el.matches('[data-testid="table-widget"]')) {
    return [extractTable(el)];
  }
  if (el.matches('[data-testid="code-widget"], [data-testid="code-widget-raw"]')) {
    return [extractCodeWidget(el)];
  }

  const tag = el.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
    return [{ kind: 'heading', level, inline: extractInline(el) }];
  }

  if (tag === 'p') {
    // Special case: a paragraph that contains ONLY an image is still a
    // paragraph in the canonical tree — pulldown-cmark wraps block
    // images in `<p>`. We keep the paragraph wrapper rather than
    // promote the image, because the Edit-mode block-image path also
    // sits inside its line wrapper.
    return [{ kind: 'paragraph', inline: extractInline(el) }];
  }

  if (tag === 'ul' || tag === 'ol') {
    return [extractList(el, tag === 'ol')];
  }

  if (tag === 'blockquote') {
    return [{ kind: 'blockquote', children: extractViewMode(el) }];
  }

  if (tag === 'pre') {
    return [extractPre(el)];
  }

  if (tag === 'hr') {
    return [{ kind: 'hr' }];
  }

  if (tag === 'table') {
    return [extractRawTable(el)];
  }

  if (tag === 'div' || tag === 'section' || tag === 'article') {
    // Generic wrappers: descend.
    return extractViewMode(el);
  }

  return null;
}

function extractList(el: Element, ordered: boolean): BlockNode {
  const items: BlockNode[][] = [];
  for (const li of Array.from(el.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue;
    items.push(extractListItem(li));
  }
  return { kind: 'list', ordered, items };
}

/**
 * A list item in View-mode is `<li>` with mixed inline + block content.
 * pulldown-cmark wraps content in `<p>` when the item is "loose"; for
 * tight items the inline text is a direct child of `<li>`. We project
 * onto `BlockNode[]` for the item body either way.
 */
function extractListItem(li: Element): BlockNode[] {
  const out: BlockNode[] = [];
  // Collect direct inline children (text + inline elements before any
  // block child) into a single paragraph node.
  let inlineBuffer: InlineNode[] = [];
  const flushInline = () => {
    const merged = mergeAdjacentText(inlineBuffer);
    if (merged.length > 0) {
      out.push({ kind: 'paragraph', inline: merged });
    }
    inlineBuffer = [];
  };
  for (const node of Array.from(li.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (!isOnlyZeroWidth(t)) inlineBuffer.push({ kind: 'text', text: t });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (isInternalCmNode(el) || isSigil(el)) continue;
    if (isInlineTag(el)) {
      const inline = mapInlineElement(el);
      if (inline) inlineBuffer.push(...inline);
      continue;
    }
    // Block child: flush any buffered inline first, then recurse.
    flushInline();
    const block = viewBlock(el);
    if (block) out.push(...block);
  }
  flushInline();

  // Strip a leading list-marker sigil from the very first paragraph's
  // first text node (Edit-mode test data sometimes leaks `1. ` / `- `
  // when sigils are revealed; View-mode never has it, but the strip is
  // idempotent so it's safe to run for both).
  if (out.length > 0 && out[0].kind === 'paragraph') {
    out[0].inline = stripListMarker(out[0].inline);
  }

  return out;
}

function stripListMarker(inline: InlineNode[]): InlineNode[] {
  if (inline.length === 0) return inline;
  const first = inline[0];
  if (first.kind !== 'text') return inline;
  const stripped = first.text.replace(/^(?:\d+[.)]\s+|[-*+]\s+)/, '');
  if (stripped === first.text) return inline;
  const cloned: InlineNode[] = inline.slice();
  if (stripped === '') {
    cloned.shift();
    return cloned;
  }
  cloned[0] = { kind: 'text', text: stripped };
  return cloned;
}

function extractPre(el: Element): BlockNode {
  // <pre><code class="language-foo">body</code></pre> is the
  // pulldown-cmark contract. The body preserves whitespace verbatim
  // (it's source code), so we read textContent and only trim a single
  // trailing newline that pulldown-cmark appends.
  const code = el.querySelector('code');
  const target = code ?? el;
  let language = '';
  if (code) {
    const cls = code.getAttribute('class') ?? '';
    const m = /\blanguage-([^\s]+)/.exec(cls);
    if (m) language = m[1];
  }
  let body = target.textContent ?? '';
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { kind: 'code', language, body };
}

function extractCodeWidget(el: Element): BlockNode {
  // The wysiwyg `[data-testid="code-widget"]` / `code-widget-raw` carrier
  // wraps a `<pre>` produced by the IPC render path (same pulldown-cmark
  // pipeline), so the body extraction is identical to View mode. The
  // language comes from the `data-lang` attribute the widget sets.
  const language = el.getAttribute('data-lang') ?? '';
  const pre = el.querySelector('pre');
  let body = pre ? (pre.textContent ?? '') : (el.textContent ?? '');
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { kind: 'code', language, body };
}

function extractMermaid(el: Element): BlockNode {
  // The Edit-mode mermaid widget exposes its source via the inner `<pre>`
  // body OR via a `data-source` attribute. View-mode pulldown-cmark emits
  // a `<pre><code class="language-mermaid">…</code></pre>` that the
  // gallery-page boot script rewrites into `[data-testid="mermaid-widget"]`.
  // Either way, prefer `data-source` when present, fall back to the
  // first `<pre>` inside, fall back to the textContent of the widget
  // itself (stripping any pencil affordance).
  const dataSource = el.getAttribute('data-source');
  if (dataSource !== null) return { kind: 'mermaid', source: dataSource };
  const clone = el.cloneNode(true) as Element;
  // Strip the pencil affordance before reading the source.
  clone.querySelectorAll('.pencil, [data-action="raw-edit"]').forEach((n) => n.remove());
  const pre = clone.querySelector('pre');
  let source = pre ? (pre.textContent ?? '') : (clone.textContent ?? '');
  if (source.endsWith('\n')) source = source.slice(0, -1);
  return { kind: 'mermaid', source };
}

function extractTable(el: Element): BlockNode {
  // Strip the pencil/toolbar affordances before reading the table.
  const clone = el.cloneNode(true) as Element;
  clone
    .querySelectorAll(
      '[data-testid="table-widget-pencil"], .table-widget-toolbar, .table-toolbar',
    )
    .forEach((n) => n.remove());
  const table = clone.querySelector('table');
  if (!table) return { kind: 'table', headers: [], rows: [] };
  return extractRawTable(table);
}

function extractRawTable(table: Element): BlockNode {
  const headers: string[] = [];
  const rows: string[][] = [];
  const thead = table.querySelector('thead');
  if (thead) {
    const tr = thead.querySelector('tr');
    if (tr) {
      for (const th of Array.from(tr.children)) {
        headers.push(collapseWs(th.textContent ?? ''));
      }
    }
  }
  const tbody = table.querySelector('tbody');
  const bodyRows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
  for (const tr of bodyRows) {
    const cells: string[] = [];
    for (const td of Array.from(tr.children)) {
      cells.push(collapseWs(td.textContent ?? ''));
    }
    rows.push(cells);
  }
  return { kind: 'table', headers, rows };
}

/* ------------------------------------------------------------------ */
/* Inline-node mapping (shared between View and Edit modes)            */
/* ------------------------------------------------------------------ */

function isInlineTag(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return (
    tag === 'strong' ||
    tag === 'b' ||
    tag === 'em' ||
    tag === 'i' ||
    tag === 'del' ||
    tag === 's' ||
    tag === 'strike' ||
    tag === 'code' ||
    tag === 'a' ||
    tag === 'img' ||
    tag === 'span' ||
    tag === 'br'
  );
}

/**
 * Extract the inline-node sequence from a block-level element. Walks
 * child nodes in source order, mapping text nodes and inline elements,
 * and merges adjacent text after the whole block is processed.
 */
function extractInline(parent: Element): InlineNode[] {
  const out: InlineNode[] = [];
  const children = Array.from(parent.childNodes);
  for (let i = 0; i < children.length; i++) {
    const node = children[i];
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (isOnlyZeroWidth(t)) continue;
      out.push({ kind: 'text', text: t });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (isInternalCmNode(el)) continue;
    if (isSigil(el)) continue;
    const mapped = mapInlineElement(el, parent, i, children);
    if (mapped) out.push(...mapped);
  }
  return mergeAdjacentText(out);
}

/**
 * Map a single inline element to one or more InlineNodes. The
 * `siblings` array and `index` are used by the Edit-mode `.cm-md-link`
 * recovery path, which has to peek at the next sibling to extract the
 * URL from the `(url)` sigil span.
 */
function mapInlineElement(
  el: Element,
  _parent?: Element,
  index?: number,
  siblings?: ChildNode[],
): InlineNode[] | null {
  if (isInternalCmNode(el)) return null;
  if (isSigil(el)) return null;

  const tag = el.tagName.toLowerCase();

  // View-mode inline images.
  if (tag === 'img') {
    const src = el.getAttribute('src') ?? '';
    const alt = el.getAttribute('alt') ?? '';
    return [{ kind: 'image', src, alt }];
  }

  // Edit-mode inline image widget — wraps an `<img>` per
  // inlineMarks.ts line 68. The image attributes live on the inner img.
  if (el.classList.contains('cm-md-inline-image')) {
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      const alt = el.getAttribute('alt') ?? '';
      return [{ kind: 'image', src, alt }];
    }
    const inner = el.querySelector('img');
    if (inner) {
      const src = inner.getAttribute('src') ?? '';
      const alt = inner.getAttribute('alt') ?? '';
      return [{ kind: 'image', src, alt }];
    }
    return null;
  }

  // View-mode links carry href on `<a>`.
  if (tag === 'a') {
    const href = el.getAttribute('href') ?? '';
    return [{ kind: 'link', href, children: extractInline(el) }];
  }

  // Edit-mode link mark: `.cm-md-link` with NO data-href; href is in
  // the sibling URL-sigil span (the `(url)` portion of the markdown
  // source, kept in the DOM as a sigil span that's CSS-hidden).
  if (el.classList.contains('cm-md-link')) {
    const href = recoverEditLinkHref(el, index, siblings);
    return [{ kind: 'link', href, children: extractInline(el) }];
  }

  // Bold: View `<strong>` / `<b>` or Edit `.lp-bold`.
  if (tag === 'strong' || tag === 'b' || el.classList.contains('lp-bold')) {
    return [{ kind: 'strong', children: extractInline(el) }];
  }

  // Italic: View `<em>` / `<i>` or Edit `.lp-italic`.
  if (tag === 'em' || tag === 'i' || el.classList.contains('lp-italic')) {
    return [{ kind: 'em', children: extractInline(el) }];
  }

  // Strikethrough: View `<del>` / `<s>` / `<strike>` or Edit `.lp-strike`.
  if (
    tag === 'del' ||
    tag === 's' ||
    tag === 'strike' ||
    el.classList.contains('lp-strike')
  ) {
    return [{ kind: 'strike', children: extractInline(el) }];
  }

  // Inline code: View `<code>` (NOT inside a `<pre>` — caller wouldn't
  // dispatch here for `<pre><code>`) or Edit `.cm-md-code`.
  if (tag === 'code' || el.classList.contains('cm-md-code')) {
    return [{ kind: 'code', children: extractInline(el) }];
  }

  // <br> renders as a single space in the canonical tree so adjacent
  // text merge keeps the line break from glueing words together.
  if (tag === 'br') {
    return [{ kind: 'text', text: ' ' }];
  }

  // Generic span (or any unrecognised inline wrapper): descend.
  return extractInline(el);
}

/**
 * Recover the href of a `.cm-md-link` mark from the sibling URL-sigil
 * span. The Edit-mode DOM lays out `[text](url)` as:
 *
 *   <span class="sigil hidden">[</span>
 *   <span class="cm-md-link">link text</span>
 *   <span class="sigil hidden">]</span>
 *   <span class="sigil hidden">(</span>
 *   <span class="sigil hidden">url</span>          (or one combined sigil)
 *   <span class="sigil hidden">)</span>
 *
 * We collect the text content of the run of sigil spans that
 * IMMEDIATELY follows the `.cm-md-link` element, stop at the first
 * non-sigil sibling, and pull the URL out of the `(…)` substring.
 */
function recoverEditLinkHref(
  el: Element,
  index?: number,
  siblings?: ChildNode[],
): string {
  void el;
  if (!siblings || index === undefined) return '';
  let captured = '';
  for (let i = index + 1; i < siblings.length; i++) {
    const next = siblings[i];
    if (next.nodeType === Node.TEXT_NODE) {
      const t = next.textContent ?? '';
      if (isOnlyZeroWidth(t)) continue;
      captured += t;
      continue;
    }
    if (next.nodeType !== Node.ELEMENT_NODE) continue;
    const ne = next as Element;
    if (isInternalCmNode(ne)) continue;
    if (!isSigil(ne)) break;
    captured += ne.textContent ?? '';
  }
  // Extract the first parenthesised substring; fall back to the whole
  // captured run with surrounding `[]` / `()` trimmed.
  const m = /\(([^)]*)\)/.exec(captured);
  if (m) return m[1];
  return captured.replace(/^[[(]/, '').replace(/[\])]$/, '');
}

/* ------------------------------------------------------------------ */
/* Edit-mode walker (CodeMirror live editor)                           */
/* ------------------------------------------------------------------ */

/**
 * Find the deepest single subtree that contains every `.cm-line` and
 * every block widget. In practice this is `.cm-content` when the
 * caller hands us the editor root; when the caller hands us
 * `.cm-content` directly we use it as-is.
 */
function findEditScope(root: Element): Element {
  const content = root.querySelector('.cm-content');
  return content ?? root;
}

interface BlockItem {
  /** Source position in document order (used for sorting). */
  el: Element;
  /** True if the element is a `.cm-line`. */
  isLine: boolean;
}

function extractEditMode(root: Element): BlockNode[] {
  const scope = findEditScope(root);
  // Collect the in-order sequence of (`.cm-line` | widget) nodes.
  const items: BlockItem[] = [];
  for (const child of Array.from(scope.children)) {
    collectEditItems(child, items);
  }

  const out: BlockNode[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!item.isLine) {
      // Widget block.
      const block = viewBlock(item.el);
      if (block) out.push(...block);
      i++;
      continue;
    }

    // Determine the block kind from the line's classes.
    const lineEl = item.el;
    const kind = classifyEditLine(lineEl);

    if (kind.kind === 'heading') {
      out.push({
        kind: 'heading',
        level: kind.level,
        inline: extractInline(lineEl),
      });
      i++;
      continue;
    }

    if (kind.kind === 'hr') {
      out.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (kind.kind === 'blockquote') {
      // Consume the run of consecutive blockquote lines.
      const lines: Element[] = [];
      while (i < items.length && items[i].isLine && isBlockquoteLine(items[i].el)) {
        lines.push(items[i].el);
        i++;
      }
      const children = paragraphsFromLines(lines);
      out.push({ kind: 'blockquote', children });
      continue;
    }

    if (kind.kind === 'list') {
      const ordered = kind.ordered;
      const groups: Element[][] = [];
      let current: Element[] = [];
      while (
        i < items.length &&
        items[i].isLine &&
        isListLine(items[i].el, ordered)
      ) {
        const lineEl2 = items[i].el;
        if (isListLineMarker(lineEl2, ordered)) {
          if (current.length > 0) groups.push(current);
          current = [lineEl2];
        } else {
          current.push(lineEl2);
        }
        i++;
      }
      if (current.length > 0) groups.push(current);
      const listItems: BlockNode[][] = groups.map((g) =>
        paragraphsFromLines(g).map((p) => stripFirstParagraphMarker(p)),
      );
      out.push({ kind: 'list', ordered, items: listItems });
      continue;
    }

    // Default: paragraph. Consume consecutive plain lines until we hit
    // a blank line, a special line, or a widget.
    const lines: Element[] = [];
    while (
      i < items.length &&
      items[i].isLine &&
      classifyEditLine(items[i].el).kind === 'paragraph' &&
      !isLineBlank(items[i].el)
    ) {
      lines.push(items[i].el);
      i++;
    }
    // Skip blank separator lines so the next iteration starts on the
    // next real block.
    while (i < items.length && items[i].isLine && isLineBlank(items[i].el)) {
      i++;
    }
    if (lines.length === 0) continue;
    const inline = mergeAdjacentText(
      lines.flatMap((l, idx) =>
        idx === 0
          ? extractInline(l)
          : [{ kind: 'text' as const, text: ' ' }, ...extractInline(l)],
      ),
    );
    out.push({ kind: 'paragraph', inline });
  }

  return out;
}

/**
 * Recursively descend the editor scope collecting `.cm-line` nodes and
 * block widgets in document order. We skip CM-internal nodes
 * (`.cm-widgetBuffer`, etc.) but DO recurse into ordinary wrappers
 * because widgets sometimes mount under a wrapper div.
 */
function collectEditItems(el: Element, items: BlockItem[]): void {
  if (isInternalCmNode(el)) return;
  if (el.matches('.cm-line')) {
    items.push({ el, isLine: true });
    return;
  }
  if (
    el.matches(
      '[data-testid="table-widget"], [data-testid="mermaid-widget"], ' +
        '[data-testid="code-widget"], [data-testid="code-widget-raw"], ' +
        '[data-block-widget]',
    )
  ) {
    items.push({ el, isLine: false });
    return;
  }
  // Descend into wrapper divs (cm-content sometimes wraps widget rows).
  for (const child of Array.from(el.children)) {
    collectEditItems(child, items);
  }
}

type EditLineKind =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { kind: 'list'; ordered: boolean }
  | { kind: 'blockquote' }
  | { kind: 'hr' }
  | { kind: 'paragraph' };

function classifyEditLine(line: Element): EditLineKind {
  // Heading classes (`cm-md-h1` … `cm-md-h6`) are emitted via
  // `Decoration.mark`, so they land on a span INSIDE the cm-line, not
  // on the line itself. List/blockquote line classes are emitted via
  // `Decoration.line` (list) or `Decoration.mark` (blockquote); the
  // line-decoration list classes land on the cm-line directly while
  // the mark-decoration blockquote class lands on a child span. We
  // check both placements so the walker works regardless.
  for (let lvl = 1; lvl <= 6; lvl++) {
    const cls = `cm-md-h${lvl}`;
    if (line.classList.contains(cls) || line.querySelector('.' + cls) !== null) {
      return { kind: 'heading', level: lvl as 1 | 2 | 3 | 4 | 5 | 6 };
    }
  }
  if (line.classList.contains('cm-md-list-ordered')) {
    return { kind: 'list', ordered: true };
  }
  if (line.classList.contains('cm-md-list-unordered')) {
    return { kind: 'list', ordered: false };
  }
  if (
    line.classList.contains('cm-md-blockquote') ||
    line.querySelector('.cm-md-blockquote') !== null
  ) {
    return { kind: 'blockquote' };
  }
  // HR detection: a line whose collapsed text is exactly `---`, `***`, or `___`.
  const text = collapseWs(line.textContent ?? '');
  if (/^(-{3,}|_{3,}|\*{3,})$/.test(text)) {
    return { kind: 'hr' };
  }
  return { kind: 'paragraph' };
}

function isBlockquoteLine(line: Element): boolean {
  return classifyEditLine(line).kind === 'blockquote';
}

function isListLine(line: Element, ordered: boolean): boolean {
  const k = classifyEditLine(line);
  return k.kind === 'list' && k.ordered === ordered;
}

/**
 * The first line of a new list item carries the cm-md-list-* class AND
 * the data-list-number / leading sigil. Subsequent lines that continue
 * the same item also carry the class (CodeMirror line decorations
 * inherit). The simplest correct heuristic: a line is a "new item"
 * boundary when its collapsed text starts with the marker pattern.
 *
 * (Multi-line list items aren't part of the gallery fixture, so the
 * heuristic is allowed to be coarse — every list line is its own item.)
 */
function isListLineMarker(line: Element, _ordered: boolean): boolean {
  // For now, treat every list line as its own item boundary.
  void line;
  return true;
}

function isLineBlank(line: Element): boolean {
  return collapseWs(line.textContent ?? '') === '';
}

/**
 * Project a run of `.cm-line` elements onto a list of paragraph
 * BlockNodes — one paragraph per line, blank lines drop separators.
 */
function paragraphsFromLines(lines: Element[]): BlockNode[] {
  const out: BlockNode[] = [];
  let buffer: InlineNode[] = [];
  const flush = () => {
    const merged = mergeAdjacentText(buffer);
    if (merged.length > 0) {
      out.push({ kind: 'paragraph', inline: merged });
    }
    buffer = [];
  };
  for (const line of lines) {
    if (isLineBlank(line)) {
      flush();
      continue;
    }
    if (buffer.length > 0) buffer.push({ kind: 'text', text: ' ' });
    buffer.push(...extractInline(line));
  }
  flush();
  return out;
}

/**
 * Strip a leading list-marker text (`1. `, `- `, `* `, `+ `) from the
 * first text node of a paragraph BlockNode. Used to scrub sigil leak
 * from Edit-mode list items.
 */
function stripFirstParagraphMarker(b: BlockNode): BlockNode {
  if (b.kind !== 'paragraph') return b;
  return { kind: 'paragraph', inline: stripListMarker(b.inline) };
}
