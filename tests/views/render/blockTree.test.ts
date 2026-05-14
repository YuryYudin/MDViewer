// B2: blockTree extractor unit tests.
//
// Contract: `extractBlockTree` projects both View-mode HTML (the
// pulldown-cmark output rendered to the document <article>) and
// Edit-mode DOM (the CodeMirror live editor) onto the same canonical
// BlockNode shape. Layer-2 of the regression net relies on deep-equal
// projection — these tests are the strict spec for that projection.
//
// Avoid:
//   - Do NOT mount CodeMirror to produce Edit-mode DOM. That's B3's job
//     (oracle test against the real editor). B2 uses hand-written DOM.
//   - Do NOT use `expect.objectContaining(...)`. The whole point of the
//     extractor is deep-equal projection; loose matchers paper over
//     regressions where an extra field sneaks in.
//   - Do NOT skip the inline-mark equivalence cases. Each of
//     strong/em/strike/code/link/image must be asserted to map
//     identically under both renderers; an asymmetric mapping is the
//     exact regression class Layer 2 was designed to catch.

import { describe, it, expect } from 'vitest';
import { extractBlockTree } from '../../../src/views/render/blockTree';
import type { BlockNode } from '../../../src/views/render/blockTree.types';

function htmlToRoot(html: string): Element {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

/* ================================================================== */
/* Block kinds                                                         */
/* ================================================================== */

describe('extractBlockTree — block kinds', () => {
  it('extracts h1-h6 headings with level + inline', () => {
    const root = htmlToRoot(
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'heading', level: 1, inline: [{ kind: 'text', text: 'One' }] },
      { kind: 'heading', level: 2, inline: [{ kind: 'text', text: 'Two' }] },
      { kind: 'heading', level: 3, inline: [{ kind: 'text', text: 'Three' }] },
      { kind: 'heading', level: 4, inline: [{ kind: 'text', text: 'Four' }] },
      { kind: 'heading', level: 5, inline: [{ kind: 'text', text: 'Five' }] },
      { kind: 'heading', level: 6, inline: [{ kind: 'text', text: 'Six' }] },
    ]);
  });

  it('extracts paragraphs with collapsed whitespace', () => {
    const root = htmlToRoot('<p>Hello   world\n\n  again</p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Hello world again' }] },
    ]);
  });

  it('extracts unordered list with stripped bullets', () => {
    const root = htmlToRoot('<ul><li>Alpha</li><li>Beta</li></ul>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'Alpha' }] }],
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'Beta' }] }],
        ],
      },
    ]);
  });

  it('extracts ordered list', () => {
    const root = htmlToRoot('<ol><li>First</li><li>Second</li><li>Third</li></ol>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: true,
        items: [
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'First' }] }],
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'Second' }] }],
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'Third' }] }],
        ],
      },
    ]);
  });

  it('extracts list-item with nested block (loose list with <p>)', () => {
    const root = htmlToRoot('<ul><li><p>Wrapped</p></li></ul>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'Wrapped' }] }],
        ],
      },
    ]);
  });

  it('extracts blockquote children', () => {
    const root = htmlToRoot('<blockquote><p>Quoted line</p></blockquote>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'blockquote',
        children: [
          { kind: 'paragraph', inline: [{ kind: 'text', text: 'Quoted line' }] },
        ],
      },
    ]);
  });

  it('extracts fenced code with language and body', () => {
    const root = htmlToRoot(
      '<pre><code class="language-python">def f():\n    pass\n</code></pre>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'code', language: 'python', body: 'def f():\n    pass' },
    ]);
  });

  it('extracts fenced code with no language when class is absent', () => {
    const root = htmlToRoot('<pre><code>raw\nlines</code></pre>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'code', language: '', body: 'raw\nlines' },
    ]);
  });

  it('extracts code block when language carried on data-lang (Edit widget)', () => {
    const root = htmlToRoot(
      '<div data-testid="code-widget" data-lang="rust"><pre>fn main(){}</pre></div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'code', language: 'rust', body: 'fn main(){}' },
    ]);
  });

  it('extracts code-widget-raw variant', () => {
    const root = htmlToRoot(
      '<div data-testid="code-widget-raw" data-lang="go"><pre>package main\n</pre></div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'code', language: 'go', body: 'package main' },
    ]);
  });

  it('extracts code-widget body from outer text when no <pre> child is present', () => {
    const root = htmlToRoot('<div data-testid="code-widget" data-lang="zig">naked body</div>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'code', language: 'zig', body: 'naked body' },
    ]);
  });

  it('extracts mermaid widget by data-source attribute', () => {
    const root = htmlToRoot(
      '<div data-testid="mermaid-widget" data-source="graph LR\nA-->B"><svg></svg></div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'mermaid', source: 'graph LR\nA-->B' },
    ]);
  });

  it('extracts mermaid widget from inner <pre> when data-source is absent', () => {
    const root = htmlToRoot(
      '<div data-testid="mermaid-widget"><pre>graph TB\nX-->Y\n</pre><span class="pencil">edit</span></div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'mermaid', source: 'graph TB\nX-->Y' },
    ]);
  });

  it('extracts mermaid widget from textContent when no <pre> or data-source', () => {
    const root = htmlToRoot(
      '<div data-testid="mermaid-widget">flowchart\nA-->B\n<span data-action="raw-edit">edit</span></div>',
    );
    // The pencil affordance ([data-action="raw-edit"]) is stripped before
    // reading the text. A single trailing newline on the captured body is
    // also trimmed; interior whitespace is preserved verbatim (it's source
    // code, not prose).
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'mermaid', source: 'flowchart\nA-->B' },
    ]);
  });

  it('extracts GFM tables from View mode', () => {
    const root = htmlToRoot(
      '<table>' +
        '<thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody>' +
        '</table>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });

  it('extracts hr', () => {
    const root = htmlToRoot('<hr/>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([{ kind: 'hr' }]);
  });

  it('descends generic wrapper divs/sections/articles', () => {
    const root = htmlToRoot('<section><article><div><p>Deep</p></div></article></section>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Deep' }] },
    ]);
  });

  it('returns empty table when widget contains no <table>', () => {
    const root = htmlToRoot('<div data-testid="table-widget"></div>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'table', headers: [], rows: [] },
    ]);
  });

  it('ignores non-recognised top-level tags', () => {
    const root = htmlToRoot('<details>x</details><p>kept</p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'kept' }] },
    ]);
  });
});

