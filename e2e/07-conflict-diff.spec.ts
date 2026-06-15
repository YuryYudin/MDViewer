import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('External change with no local edits reloads instead of merging', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('reopening an externally-changed doc with no edits offers reload, never a merge', async () => {
    // Regression guard: a document that changed on disk while open but with
    // NO unsaved edits must NOT surface the 3-way merge on reopen — it offers
    // a reload instead (the "bogus merge on reload" bug). The merge UI for
    // genuine unsaved-edit conflicts is covered by tests/views/Conflict.test.ts
    // and e2e/24-ssh-conflict.spec.ts.
    const target = path.join(fixture.tmpDir, 'sample.md');
    const local = await fs.readFile(target, 'utf8');

    // First open establishes the tab; the document view mounts.
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount on first open' },
    );

    // External rewrite of one line, from outside the app, with no edits made.
    const incoming = local.replace('Selectable phrase one', 'EXTERNALLY edited phrase one');
    await fs.writeFile(target, incoming, 'utf8');

    // Reopen the same path. With no unsaved edits and the default Ask
    // behavior, the backend returns ExternalReload → the IPC layer raises the
    // actionable "changed on disk" banner and keeps the current view, rather
    // than mounting the merge.
    await openDocByE2eHook(target);

    // The reload banner appears...
    await browser.waitUntil(
      async () => browser.$('[data-view="external-change"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'external-change reload banner did not appear' },
    );
    // ...and the 3-way merge view does NOT.
    expect(await browser.$('[data-view="conflict"]').isExisting()).toBe(false);
    expect(await browser.$('[data-view="document"]').isExisting()).toBe(true);

    // Clicking Reload pulls in the external content.
    const reloadBtn = browser.$('[data-view="external-change"] [data-action="reload"]');
    await reloadBtn.waitForExist({ timeout: 10_000 });
    await reloadBtn.click();
    await browser.waitUntil(
      async () =>
        (await browser.$('[data-view="document"]').getText()).includes(
          'EXTERNALLY edited phrase one',
        ),
      { timeout: 10_000, timeoutMsg: 'document did not reload the external content' },
    );

    // Reload is non-destructive: it never rewrites the file (no merge/save).
    const onDisk = await fs.readFile(target, 'utf8');
    expect(onDisk).toBe(incoming);
  });
});
