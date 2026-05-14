import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Render gallery: structural selector smoke (Layer 3)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // NOTE: unlike spec 01, we deliberately KEEP render-gallery.md.comments.json
    // so the comment-anchor regression class (resolved-thread highlight in the
    // live editor) is exercised — `mark.cm-comment-anchor[data-anchor]` only
    // paints when a sidecar binds threads to source offsets.
  });
  after(async () => { await fixture.cleanup(); });

  it('every enumerated selector is present in the document', async () => {
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);

    const target = path.join(fixture.tmpDir, 'render-gallery.md');
    await openDocByE2eHook(target);

    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );
    const doc = browser.$('[data-view="document"]');

    // Block widgets (data-testid)
    expect(await doc.$('[data-testid="table-widget"]').isExisting()).toBe(true);
    expect(await doc.$('[data-testid="code-widget"]').isExisting()).toBe(true);
    expect(await doc.$('[data-testid="mermaid-widget"]').isExisting()).toBe(true);

    // Heading marks .cm-md-h1 .cm-md-h2 .cm-md-h3 .cm-md-h4 .cm-md-h5 .cm-md-h6
    expect(await doc.$('.cm-md-h1').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-h2').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-h3').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-h4').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-h5').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-h6').isExisting()).toBe(true);

    // Blockquote, lists, link, inline image, inline code
    expect(await doc.$('.cm-md-blockquote').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-list-unordered').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-list-ordered').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-link').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-inline-image').isExisting()).toBe(true);
    expect(await doc.$('.cm-md-code').isExisting()).toBe(true);

    // Comment highlight (driven by render-gallery.md.comments.json)
    expect(await doc.$('mark.cm-comment-anchor[data-anchor]').isExisting()).toBe(true);
  });
});
