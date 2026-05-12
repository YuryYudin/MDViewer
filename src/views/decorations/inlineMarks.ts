/**
 * inlineMarks — CodeMirror 6 extension that walks the lezer-markdown
 * syntax tree per transaction and emits caret-aware mark/sigil
 * decorations for all six inline construct classes the wireframes
 * call out:
 *
 *   1. Inline marks   — StrongEmphasis / Emphasis / Strikethrough / InlineCode
 *   2. ATX headings   — ATXHeading1..ATXHeading6 (HeaderMark sigil)
 *   3. Blockquotes    — Blockquote (QuoteMark sigil)
 *   4. List markers   — BulletList / OrderedList (ListMark sigil + ::before css)
 *   5. Links          — Link (LinkMark + URL sigils)
 *   6. Inline images  — Image inside a multi-child Paragraph
 *
 * Block-level constructs the design assigns to A.6 (tables, fenced
 * code, sole-child image paragraphs) are intentionally untouched here.
 *
 * The decoration set is recomputed in a ViewPlugin update hook on
 * `docChanged | viewportChanged | selectionSet` so caret moves alone
 * re-paint sigils — this is what makes the "type and reveal, move
 * away and hide" experience feel instant.
 */

import { syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type { SyntaxNodeRef } from '@lezer/common';

/**
 * Returns true if any selection range (caret or expanded selection)
 * intersects [from, to). Endpoint-inclusive on the left, exclusive on
 * the right is the standard CodeMirror convention.
 *
 * We use a "permissive" intersection — a caret exactly at `to` also
 * counts as inside the range, because the user typing at the end of a
 * mark should keep that mark's sigils revealed.
 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

/** Widget that renders an inline `<img>` for a paragraph-internal image. */
class InlineImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }

  eq(other: InlineImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.setAttribute('src', this.src);
    img.setAttribute('alt', this.alt);
    img.className = 'cm-md-inline-image';
    return img;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Heading level → class name. ATX heading nodes are named
 * `ATXHeading1` … `ATXHeading6` in lezer-markdown; this map collapses
 * the suffix digit into the corresponding `cm-md-hN` class.
 */
const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
};

/** A single decoration with its document position, kept sortable by `from`. */
interface PositionedDeco {
  from: number;
  to: number;
  deco: Decoration;
}

/**
 * Walks the syntax tree once and collects all decorations into a
 * sortable array. The walk is iterative; we look at every node and
 * dispatch on `name`.
 */
function buildDecorations(state: EditorState): DecorationSet {
  const out: PositionedDeco[] = [];
  const sigil = (from: number, to: number): PositionedDeco => ({
    from,
    to,
    deco: Decoration.replace({}),
  });

  const tree = syntaxTree(state);
  tree.iterate({
    enter(node: SyntaxNodeRef) {
      handleNode(node, state, out, sigil);
    },
  });

  // RangeSetBuilder needs strictly ascending starts; mixing mark and
  // replace decorations from a tree walk means we sometimes get
  // out-of-order entries (e.g. an image's replace at pos 8 collected
  // after the surrounding paragraph's bold mark at pos 12). Sort once,
  // breaking ties with `from` asc → smaller `to` first (replace beats
  // mark when they share a start, matching CM's preference for the
  // narrower override).
  out.sort((a, b) => a.from - b.from || a.to - b.to);

  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of out) {
    builder.add(entry.from, entry.to, entry.deco);
  }
  return builder.finish();
}

/**
 * Dispatch table for a single tree node. Pulled out of `buildDecorations`
 * so each branch is independently testable and so the function bodies
 * stay short enough to read.
 */