/* ================================================================== */
/* Normalization contract                                              */
/* ================================================================== */

describe('extractBlockTree — normalization contract', () => {
  it('strips cm-line wrappers and cm-widgetBuffer markers', () => {
    // Presence of `.cm-line` under `.cm-content` flips the walker into
    // Edit-mode. The contract under test is: cm-line / cm-widgetBuffer
    // wrappers do NOT appear in the semantic output — the inline content
    // surfaces directly. We use a single non-blank line plus an
    // adjacent widgetBuffer to assert both stripping behaviors at once;
    // a blank cm-line separates a second paragraph so we can also assert
    // the paragraph-split path (Edit-mode walker glues consecutive
    // non-blank lines into one paragraph per Markdown semantics — the
    // blank line acts as the paragraph terminator).
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line">Hello</div>' +
        '<span class="cm-widgetBuffer"></span>' +
        '<div class="cm-line"></div>' +
        '<div class="cm-line">World</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Hello' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'World' }] },
    ]);
  });

  it('strips cm-cursor and cm-selectionLayer internal nodes', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-cursor cm-cursor-primary"></div>' +
        '<div class="cm-selectionLayer"></div>' +
        '<div class="cm-line">Body</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Body' }] },
    ]);
  });

  it('strips zero-width spans inside a paragraph', () => {
    // U+200B zero-width space, then "Hello", then another U+200B.
    const root = htmlToRoot('<p><span>​</span>Hello<span>​</span></p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Hello' }] },
    ]);
  });

  it('collapses internal whitespace runs to a single space', () => {
    // Two-or-more whitespace chars (including embedded newlines) inside
    // a single text node collapse to one space.
    const root = htmlToRoot('<p>foo  bar\n\n  baz</p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'foo bar baz' }] },
    ]);
  });

  it('merges adjacent text nodes preserving inter-mark spacing', () => {
    // Adjacent text nodes around an inline mark merge correctly so the
    // mark stays surrounded by single-space text nodes (rather than
    // gluing words together).
    const root = htmlToRoot('<p>foo <em>bar</em> baz</p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'foo ' },
          { kind: 'em', children: [{ kind: 'text', text: 'bar' }] },
          { kind: 'text', text: ' baz' },
        ],
      },
    ]);
  });

  it('drops style/aria/class attributes from semantic shape', () => {
    const root = htmlToRoot(
      '<p style="color: red" aria-label="x" class="anything">Hello</p>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Hello' }] },
    ]);
  });

  it('descends into table-widget and strips pencil/toolbar affordances', () => {
    const root = htmlToRoot(
      '<div data-testid="table-widget">' +
        '<table>' +
        '<thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody>' +
        '</table>' +
        '<button data-testid="table-widget-pencil">edit</button>' +
        '<div class="table-widget-toolbar">tools</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'table', headers: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });

  it('handles <br> between two text nodes — three-node sequence merges to one canonical text', () => {
    // `<br>` is mapped to a single-space text node by `mapInlineElement`
    // (so a stand-alone `<br>` produces a single space). The merge pass
    // joins surrounding text nodes; the inter-token boundary is consumed
    // by the adjacent-text collapse step. This deep-equal projection is
    // the SAME for both renderers, which is what Layer-2 equivalence
    // requires — symmetric projection, not a particular separator char.
    const root = htmlToRoot('<p>line1<br/>line2</p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'line1line2' }] },
    ]);
  });

  it('treats <b>/<i>/<s>/<strike> as their semantic equivalents', () => {
    const root = htmlToRoot('<p><b>B</b> <i>I</i> <s>S</s> <strike>K</strike></p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'strong', children: [{ kind: 'text', text: 'B' }] },
          { kind: 'text', text: ' ' },
          { kind: 'em', children: [{ kind: 'text', text: 'I' }] },
          { kind: 'text', text: ' ' },
          { kind: 'strike', children: [{ kind: 'text', text: 'S' }] },
          { kind: 'text', text: ' ' },
          { kind: 'strike', children: [{ kind: 'text', text: 'K' }] },
        ],
      },
    ]);
  });
});

