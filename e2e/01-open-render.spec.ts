import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Open a .md and view it rendered', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Remove the pre-seeded sidecar so this spec exercises the
    // empty-comments branch of CommentsSidebar.
    const fs = await import('node:fs/promises');
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('mounts the start view and renders sample.md after Open', async () => {
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);

    // wireframe-03 shows the empty-comments path. The fixtures dir has a
    // pre-seeded sidecar (used by spec 03 onwards); for this spec we open
    // the .md from a copy in fixture.tmpDir which is reset between specs
    // and doesn't include the sidecar.
    const target = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(target);

    // wireframes/03-document-view.html: rendered MD with no comments.
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );
    const doc = browser.$('[data-view="document"]');
    expect(await doc.$('h1').getText()).toBe('Sample Document');
    expect(await doc.$('table').isExisting()).toBe(true);

    // Table sizing fix: header cells and the first column must not wrap, so a
    // narrow key/ID column isn't squeezed (and headers like "Status (06-…)"
    // stay on one line). Verify the document.css rules reach the rendered
    // table in the real WebView.
    const tableWhiteSpace = await browser.execute(() => {
      const table = document.querySelector('[data-region="render"] table');
      const th = table?.querySelector('th') ?? null;
      const firstTd =
        table?.querySelector('tbody td:first-child') ?? table?.querySelector('td') ?? null;
      const ws = (el: Element | null) =>
        el ? getComputedStyle(el as HTMLElement).whiteSpace : null;
      return { header: ws(th), firstCol: ws(firstTd) };
    });
    expect(tableWhiteSpace.header).toBe('nowrap');
    expect(tableWhiteSpace.firstCol).toBe('nowrap');

    // Dark-mode code highlighting: syntect now emits class-based `syn-*` spans
    // colored by document.css (light + body.theme-dark palettes), instead of
    // inline light-theme colors that were near-black/unreadable on the dark
    // code panel. Verify the theme-reactive CSS actually recolors a code token
    // in the real WebView: a highlighted token's computed color must CHANGE
    // when body.theme-dark is toggled (and the dark color must be light enough
    // to read on the dark panel).
    const codeToken = await browser.execute(() => {
      // Target a token that carries a real syntax color (string / keyword) —
      // not the wrapper span, which would merely inherit --text (that flips
      // with the theme regardless of the syntax palette).
      const span = document.querySelector(
        '[data-region="render"] pre code.hl [class*="syn-string"],' +
          '[data-region="render"] pre code.hl [class*="syn-keyword"]',
      ) as HTMLElement | null;
      if (!span) return null;
      const read = () => getComputedStyle(span).color;
      document.body.classList.remove('theme-dark');
      const light = read();
      document.body.classList.add('theme-dark');
      const dark = read();
      document.body.classList.remove('theme-dark');
      // Parse "rgb(r, g, b)" → average channel (rough luminance proxy).
      const lum = (c: string) => {
        const m = c.match(/\d+/g);
        return m ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 : -1;
      };
      return { light, dark, darkLum: lum(dark) };
    });
    // (WebdriverIO's expect takes no message arg, unlike vitest's.)
    expect(codeToken).not.toBeNull();
    // Theme-reactive: the palette flips with the body class (no re-render).
    expect(codeToken!.dark).not.toBe(codeToken!.light);
    // The dark-palette color is readable (light text) on the dark code panel.
    expect(codeToken!.darkLum).toBeGreaterThan(110);

    expect(
      await browser.$('[data-view="sidebar-comments"] [data-empty="true"]').isExisting(),
    ).toBe(true);
  });
});