function handleNode(
  node: SyntaxNodeRef,
  state: EditorState,
  out: PositionedDeco[],
  sigil: (from: number, to: number) => PositionedDeco,
): void {
  const { name, from, to } = node;
  const doc = state.doc;

  if (
    name === 'StrongEmphasis' ||
    name === 'Emphasis' ||
    name === 'Strikethrough' ||
    name === 'InlineCode'
  ) {
    const cls =
      name === 'StrongEmphasis'
        ? 'cm-md-bold'
        : name === 'Emphasis'
          ? 'cm-md-italic'
          : name === 'Strikethrough'
            ? 'cm-md-strike'
            : 'cm-md-code';
    out.push({ from, to, deco: Decoration.mark({ class: cls }) });

    // Sigil-hide unless caret/selection intersects. We compute the
    // sigil widths from the source bytes rather than walking child
    // nodes — InlineCode wraps a single backtick (one char), the
    // others wrap two chars (`**`, `__`/`_`, `~~`). Reading the
    // literal byte at `from` lets us figure out the right width for
    // `*` vs `_` emphasis without an extra child traversal.
    if (!selectionTouches(state, from, to)) {
      const head = doc.sliceString(from, Math.min(to, from + 2));
      const isDouble = head.startsWith('**') || head.startsWith('__') || head.startsWith('~~');
      const isSingle =
        !isDouble && (head.startsWith('*') || head.startsWith('_') || head.startsWith('`'));
      const width = isDouble ? 2 : isSingle ? 1 : 0;
      if (width > 0) {
        out.push(sigil(from, from + width));
        out.push(sigil(to - width, to));
      }
    }
    return;
  }

  if (name in HEADING_CLASS) {
    out.push({ from, to, deco: Decoration.mark({ class: HEADING_CLASS[name] }) });
    if (!selectionTouches(state, from, to)) {
      // Read the heading source and find the run of `#` plus the
      // single space after them. The lezer HeaderMark child gives us
      // the exact range, but reading the raw source is cheaper and
      // doesn't require a node.cursor() detour.
      const line = doc.sliceString(from, to);
      const match = /^(#{1,6})\s/.exec(line);
      if (match) {
        out.push(sigil(from, from + match[0].length));
      }
    }
    return;
  }

  if (name === 'Blockquote') {
    out.push({ from, to, deco: Decoration.mark({ class: 'cm-md-blockquote' }) });
    // Blockquotes may span multiple lines via lazy continuation. We
    // hide the leading `> ` on each line UNLESS the caret/selection
    // intersects THAT SPECIFIC LINE — checking against the whole
    // blockquote node would keep the marker visible across the entire
    // block whenever the caret was anywhere in it.
    let pos = from;
    while (pos < to) {
      const line = doc.lineAt(pos);
      const lineStart = line.from;
      const lineEnd = Math.min(line.to, to);
      const text = doc.sliceString(lineStart, lineEnd);
      const m = /^(\s*>\s?)/.exec(text);
      if (m && !selectionTouches(state, line.from, line.to)) {
        out.push(sigil(lineStart, lineStart + m[0].length));
      }
      pos = line.to + 1;
    }
    return;
  }

  if (name === 'ListItem') {
    // Determine ordered vs unordered by walking up to the parent list
    // — `node.node.parent?.name` is `BulletList` or `OrderedList`.
    const parent = node.node.parent;
    const ordered = parent?.name === 'OrderedList';
    const cls = ordered ? 'cm-md-list-ordered' : 'cm-md-list-unordered';

    // Read the leading marker on the list-item's first line.
    const line = doc.lineAt(from);
    const lineText = doc.sliceString(line.from, line.to);
    let markerLen = 0;
    let number = '';
    if (ordered) {
      const m = /^(\s*)(\d+)([.)])\s+/.exec(lineText);
      if (m) {
        markerLen = m[0].length;
        number = m[2];
      }
    } else {
      const m = /^(\s*)([-*+])\s+/.exec(lineText);
      if (m) {
        markerLen = m[0].length;
      }
    }
    if (markerLen > 0) {
      // Line-decoration carries the class + (for ordered lists) a
      // data attribute that the ::before pseudo-element reads.
      out.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({
          class: cls,
          attributes: ordered ? { 'data-list-number': number } : undefined,
        }),
      });
      // Sigil-hide the literal marker bytes. Always hidden — the
      // visible marker is the ::before pseudo-element. Tests asserted
      // hiding regardless of caret position, matching the design: the
      // marker is purely decorative once rendered.
      out.push(sigil(line.from, line.from + markerLen));
    }
    return;
  }

  if (name === 'Link') {
    handleLink(node, state, out, sigil);
    return;
  }

  if (name === 'Image') {
    handleImage(node, state, out);
    return;
  }
}