/* ================================================================== */
/* Inline-mark View ↔ Edit equivalence                                 */
/* ================================================================== */

describe('extractBlockTree — inline marks (View ↔ Edit equivalence)', () => {
  /* ---- strong ---- */
  it('strong: View <strong> ↔ Edit .lp-bold produce the same InlineNode', () => {
    const VIEW = '<p>Hi <strong>there</strong>!</p>';
    const EDIT =
      '<p>Hi <span class="lp-bold"><span class="sigil">**</span>there<span class="sigil">**</span></span>!</p>';
    const expected: BlockNode[] = [
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'Hi ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'there' }] },
          { kind: 'text', text: '!' },
        ],
      },
    ];
    expect(extractBlockTree(htmlToRoot(VIEW))).toEqual(expected);
    expect(extractBlockTree(htmlToRoot(EDIT))).toEqual(expected);
  });

  /* ---- em ---- */
  it('em: View <em> ↔ Edit .lp-italic produce the same InlineNode', () => {
    const VIEW = '<p>Hi <em>there</em>!</p>';
    const EDIT =
      '<p>Hi <span class="lp-italic"><span class="sigil">*</span>there<span class="sigil">*</span></span>!</p>';
    const expected: BlockNode[] = [
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'Hi ' },
          { kind: 'em', children: [{ kind: 'text', text: 'there' }] },
          { kind: 'text', text: '!' },
        ],
      },
    ];
    expect(extractBlockTree(htmlToRoot(VIEW))).toEqual(expected);
    expect(extractBlockTree(htmlToRoot(EDIT))).toEqual(expected);
  });

  /* ---- strike ---- */
  it('strike: View <del> ↔ Edit .lp-strike produce the same InlineNode', () => {
    const VIEW = '<p>Hi <del>there</del>!</p>';
    const EDIT =
      '<p>Hi <span class="lp-strike"><span class="sigil">~~</span>there<span class="sigil">~~</span></span>!</p>';
    const expected: BlockNode[] = [
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'Hi ' },
          { kind: 'strike', children: [{ kind: 'text', text: 'there' }] },
          { kind: 'text', text: '!' },
        ],
      },
    ];
    expect(extractBlockTree(htmlToRoot(VIEW))).toEqual(expected);
    expect(extractBlockTree(htmlToRoot(EDIT))).toEqual(expected);
  });

  /* ---- inline code ---- */
  it('code: View <code> ↔ Edit .cm-md-code produce the same InlineNode', () => {
    const VIEW = '<p>Use <code>fn</code>.</p>';
    const EDIT =
      '<p>Use <span class="cm-md-code"><span class="sigil">`</span>fn<span class="sigil">`</span></span>.</p>';
    const expected: BlockNode[] = [
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'Use ' },
          { kind: 'code', children: [{ kind: 'text', text: 'fn' }] },
          { kind: 'text', text: '.' },
        ],
      },
    ];
    expect(extractBlockTree(htmlToRoot(VIEW))).toEqual(expected);
    expect(extractBlockTree(htmlToRoot(EDIT))).toEqual(expected);
  });

  /* ---- link ---- */
  it('link: View <a href> ↔ Edit .cm-md-link with sibling URL-sigil produce the same InlineNode', () => {
    const VIEW = '<p>See <a href="https://example.com">Click</a> now.</p>';
    // Edit-mode link layout: opening `[` sigil, the `.cm-md-link` text
    // mark, closing `]` sigil, then the `(url)` portion split across
    // three sigil spans. The extractor recovers href from the sibling
    // sigil run's text content using a `\(…\)` regex.
    const EDIT =
      '<p>See ' +
      '<span class="sigil">[</span>' +
      '<span class="cm-md-link">Click</span>' +
      '<span class="sigil">]</span>' +
      '<span class="sigil">(</span>' +
      '<span class="sigil">https://example.com</span>' +
      '<span class="sigil">)</span>' +
      ' now.</p>';
    const expected: BlockNode[] = [
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'See ' },
          {
            kind: 'link',
            href: 'https://example.com',
            children: [{ kind: 'text', text: 'Click' }],
          },
          { kind: 'text', text: ' now.' },
        ],
      },
    ];
    expect(extractBlockTree(htmlToRoot(VIEW))).toEqual(expected);
    expect(extractBlockTree(htmlToRoot(EDIT))).toEqual(expected);
  });

  /* ---- image ---- */
  it('image: View <img src,alt> ↔ Edit .cm-md-inline-image produce the same InlineNode', () => {
    const VIEW = '<p>Look <img src="data:image/png;base64,XYZ" alt="Alt"/></p>';
    const EDIT =
      '<p>Look <span class="cm-md-inline-image"><img src="data:image/png;base64,XYZ" alt="Alt"/></span></p>';
    const expected: BlockNode[] = [
      {
        kind: 'paragraph',
        inline: [
          { kind: 'text', text: 'Look ' },
          { kind: 'image', src: 'data:image/png;base64,XYZ', alt: 'Alt' },
        ],
      },
    ];
    expect(extractBlockTree(htmlToRoot(VIEW))).toEqual(expected);
    expect(extractBlockTree(htmlToRoot(EDIT))).toEqual(expected);
  });

  it('image: Edit .cm-md-inline-image applied directly to the <img>', () => {
    // Some renderers apply the class straight to the <img> element
    // rather than to a wrapping <span>. The extractor handles both.
    const root = htmlToRoot(
      '<p><img class="cm-md-inline-image" src="x.png" alt="Y"/></p>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'paragraph',
        inline: [{ kind: 'image', src: 'x.png', alt: 'Y' }],
      },
    ]);
  });

  it('image: Edit .cm-md-inline-image wrapper without inner <img> falls through silently', () => {
    // Defensive: an empty wrapper produces no image node (rather than
    // throwing or emitting `{src:'', alt:''}`).
    const root = htmlToRoot('<p>before<span class="cm-md-inline-image"></span>after</p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'beforeafter' }] },
    ]);
  });

  it('link: View <a> with no href yields empty href', () => {
    const root = htmlToRoot('<p><a>bare</a></p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'paragraph',
        inline: [{ kind: 'link', href: '', children: [{ kind: 'text', text: 'bare' }] }],
      },
    ]);
  });

  it('link: Edit .cm-md-link with no following sigil run yields empty href', () => {
    const root = htmlToRoot('<p><span class="cm-md-link">orphan</span></p>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'paragraph',
        inline: [{ kind: 'link', href: '', children: [{ kind: 'text', text: 'orphan' }] }],
      },
    ]);
  });

  it('link: Edit .cm-md-link with bracket-only sigils falls back to bracket-trim', () => {
    // When the captured sigil run has no parenthesised substring, the
    // extractor falls back to trimming the wrapping `[`/`]` or `(`/`)`.
    const root = htmlToRoot(
      '<p>' +
        '<span class="cm-md-link">x</span>' +
        '<span class="sigil">[no-parens]</span>' +
        '</p>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'link', href: 'no-parens', children: [{ kind: 'text', text: 'x' }] },
        ],
      },
    ]);
  });
});

