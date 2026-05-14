// Discriminated-union block-tree types used by the regression-net
// oracle (Layer 2). Both View-mode HTML (pulldown-cmark output) and
// Edit-mode DOM (CodeMirror live editor) project onto this shape so
// the test can deep-equal them.

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'em'; children: InlineNode[] }
  | { kind: 'strike'; children: InlineNode[] }
  | { kind: 'code'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] }
  | { kind: 'image'; src: string; alt: string };

export type BlockNode =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; inline: InlineNode[] }
  | { kind: 'paragraph'; inline: InlineNode[] }
  | { kind: 'list'; ordered: boolean; items: BlockNode[][] }
  | { kind: 'blockquote'; children: BlockNode[] }
  | { kind: 'code'; language: string; body: string }
  | { kind: 'mermaid'; source: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'hr' };
