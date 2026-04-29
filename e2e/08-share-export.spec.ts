import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Share / export bundles .md + sidecar', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('exports both sample.md and sample.md.comments.json into the chosen dir', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // The Rust handler refuses non-empty destinations. tmpDir/export is
    // fresh either way; explicitly leave it nonexistent so create_dir_all
    // inside the handler does the work.
    const exportDir = path.join(fixture.tmpDir, 'export-dest');

    // Click the Share toolbar button → mounts ShareDialog as an overlay
    // inside the body region.
    await browser.$('[data-action="share"]').click();
    await browser.waitUntil(
      async () => browser.$('[data-view="share"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'share dialog did not mount' },
    );

    // Set the destination folder and click Export.
    await browser
      .$('[data-view="share"] [data-test="folder"]')
      .setValue(exportDir);
    await browser.$('[data-view="share"] [data-action="export"]').click();

    // After share-exported fires, both files should be in exportDir.
    await browser.waitUntil(
      async () => {
        try {
          const entries = await fs.readdir(exportDir);
          return entries.includes('sample.md') &&
            entries.includes('sample.md.comments.json');
        } catch {
          return false;
        }
      },
      { timeout: 5_000, timeoutMsg: 'export did not produce the expected files' },
    );
  });
});