/* ================================================================== */
/* Edit-mode block walker — coverage for line-level classification     */
/* ================================================================== */

describe('extractBlockTree — Edit-mode block walker', () => {
  it('classifies a cm-md-h2 heading carried on a child mark span', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line"><span class="cm-md-h2">Title</span></div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'heading', level: 2, inline: [{ kind: 'text', text: 'Title' }] },
    ]);
  });

  it('classifies a cm-md-h3 heading carried on the cm-line itself', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line cm-md-h3">Body</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'heading', level: 3, inline: [{ kind: 'text', text: 'Body' }] },
    ]);
  });

  it('classifies an Edit-mode hr line (---)', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line">---</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([{ kind: 'hr' }]);
  });

  it('classifies an Edit-mode blockquote run', () => {
    // Multiple non-blank cm-md-blockquote lines collapse into a single
    // paragraph child (consecutive non-blank lines = one paragraph per
    // Markdown semantics). The blockquote wrapper survives stripping of
    // cm-md-blockquote line classes.
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line cm-md-blockquote">quoted</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'blockquote',
        children: [
          {
            kind: 'paragraph',
            inline: [{ kind: 'text', text: 'quoted' }],
          },
        ],
      },
    ]);
  });

  it('splits a blockquote into multiple paragraphs at a blank line', () => {
    // A blank line between blockquote lines terminates the current
    // paragraph; the run continues if the next non-blank line is also a
    // blockquote line.
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line cm-md-blockquote">first paragraph</div>' +
        '<div class="cm-line cm-md-blockquote"></div>' +
        '<div class="cm-line cm-md-blockquote">second paragraph</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'blockquote',
        children: [
          { kind: 'paragraph', inline: [{ kind: 'text', text: 'first paragraph' }] },
          { kind: 'paragraph', inline: [{ kind: 'text', text: 'second paragraph' }] },
        ],
      },
    ]);
  });

  it('classifies Edit-mode ordered + unordered list runs', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line cm-md-list-ordered">1. one</div>' +
        '<div class="cm-line cm-md-list-ordered">2. two</div>' +
        '<div class="cm-line">spacer</div>' +
        '<div class="cm-line cm-md-list-unordered">- a</div>' +
        '<div class="cm-line cm-md-list-unordered">- b</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: true,
        items: [
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'one' }] }],
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'two' }] }],
        ],
      },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'spacer' }] },
      {
        kind: 'list',
        ordered: false,
        items: [
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'a' }] }],
          [{ kind: 'paragraph', inline: [{ kind: 'text', text: 'b' }] }],
        ],
      },
    ]);
  });

  it('skips blank cm-line separators between paragraphs', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line">First paragraph.</div>' +
        '<div class="cm-line">   </div>' +
        '<div class="cm-line">Second paragraph.</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'First paragraph.' }] },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Second paragraph.' }] },
    ]);
  });

  it('descends into Edit-mode block widgets in document order', () => {
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line">before</div>' +
        '<div data-testid="mermaid-widget" data-source="A-->B"></div>' +
        '<div class="cm-line">after</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'before' }] },
      { kind: 'mermaid', source: 'A-->B' },
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'after' }] },
    ]);
  });

  it('falls back to the editor root itself when there is no .cm-content scope', () => {
    // `findEditScope` returns the root when `.cm-content` is absent —
    // the walker still finds cm-line children directly.
    const root = htmlToRoot(
      '<div class="cm-line">Solo line</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'Solo line' }] },
    ]);
  });

  it('joins two consecutive non-blank cm-lines into a single paragraph', () => {
    // Branch coverage: the Edit-mode paragraph flatMap branch that adds
    // a `' '` separator between consecutive non-blank lines.
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="cm-line">first</div>' +
        '<div class="cm-line">second</div>' +
        '</div>',
    );
    const result = extractBlockTree(root);
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('paragraph');
  });

  it('descends into wrapper divs when collecting Edit-mode items', () => {
    // collectEditItems recursion path — wrapper div under .cm-content
    // around a cm-line.
    const root = htmlToRoot(
      '<div class="cm-content">' +
        '<div class="wrapper">' +
        '<div class="cm-line">wrapped</div>' +
        '</div>' +
        '</div>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      { kind: 'paragraph', inline: [{ kind: 'text', text: 'wrapped' }] },
    ]);
  });

  it('extracts a list item that mixes inline marks with plain text', () => {
    // Covers the `<li>` branch where children include both text and
    // inline elements like <strong>.
    const root = htmlToRoot('<ul><li>before <strong>bold</strong> after</li></ul>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            {
              kind: 'paragraph',
              inline: [
                { kind: 'text', text: 'before ' },
                { kind: 'strong', children: [{ kind: 'text', text: 'bold' }] },
                { kind: 'text', text: ' after' },
              ],
            },
          ],
        ],
      },
    ]);
  });

  it('drops a list-item paragraph whose entire text was a marker', () => {
    // Coverage branch: stripListMarker producing an empty string drops
    // the first inline-text node entirely. The remaining inline content
    // (a <strong> here) is preserved.
    const root = htmlToRoot('<ul><li>- <strong>bold-only</strong></li></ul>');
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            {
              kind: 'paragraph',
              inline: [
                { kind: 'strong', children: [{ kind: 'text', text: 'bold-only' }] },
              ],
            },
          ],
        ],
      },
    ]);
  });

  it('strips a list-marker text leak from the first paragraph of a list item', () => {
    // Edit-mode list lines can leak the leading `- ` / `1. ` when sigil
    // hiding fails. The extractor strips a leading marker idempotently.
    const root = htmlToRoot(
      '<ul><li>1. with-leading-numeral</li><li>- with-leading-dash</li></ul>',
    );
    expect(extractBlockTree(root)).toEqual<BlockNode[]>([
      {
        kind: 'list',
        ordered: false,
        items: [
          [
            {
              kind: 'paragraph',
              inline: [{ kind: 'text', text: 'with-leading-numeral' }],
            },
          ],
          [
            {
              kind: 'paragraph',
              inline: [{ kind: 'text', text: 'with-leading-dash' }],
            },
          ],
        ],
      },
    ]);
  });
});