function handleLink(
  node: SyntaxNodeRef,
  state: EditorState,
  out: PositionedDeco[],
  sigil: (from: number, to: number) => PositionedDeco,
): void {
  const { from, to } = node;
  const doc = state.doc;
  // Find the closing `]` of the link text. The structure is
  //   [ text ] ( url )         — inline link
  //   [ text ] [ ref ]         — reference link
  // We rely on lezer's child layout (LinkMark / URL / LinkLabel)
  // rather than re-parsing the bytes from scratch.
  const cursor = node.node.cursor();
  let textStart = -1;
  let textEnd = -1;
  const sigilRanges: Array<[number, number]> = [];
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'LinkMark') {
        // First LinkMark = `[`, second = `]`, third = `(` or `[`, fourth = `)` or `]`.
        sigilRanges.push([cursor.from, cursor.to]);
        if (textStart === -1) {
          textStart = cursor.to;
        } else if (textEnd === -1) {
          textEnd = cursor.from;
        }
      } else if (cursor.name === 'URL' || cursor.name === 'LinkLabel') {
        sigilRanges.push([cursor.from, cursor.to]);
      }
    } while (cursor.nextSibling());
  }
  if (textStart >= 0 && textEnd > textStart) {
    out.push({
      from: textStart,
      to: textEnd,
      deco: Decoration.mark({ class: 'cm-md-link' }),
    });
  }
  if (!selectionTouches(state, from, to)) {
    for (const [a, b] of sigilRanges) out.push(sigil(a, b));
  }
  void doc; // unused but kept for symmetry with the other handlers
}

function handleImage(node: SyntaxNodeRef, state: EditorState, out: PositionedDeco[]): void {
  // A "block image" — sole child of a paragraph — is owned by A.6.
  // Detect it by walking up: if the parent is a Paragraph and the
  // image's range equals the paragraph's content range (or the
  // paragraph has no other inline children), skip.
  const parent = node.node.parent;
  if (parent?.name === 'Paragraph') {
    const trimmedStart = parent.from;
    const trimmedEnd = parent.to;
    // Count non-image inline children on the paragraph. If the only
    // child IS this image and the image fills the paragraph (modulo
    // whitespace), it's a block image — leave for A.6.
    let inlineChildCount = 0;
    const c = parent.cursor();
    if (c.firstChild()) {
      do {
        inlineChildCount++;
      } while (c.nextSibling());
    }
    if (inlineChildCount === 1 && node.from === trimmedStart && node.to === trimmedEnd) {
      return;
    }
  }

  // Pull the src + alt from the source bytes. The lezer Image node
  // has LinkMark/URL children mirroring Link's layout; we read the
  // raw markdown text and regex it — simpler than walking the tree.
  const raw = state.doc.sliceString(node.from, node.to);
  const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(raw);
  if (!m) return;
  const [, alt, src] = m;

  if (selectionTouches(state, node.from, node.to)) {
    // Caret inside — leave the source visible for editing; do NOT
    // emit the widget replace. (Tests pin this behaviour.)
    return;
  }
  out.push({
    from: node.from,
    to: node.to,
    deco: Decoration.replace({ widget: new InlineImageWidget(src, alt) }),
  });
}

/**
 * The exported extension. ViewPlugin recomputes the decoration set on
 * any update flagged with docChanged/viewportChanged/selectionSet —
 * caret moves alone qualify, which is what powers the reveal-on-enter
 * behaviour without a doc edit.
 */
export function inlineMarks(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state);
      }
      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildDecorations(update.state);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    },
  );
}
