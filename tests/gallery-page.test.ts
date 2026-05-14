import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..');
const FIXTURE = path.join(REPO, 'e2e/fixtures/render-gallery.md');
const SIDECAR = path.join(REPO, 'e2e/fixtures/render-gallery.md.comments.json');

// The gallery page's main.ts fetches /render-gallery.md and
// /render-gallery.md.comments.json. Stub fetch so the smoke runs
// without a Vite preview server.
function installFetchStub() {
  global.fetch = vi.fn(async (url: string | URL): Promise<Response> => {
    const u = String(url);
    if (u.endsWith('/render-gallery.md')) {
      return new Response(fs.readFileSync(FIXTURE, 'utf8'));
    }
    if (u.endsWith('/render-gallery.md.comments.json')) {
      return new Response(fs.readFileSync(SIDECAR, 'utf8'));
    }
    throw new Error('unexpected fetch ' + u);
  }) as never;
}

describe('gallery-page harness smoke', () => {
  it('boots main.ts and flips data-ready', async () => {
    // The page's HTML scaffold needs the mount point.
    document.body.innerHTML = '<div id="editor-host"></div>';
    expect(document.body.hasAttribute('data-ready')).toBe(false);

    installFetchStub();

    // Importing main.ts triggers its top-level `main()` call.
    // The dynamic import isolates the side effect to this test.
    await import('../e2e-visual/gallery-page/main');

    // main() does fetch → JSON parse → mountLiveEditor → rAF →
    // setAttribute. Poll until the flag flips. Five seconds is the
    // webServer-boot budget from the success criteria — well above
    // the in-process expected latency.
    await vi.waitFor(
      () => expect(document.body.getAttribute('data-ready')).toBe('true'),
      { timeout: 5_000, interval: 25 },
    );
  });
});
