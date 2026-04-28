import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Three-way diff resolves a divergent .md', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('shows the conflict view, accepts hunks, and writes the merged bytes', async () => {
    // Seed local + incoming variants of sample.md with divergent edits.
    const local = await fs.readFile(path.resolve('e2e/fixtures/sample.md'), 'utf8');
    const localEdited = local.replace('**bold**', '**LOCAL bold**');
    const incomingEdited = local.replace('*italic*', '*INCOMING italic*');
    const localPath = path.join(fixture.tmpDir, 'sample.md');
    const incomingPath = path.join(fixture.tmpDir, 'sample.incoming.md');
    await fs.writeFile(localPath, localEdited, 'utf8');
    await fs.writeFile(incomingPath, incomingEdited, 'utf8');

    // Open the local file; the app detects the divergent incoming sibling.
    await browser.$('[data-action="open-file"]').click();
    await browser.$('[data-test="file-input"]').setValue(localPath);

    // wireframes/08-conflict-resolution.html
    await expect(browser.$('[data-view="conflict"]')).toBeDisplayed();

    await browser.$('[data-test="hunk"][data-hunk-id="1"] [data-action="accept-left"]').click();
    await browser.$('[data-test="hunk"][data-hunk-id="2"] [data-action="accept-right"]').click();
    await browser.$('[data-action="finish-merge"]').click();

    // Saved file should reflect both choices: LOCAL bold + INCOMING italic.
    const saved = await fs.readFile(localPath, 'utf8');
    const expected = local
      .replace('**bold**', '**LOCAL bold**')
      .replace('*italic*', '*INCOMING italic*');
    await expect(saved).toBe(expected);
  });
});
