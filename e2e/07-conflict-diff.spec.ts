import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Three-way diff resolves a divergent .md', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('shows the conflict view, accepts a hunk, and writes the merged bytes', async () => {
    // C2's auto-detect path: open a file → close it (so closed_snapshots
    // tracks the saved copy) → external rewrite → reopen → Conflict.
    // The spec used to assume an "incoming sibling" flow that the app
    // doesn't actually implement.
    const target = path.join(fixture.tmpDir, 'sample.md');
    const local = await fs.readFile(target, 'utf8');

    // First open establishes the tab + closed_snapshots entry.
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount on first open' },
    );

    // Close the tab via the "×" close button on its TabBar entry. The IPC
    // closeTab call propagates the snapshot into closed_snapshots.
    const closeBtn = browser.$('[data-region="tabbar"] [data-test="tab-close"]');
    expect(await closeBtn.isExisting()).toBe(true);
    await closeBtn.click();

    // External rewrite: change one line of the file from outside the app.
    const incoming = local.replace('Selectable phrase one', 'EXTERNALLY edited phrase one');
    await fs.writeFile(target, incoming, 'utf8');

    // Reopen — Workspace.open_document compares closed_snapshots against
    // disk and returns OpenOutcome::Conflict, which Workspace.ts routes
    // to mountConflict.
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="conflict"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'conflict view did not appear' },
    );

    // Conflict.ts uses [data-hunk-index]; click Accept Right on the first
    // hunk so the merged bytes carry the incoming change.
    const firstHunk = browser.$('[data-view="conflict"] [data-hunk-index="0"]');
    expect(await firstHunk.isExisting()).toBe(true);
    await firstHunk.$('[data-action="accept-right"]').click();
    await browser.$('[data-action="finish-merge"]').click();

    // After the merge save, disk reflects the chosen incoming bytes.
    await browser.waitUntil(
      async () => {
        const onDisk = await fs.readFile(target, 'utf8');
        return onDisk.includes('EXTERNALLY edited phrase one');
      },
      { timeout: 5_000, timeoutMsg: 'merged bytes never landed on disk' },
    );
  });
});
