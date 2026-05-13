import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

import { inlineMarks, inlineMarksKeymap } from '../../../src/views/decorations/inlineMarks';

/**
 * Spin up a real EditorView with the markdown language + the inlineMarks
 * extension. We attach to document.body so CodeMirror renders the DOM
 * for inspection. Each test cleans up via the afterEach hook below.
 */
function mountEditor(doc: string, caret = 0): {
  view: EditorView;
  root: HTMLElement;
} {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage }), inlineMarks()],
  });
  const view = new EditorView({ state, parent: root });
  return { view, root };
}

function setSelection(view: EditorView, from: number, to: number = from): void {
  view.dispatch({ selection: EditorSelection.single(from, to) });
}

/** Returns the rendered text of the editor's content DOM (after decorations). */
function renderedText(view: EditorView): string {
  return view.contentDOM.textContent ?? '';
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('inlineMarks extension', () => {
  it('exports a CodeMirror extension (array or extension value)', () => {
    const ext = inlineMarks();
    expect(ext).toBeDefined();
  });

  describe('inline-mark sigil hide/reveal', () => {
    it('hides bold ** sigils when caret is outside the mark', () => {
      const { view } = mountEditor('hello **bold** world', 0);
      // Outside the bold range — sigils stay in the source bytes but the
      // wrapper class string is `sigil hidden` so CSS hides them.
      const sigils = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(true));
      // The bold text content survives in the DOM.
      expect(renderedText(view).includes('bold')).toBe(true);
    });

    it('reveals bold ** sigils when caret enters the mark', () => {
      const { view } = mountEditor('hello **bold** world', 0);
      // Move caret into the bold content (between the two stars).
      setSelection(view, 9); // inside "bold"
      const sigils = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(false));
    });

    it('hides italic _ sigils outside, reveals on caret intersect', () => {
      const { view } = mountEditor('a _emph_ b', 0);
      let sigils = Array.from(view.contentDOM.querySelectorAll('.lp-italic .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(true));
      setSelection(view, 4); // inside "emph"
      sigils = Array.from(view.contentDOM.querySelectorAll('.lp-italic .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(false));
    });

    it('hides strike ~~ sigils outside, reveals when caret intersects', () => {
      const { view } = mountEditor('a ~~gone~~ b', 0);
      let sigils = Array.from(view.contentDOM.querySelectorAll('.lp-strike .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(true));
      setSelection(view, 5); // inside "gone"
      sigils = Array.from(view.contentDOM.querySelectorAll('.lp-strike .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(false));
    });

    it('hides inline-code backticks outside, reveals when caret intersects', () => {
      // InlineCode keeps Decoration.replace (no spec consumes lp-code).
      const { view } = mountEditor('a `x` b', 0);
      expect(renderedText(view).includes('`x`')).toBe(false);
      setSelection(view, 3); // inside "x"
      expect(renderedText(view).includes('`x`')).toBe(true);
    });

    it('reveals when selection range (not just caret) intersects a mark', () => {
      const { view } = mountEditor('a **bold** b', 0);
      // Selection from 0..3 intersects the leading "**" sigil at 2..4.
      setSelection(view, 0, 3);
      const sigils = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(false));
    });

    it('keeps neighbouring marks on the same line hidden when one has the caret', () => {
      // Two bold marks on one line; caret inside the first.
      const { view } = mountEditor('**one** plus **two**', 4);
      const wrappers = view.contentDOM.querySelectorAll('.lp-bold');
      expect(wrappers.length).toBe(2);
      // First wrapper's sigils revealed.
      const firstSigils = Array.from(wrappers[0].querySelectorAll('.sigil'));
      expect(firstSigils.length).toBe(2);
      firstSigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(false));
      // Second wrapper's sigils still hidden.
      const secondSigils = Array.from(wrappers[1].querySelectorAll('.sigil'));
      expect(secondSigils.length).toBe(2);
      secondSigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(true));
    });

    it('applies lp-bold class on the StrongEmphasis content range', () => {
      const { view } = mountEditor('hello **bold** world', 0);
      const boldEl = view.contentDOM.querySelector('.lp-bold');
      expect(boldEl).not.toBeNull();
      expect(boldEl?.textContent).toContain('bold');
    });

    it('applies lp-italic class on Emphasis content', () => {
      const { view } = mountEditor('a _emph_ b', 0);
      const el = view.contentDOM.querySelector('.lp-italic');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('emph');
    });

    it('applies lp-strike class on Strikethrough content', () => {
      const { view } = mountEditor('a ~~gone~~ b', 0);
      const el = view.contentDOM.querySelector('.lp-strike');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('gone');
    });

    it('applies md-code class on InlineCode content', () => {
      const { view } = mountEditor('a `x` b', 0);
      const el = view.contentDOM.querySelector('.cm-md-code');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('x');
    });
  });

  describe('sigil reveal via class mutation (A5)', () => {
    it('caret outside bold mark — 2 sigil elements with .hidden, 0 without', () => {
      const { view } = mountEditor('A **bold** word', 0);
      const sigils = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(sigils.length).toBe(2);
      sigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(true));
      const visible = view.contentDOM.querySelectorAll('.lp-bold .sigil:not(.hidden)');
      expect(visible.length).toBe(0);
    });

    it('caret inside bold mark — 2 sigil elements without .hidden, italic sigils on same line keep .hidden', () => {
      // "A **bold** and *italic* word"
      //  0123456789012345678901234567
      // Bold range starts at 2 (the first `*`); caret inside "bold" at offset 5.
      const { view } = mountEditor('A **bold** and *italic* word', 5);
      const boldSigils = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(boldSigils.length).toBe(2);
      boldSigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(false));
      const italicSigils = Array.from(view.contentDOM.querySelectorAll('.lp-italic .sigil'));
      expect(italicSigils.length).toBeGreaterThan(0);
      italicSigils.forEach((s) => expect(s.classList.contains('hidden')).toBe(true));
    });

    it('caret crossing the mark boundary flips the sigil classes', () => {
      // "**bold** word"
      //  0123456789012
      // Bold range [0,8); position 10 is outside, position 3 is inside "bold".
      const { view } = mountEditor('**bold** word', 10);
      const sigilsOutside = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(sigilsOutside.length).toBe(2);
      expect(sigilsOutside.every((s) => s.classList.contains('hidden'))).toBe(true);

      setSelection(view, 3);
      const sigilsInside = Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil'));
      expect(sigilsInside.length).toBe(2);
      expect(sigilsInside.every((s) => !s.classList.contains('hidden'))).toBe(true);
    });

    it('wrapper class for bold is lp-bold not cm-md-bold', () => {
      const { view } = mountEditor('**bold**', 0);
      expect(view.contentDOM.querySelector('.lp-bold')).not.toBeNull();
      expect(view.contentDOM.querySelector('.cm-md-bold')).toBeNull();
    });

    it('InlineCode wrapper class stays cm-md-code (not renamed to lp-code)', () => {
      const { view } = mountEditor('A `code` span', 0);
      expect(view.contentDOM.querySelector('.cm-md-code')).not.toBeNull();
      expect(view.contentDOM.querySelector('.lp-code')).toBeNull();
    });
  });

  describe('ATX heading sigils', () => {
    it('hides the leading # of an H1 when the caret is on a different line', () => {
      const { view } = mountEditor('# Title\nbody', 9); // caret on "body" line
      const text = renderedText(view);
      expect(text.includes('# Title')).toBe(false);
      expect(text.includes('Title')).toBe(true);
    });

    it('reveals the # when caret is on the heading line', () => {
      const { view } = mountEditor('# Title\nbody', 9);
      setSelection(view, 0); // caret on heading line
      expect(renderedText(view).includes('# Title')).toBe(true);
    });

    it('hides the ## of an H2 by default', () => {
      const { view } = mountEditor('## Two\nx', 7); // caret on "x"
      expect(renderedText(view).includes('## Two')).toBe(false);
      expect(renderedText(view).includes('Two')).toBe(true);
    });

    it('applies md-h1 class on H1 content', () => {
      const { view } = mountEditor('# Hi', 0);
      const h = view.contentDOM.querySelector('.cm-md-h1');
      expect(h).not.toBeNull();
      expect(h?.textContent).toContain('Hi');
    });

    it('applies md-h3 class on H3 content', () => {
      const { view } = mountEditor('### Three\nx', 11);
      const h = view.contentDOM.querySelector('.cm-md-h3');
      expect(h).not.toBeNull();
      expect(h?.textContent).toContain('Three');
    });
  });

  describe('blockquote markers', () => {
    it('hides the > marker when caret is on a different line', () => {
      // Blank line separates the blockquote from the body so they
      // don't fuse into one node via lazy continuation.
      const { view } = mountEditor('> quoted\n\nbody', 12); // caret on body
      const text = renderedText(view);
      expect(text.includes('> quoted')).toBe(false);
      expect(text.includes('quoted')).toBe(true);
    });

    it('reveals the > marker when caret enters the blockquote line', () => {
      const { view } = mountEditor('> quoted\n\nbody', 12);
      setSelection(view, 0);
      expect(renderedText(view).includes('> quoted')).toBe(true);
    });

    it('applies cm-md-blockquote class on the blockquote content', () => {
      const { view } = mountEditor('> quoted', 8);
      const el = view.contentDOM.querySelector('.cm-md-blockquote');
      expect(el).not.toBeNull();
    });
  });

  describe('list markers', () => {
    it('hides the unordered bullet text "- " and tags the line with cm-md-list-unordered', () => {
      const { view } = mountEditor('- one\n- two', 0);
      const text = renderedText(view);
      // The literal "- " dash+space should be replaced.
      expect(text.includes('- one')).toBe(false);
      expect(text.includes('one')).toBe(true);
      // Class hook for ::before pseudo-element styling.
      expect(view.contentDOM.querySelector('.cm-md-list-unordered')).not.toBeNull();
    });

    it('hides the ordered number "1. " and tags the line with cm-md-list-ordered and a data attribute', () => {
      const { view } = mountEditor('1. first\n2. second', 0);
      const text = renderedText(view);
      expect(text.includes('1. first')).toBe(false);
      expect(text.includes('first')).toBe(true);
      const el = view.contentDOM.querySelector<HTMLElement>('.cm-md-list-ordered');
      expect(el).not.toBeNull();
      // The ::before content is driven by a data attribute holding the number.
      expect(el?.getAttribute('data-list-number')).toBe('1');
    });

    it('handles +/* unordered bullet variants', () => {
      const { view } = mountEditor('* star\n+ plus', 0);
      expect(view.contentDOM.querySelectorAll('.cm-md-list-unordered').length).toBe(2);
    });
  });

  describe('link sigils', () => {
    it('hides [..](..) sigils when caret is outside the link', () => {
      const { view } = mountEditor('see [docs](https://x.y) here', 0);
      const text = renderedText(view);
      expect(text.includes('[docs](https://x.y)')).toBe(false);
      expect(text.includes('docs')).toBe(true);
      expect(text.includes('https://x.y')).toBe(false);
    });

    it('reveals brackets + URL when caret intersects the link', () => {
      const { view } = mountEditor('see [docs](https://x.y) here', 0);
      setSelection(view, 6); // inside "docs"
      expect(renderedText(view).includes('[docs](https://x.y)')).toBe(true);
    });

    it('applies md-link class on the link text', () => {
      const { view } = mountEditor('see [docs](https://x.y) here', 0);
      const el = view.contentDOM.querySelector('.cm-md-link');
      expect(el).not.toBeNull();
      expect(el?.textContent).toContain('docs');
    });

    it('hides reference-style [text][id] sigils when caret is outside', () => {
      const src = 'see [docs][ref] here\n\n[ref]: https://x.y';
      const { view } = mountEditor(src, 0);
      const text = renderedText(view);
      expect(text.includes('[docs][ref]')).toBe(false);
      expect(text.includes('docs')).toBe(true);
    });
  });

  describe('paragraph-internal image widget', () => {
    it('replaces ![alt](src) inside a paragraph with an inline <img> widget', () => {
      // Image sharing a paragraph with surrounding text — this is the
      // A.5 surface (a sole-child image is A.6's "block image").
      const { view } = mountEditor('text before ![alt](http://example.com/a.png) text after', 0);
      // Note: CodeMirror inserts a `cm-widgetBuffer` <img> placeholder
      // next to each replace-widget. We target our widget by class.
      const img = view.contentDOM.querySelector('img.cm-md-inline-image');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('http://example.com/a.png');
      expect(img?.getAttribute('alt')).toBe('alt');
      // Surrounding paragraph text still renders.
      const text = renderedText(view);
      expect(text.includes('text before')).toBe(true);
      expect(text.includes('text after')).toBe(true);
      // The literal markdown source for the image should be hidden.
      expect(text.includes('![alt]')).toBe(false);
    });

    it('does NOT insert an <img> widget when the image is the sole child of a paragraph (block image goes to A.6)', () => {
      const { view } = mountEditor('![alt](http://example.com/a.png)', 0);
      const img = view.contentDOM.querySelector('img.cm-md-inline-image');
      // A.5 leaves block-level images alone; A.6's blocks.ts owns them.
      expect(img).toBeNull();
    });

    it('reveals the image source when caret enters the inline-image range', () => {
      const src = 'a ![alt](http://x.png) b';
      const { view } = mountEditor(src, 0);
      // Out: image rendered, sigils hidden.
      expect(renderedText(view).includes('![alt]')).toBe(false);
      // Caret inside the image's bracketed alt — image-replace yields,
      // sigils reveal.
      setSelection(view, 4);
      const text = renderedText(view);
      expect(text.includes('![alt](http://x.png)')).toBe(true);
    });
  });

  describe('redrawing on selection-only transactions', () => {
    it('recomputes the decoration set when only the selection changes', () => {
      const { view } = mountEditor('**bold**', 0);
      const allRevealed = () =>
        Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil')).every(
          (s) => !s.classList.contains('hidden'),
        );
      const allHidden = () =>
        Array.from(view.contentDOM.querySelectorAll('.lp-bold .sigil')).every((s) =>
          s.classList.contains('hidden'),
        );
      // Before: caret at start (pos 0) is at the start of the bold mark's
      // leading sigil, which means it intersects — sigils revealed.
      expect(allRevealed()).toBe(true);
      // Move caret to end of doc; still intersects the trailing sigil's
      // end boundary, so still revealed.
      setSelection(view, view.state.doc.length);
      expect(allRevealed()).toBe(true);
      // Now insert a leading char so the bold mark moves right; place
      // caret at position 0, which is now strictly before the mark.
      view.dispatch({
        changes: { from: 0, insert: 'x ' },
        selection: EditorSelection.single(0),
      });
      expect(allHidden()).toBe(true);
    });
  });

  describe('inlineMarksKeymap — Cmd+B / Cmd+I / Cmd+E / Cmd+K', () => {
    /**
     * Build an editor with the keymap installed. `os.platform` shims
     * are not needed — CodeMirror's `Mod-` token is resolved against
     * `navigator.platform` (defaults to non-mac in jsdom, so Mod ===
     * Ctrl). Tests fire a Ctrl-prefixed KeyboardEvent.
     */
    function mountWithKeymap(
      doc: string,
      from: number,
      to: number = from,
    ): { view: EditorView } {
      const root = document.createElement('div');
      document.body.appendChild(root);
      const state = EditorState.create({
        doc,
        selection: EditorSelection.single(from, to),
        extensions: [
          markdown({ base: markdownLanguage }),
          inlineMarks(),
          inlineMarksKeymap(),
        ],
      });
      const view = new EditorView({ state, parent: root });
      return { view };
    }

    /** Dispatch a Ctrl-prefixed keydown through CodeMirror's scope dispatcher. */
    function pressCtrl(view: EditorView, key: string): boolean {
      const event = new KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      return runScopeHandlers(view, event, 'editor');
    }

    it('exports a keymap extension value', () => {
      const ext = inlineMarksKeymap();
      expect(ext).toBeDefined();
    });

    describe('Cmd+B — StrongEmphasis (**)', () => {
      it('inserts **…** around a non-bold selection and selects the inner content', () => {
        const { view } = mountWithKeymap('hello world', 0, 5); // select "hello"
        const handled = pressCtrl(view, 'b');
        expect(handled).toBe(true);
        expect(view.state.doc.toString()).toBe('**hello** world');
        // Caret-positioning invariant: the selection still covers the
        // same content "hello" — shifted by 2 because of the inserted
        // leading `**`.
        const sel = view.state.selection.main;
        expect(sel.from).toBe(2);
        expect(sel.to).toBe(7);
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('hello');
      });

      it('strips ** when the selection already wraps a bold mark', () => {
        const { view } = mountWithKeymap('**hello** world', 0, 9); // select "**hello**"
        const handled = pressCtrl(view, 'b');
        expect(handled).toBe(true);
        expect(view.state.doc.toString()).toBe('hello world');
        const sel = view.state.selection.main;
        // Selection now covers the unwrapped content.
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('hello');
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(5);
      });

      it('inserts a **** pair around an empty selection with caret in the middle', () => {
        const { view } = mountWithKeymap('xy', 1, 1);
        pressCtrl(view, 'b');
        expect(view.state.doc.toString()).toBe('x****y');
        const sel = view.state.selection.main;
        // Caret sits between the two pairs of asterisks.
        expect(sel.from).toBe(3);
        expect(sel.to).toBe(3);
      });
    });

    describe('Cmd+I — Emphasis (*)', () => {
      it('inserts *…* around the selection and shifts selection by one', () => {
        const { view } = mountWithKeymap('abc def', 0, 3); // select "abc"
        pressCtrl(view, 'i');
        expect(view.state.doc.toString()).toBe('*abc* def');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(1);
        expect(sel.to).toBe(4);
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('abc');
      });

      it('strips * when the selection wraps a *…* mark', () => {
        const { view } = mountWithKeymap('*abc* def', 0, 5); // select "*abc*"
        pressCtrl(view, 'i');
        expect(view.state.doc.toString()).toBe('abc def');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(3);
      });
    });

    describe('Cmd+E — InlineCode (backticks)', () => {
      it('wraps the selection with single backticks when no backtick is present', () => {
        const { view } = mountWithKeymap('hello world', 0, 5);
        pressCtrl(view, 'e');
        expect(view.state.doc.toString()).toBe('`hello` world');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(1);
        expect(sel.to).toBe(6);
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('hello');
      });

      it('uses DOUBLE backticks when the selection contains a backtick', () => {
        // Selection: "a`b" — has one backtick → use ``…`` so the inner
        // backtick remains literal.
        const { view } = mountWithKeymap('xa`by', 1, 4); // select "a`b"
        pressCtrl(view, 'e');
        expect(view.state.doc.toString()).toBe('x``a`b``y');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(3);
        expect(sel.to).toBe(6);
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('a`b');
      });

      it('strips single backticks when the selection wraps a `…` mark', () => {
        const { view } = mountWithKeymap('`hello` world', 0, 7);
        pressCtrl(view, 'e');
        expect(view.state.doc.toString()).toBe('hello world');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(5);
      });

      it('strips DOUBLE backticks when the selection wraps a ``…`` mark', () => {
        const { view } = mountWithKeymap('``a`b`` rest', 0, 7);
        pressCtrl(view, 'e');
        expect(view.state.doc.toString()).toBe('a`b rest');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(0);
        expect(sel.to).toBe(3);
      });

      it('inserts a single-backtick pair around an empty caret', () => {
        const { view } = mountWithKeymap('xy', 1, 1);
        pressCtrl(view, 'e');
        expect(view.state.doc.toString()).toBe('x``y');
        const sel = view.state.selection.main;
        expect(sel.from).toBe(2);
        expect(sel.to).toBe(2);
      });
    });

    describe('Cmd+K — link insertion', () => {
      it('inserts [text](url-placeholder) using the selection as the link text', () => {
        const { view } = mountWithKeymap('see docs here', 4, 8); // select "docs"
        pressCtrl(view, 'k');
        expect(view.state.doc.toString()).toBe('see [docs](url-placeholder) here');
        // Caret-positioning invariant for Cmd+K: the url-placeholder is
        // selected so the user can type to overwrite it.
        const sel = view.state.selection.main;
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('url-placeholder');
      });

      it('inserts [text](url-placeholder) with the placeholder selected when no selection exists', () => {
        // With an empty caret, the wrapper inserts the link skeleton
        // verbatim and selects the url-placeholder.
        const { view } = mountWithKeymap('hi', 2, 2);
        pressCtrl(view, 'k');
        expect(view.state.doc.toString()).toBe('hi[text](url-placeholder)');
        const sel = view.state.selection.main;
        expect(view.state.sliceDoc(sel.from, sel.to)).toBe('url-placeholder');
      });
    });
  });
});
