// Vite-aliased stub. Block-widgets decoration module's dynamic
// `import('mermaid')` resolves here at bundle time, NOT at runtime.
//
// Mirrors the production mermaid module surface that
// `src/views/decorations/blocks.ts` consumes (see blocks.ts:213-226):
//   - `initialize(cfg)`: accepts the production `{ startOnLoad, theme }`
//     config, no-op.
//   - `run({ nodes })`: walks each HTMLElement, replaces its text content
//     with a deterministic placeholder SVG labelled by the first 8 hex
//     chars of a SHA-256 digest of the node's textContent. Two Chromium
//     minor versions on the pinned runner image rasterize this identically.
//
// The SVG attributes are pinned (font-family/font-size/text-anchor/coords)
// so the screenshot diff stays stable across Chromium minor versions.

function sha256Hex8(source: string): Promise<string> {
  const enc = new TextEncoder().encode(source);
  return crypto.subtle.digest('SHA-256', enc).then((buf) => {
    const arr = Array.from(new Uint8Array(buf));
    return arr.slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

function placeholderSvg(hash: string): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150">' +
    `<text font-family="Noto Sans, monospace" font-size="12" text-anchor="start" x="10" y="20" fill="#000">MERMAID:${hash}</text>` +
    '</svg>'
  );
}

async function run(opts: { nodes: HTMLElement[] }): Promise<void> {
  for (const node of opts.nodes) {
    const source = node.textContent ?? '';
    const hash = await sha256Hex8(source);
    node.innerHTML = placeholderSvg(hash);
  }
}

export default {
  initialize: (_cfg: { startOnLoad: boolean; theme?: string }) => {},
  run,
};
