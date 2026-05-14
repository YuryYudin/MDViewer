// Vite-aliased stub. Block-widgets decoration module's dynamic
// `import('mermaid')` resolves here at bundle time, NOT at runtime.
// We export only the surface blocks.ts consumes:
//   - `initialize`: no-op so any boot-time call returns.
//   - `render(id, source)`: returns a deterministic placeholder SVG
//     whose label uses the first 8 hex chars of a SHA-256 digest of
//     `source`. Two Chromium minor versions on the pinned runner
//     image rasterize this identically.

async function sha256Hex8(source: string): Promise<string> {
  const enc = new TextEncoder().encode(source);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const arr = Array.from(new Uint8Array(buf));
  return arr.slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function render(_id: string, source: string): Promise<{ svg: string }> {
  const hash = await sha256Hex8(source);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="150" viewBox="0 0 300 150">' +
    `<text font-family="Noto Sans, monospace" font-size="12" text-anchor="start" x="10" y="20" fill="#000">MERMAID:${hash}</text>` +
    '</svg>';
  return { svg };
}

export default { initialize: () => {}, render };
export { render };
export const initialize = () => {};
