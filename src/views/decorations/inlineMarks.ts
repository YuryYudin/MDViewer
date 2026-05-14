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
import { EditorSelection, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type KeyBinding,
  keymap,
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
        ? 'lp-bold'
        : name === 'Emphasis'
          ? 'lp-italic'
          : name === 'Strikethrough'
            ? 'lp-strike'
            : 'cm-md-code';
    out.push({ from, to, deco: Decoration.mark({ class: cls }) });

    // Sigil widths come from the source bytes rather than the lezer
    // child cursor — InlineCode wraps a single backtick (one char), the
    // others wrap two chars (`**`, `__`/`_`, `~~`). Reading the literal
    // byte at `from` lets us figure out the right width for `*` vs `_`
    // emphasis without an extra child traversal.
    const head = doc.sliceString(from, Math.min(to, from + 2));
    const isDouble = head.startsWith('**') || head.startsWith('__') || head.startsWith('~~');
    const isSingle =
      !isDouble && (head.startsWith('*') || head.startsWith('_') || head.startsWith('`'));
    const width = isDouble ? 2 : isSingle ? 1 : 0;
    if (width === 0) return;

    const inside = selectionTouches(state, from, to);

    if (name === 'InlineCode') {
      // InlineCode keeps the original Decoration.replace behaviour: no
      // spec consumes a `.cm-md-code .sigil` element, and the
      // class-rename / mark-switch only targets bold/italic/strike per
      // the Phase A finish design (Decisions §4).
      if (!inside) {
        out.push(sigil(from, from + width));
        out.push(sigil(to - width, to));
      }
      return;
    }

    // bold / italic / strike: emit Decoration.mark on the sigil chars
    // so the source bytes survive in the rendered DOM. The wrapper
    // class string is `sigil` when the caret intersects the mark, or
    // `sigil hidden` otherwise. The render-raw-toggle e2e spec keys
    // on the `.hidden` class membership directly — a CSS-only display
    // toggle would not flip the spec.
    const sigilClass = inside ? 'sigil' : 'sigil hidden';
    out.push({
      from,
      to: from + width,
      deco: Decoration.mark({ class: sigilClass }),
    });
    out.push({
      from: to - width,
      to,
      deco: Decoration.mark({ class: sigilClass }),
    });
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
  let urlText = '';
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
        if (cursor.name === 'URL') {
          // F2 fix: capture the URL string for the Layer 2 walker.
          // The `.cm-md-link` decoration carries the visible text only
          // (`Click` for `[Click](https://example.com)`), with the URL
          // hidden behind a sigil. The walker's `recoverEditLinkHref`
          // sibling-walk is fragile (it depends on the exact sigil
          // layout in the live DOM). Stamping `data-href` on the mark
          // gives the walker a direct, robust source of truth that
          // works regardless of how CodeMirror lays out the sigils.
          urlText = doc.sliceString(cursor.from, cursor.to);
        }
      }
    } while (cursor.nextSibling());
  }
  if (textStart >= 0 && textEnd > textStart) {
    out.push({
      from: textStart,
      to: textEnd,
      deco: Decoration.mark({
        class: 'cm-md-link',
        attributes: urlText ? { 'data-href': urlText } : {},
      }),
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

/* ------------------------------------------------------------------ */
/* B.3 — Cmd+B / Cmd+I / Cmd+E / Cmd+K toggle keybindings              */
/* ------------------------------------------------------------------ */

/**
 * Toggle the main selection wrapped in `sigil`. If the selection
 * already starts and ends with the sigil string, strip it; otherwise
 * insert it. Caret-positioning invariant: after an insert the
 * selection still covers the same content (shifted by sigil.length);
 * after a strip the selection covers the unwrapped content. Empty
 * selections (carets) collapse to inserting `sigil + sigil` and place
 * the caret in between, so the user can keep typing inside the new
 * mark.
 */
function toggleSymmetricWrap(view: EditorView, sigil: string): boolean {
  const sel = view.state.selection.main;
  const { from, to } = sel;
  const sigilLen = sigil.length;

  if (from === to) {
    // Empty selection — insert paired sigils and park caret between.
    view.dispatch({
      changes: { from, insert: sigil + sigil },
      selection: EditorSelection.single(from + sigilLen),
      userEvent: 'input.toggle',
    });
    return true;
  }

  const selected = view.state.sliceDoc(from, to);
  if (
    selected.length >= sigilLen * 2 &&
    selected.startsWith(sigil) &&
    selected.endsWith(sigil)
  ) {
    // Strip: replace `<sigil>X<sigil>` with `X`. Selection covers X.
    const inner = selected.slice(sigilLen, selected.length - sigilLen);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: EditorSelection.single(from, from + inner.length),
      userEvent: 'input.toggle',
    });
    return true;
  }

  // Insert: wrap selection with sigils, keep selection over the
  // original content (shifted by sigilLen).
  view.dispatch({
    changes: [
      { from, insert: sigil },
      { from: to, insert: sigil },
    ],
    selection: EditorSelection.single(from + sigilLen, to + sigilLen),
    userEvent: 'input.toggle',
  });
  return true;
}

/**
 * Cmd+E variant. Inline code typically uses a single backtick, but
 * when the selection itself contains a backtick the wrapping fence
 * must widen to two backticks so the inner backtick stays literal
 * (CommonMark §6.1: the opening run must be a non-substring of the
 * code content). Strip handles both widths symmetrically.
 */
function toggleInlineCode(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const { from, to } = sel;

  if (from === to) {
    // Empty selection — default to single-backtick pair.
    return toggleSymmetricWrap(view, '`');
  }

  const selected = view.state.sliceDoc(from, to);

  // Strip if the selection already wraps a code mark — try the wider
  // ``…`` first so `` ``a`b`` `` doesn't trip a false-match on the
  // single-backtick branch. The startsWith('``') guard on the second
  // branch protects against half-stripping a `` `` `` selection.
  if (selected.startsWith('``') && selected.endsWith('``') && selected.length >= 4) {
    return toggleSymmetricWrap(view, '``');
  }
  if (
    !selected.startsWith('``') &&
    selected.startsWith('`') &&
    selected.endsWith('`') &&
    selected.length >= 2
  ) {
    return toggleSymmetricWrap(view, '`');
  }

  // Insert: pick the fence width based on whether the selection
  // contains a literal backtick.
  const fence = selected.includes('`') ? '``' : '`';
  return toggleSymmetricWrap(view, fence);
}

/**
 * Cmd+K — link skeleton. Inserts `[text](url-placeholder)` at the
 * selection; if the selection is non-empty, its contents become the
 * link text and only the `url-placeholder` is selected so the user
 * can type directly to fill it in.
 */
function insertLinkSkeleton(view: EditorView): boolean {
  const sel = view.state.selection.main;
  const { from, to } = sel;
  const selected = view.state.sliceDoc(from, to);
  const text = selected.length > 0 ? selected : 'text';
  const placeholder = 'url-placeholder';
  const inserted = `[${text}](${placeholder})`;

  // The url-placeholder sits between `](` and the trailing `)`.
  // Its offset relative to `inserted` is:
  //   1 ("[") + text.length + 2 ("](")
  const placeholderStart = from + 1 + text.length + 2;
  const placeholderEnd = placeholderStart + placeholder.length;

  view.dispatch({
    changes: { from, to, insert: inserted },
    selection: EditorSelection.single(placeholderStart, placeholderEnd),
    userEvent: 'input.toggle',
  });
  return true;
}

/**
 * Returns a CodeMirror keymap extension wiring Cmd+B / Cmd+I / Cmd+E
 * / Cmd+K to the toggle commands above. `Mod-` resolves to Cmd on
 * macOS and Ctrl elsewhere — the binding is platform-correct without
 * a manual platform check.
 */
export function inlineMarksKeymap(): Extension {
  const bindings: KeyBinding[] = [
    { key: 'Mod-b', preventDefault: true, run: (view) => toggleSymmetricWrap(view, '**') },
    { key: 'Mod-i', preventDefault: true, run: (view) => toggleSymmetricWrap(view, '*') },
    { key: 'Mod-e', preventDefault: true, run: (view) => toggleInlineCode(view) },
    { key: 'Mod-k', preventDefault: true, run: (view) => insertLinkSkeleton(view) },
  ];
  return keymap.of(bindings);
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
