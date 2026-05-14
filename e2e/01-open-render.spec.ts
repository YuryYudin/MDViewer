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
    expect(
      await browser.$('[data-view="sidebar-comments"] [data-empty="true"]').isExisting(),
    ).toBe(true);

    // Regression (2026-05-14): the rendered doc must NOT introduce a
    // doc-wide horizontal scrollbar. Pre-fix, the LiveEditor mount
    // dropped EditorView.lineWrapping, so long lines overflowed and
    // the scroller's scrollWidth grew well past clientWidth. The
    // cm-scroller is the element that owns horizontal overflow in a
    // CodeMirror surface — measure there. A 2 px tolerance covers
    // sub-pixel rounding on hi-DPI displays.
    const overflow = await browser.execute(() => {
      const scroller = document.querySelector('.cm-scroller');
      if (!scroller) return { found: false };
      return {
        found: true,
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
      };
    });
    expect(overflow.found).toBe(true);
    expect(overflow.scrollWidth! - overflow.clientWidth!).toBeLessThanOrEqual(2);
  });
});
