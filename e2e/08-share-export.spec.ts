import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Share / export bundles .md + sidecar', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('exports both sample.md and sample.md.comments.json into the chosen dir', async () => {
    await browser.$('[data-action="open-file"]').click();
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    const exportDir = path.join(fixture.tmpDir, 'export');
    await fs.mkdir(exportDir, { recursive: true });

    await browser.$('[data-action="share"]').click();
    await browser.$('[data-action="export"]').click();
    await browser.$('[data-test="export-path"]').setValue(exportDir);
    await browser.$('[data-action="confirm-export"]').click();

    const entries = await fs.readdir(exportDir);
    await expect(entries).toContain('sample.md');
    await expect(entries).toContain('sample.md.comments.json');
  });
});
