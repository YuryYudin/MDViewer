import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('External change with no local edits does not force a merge', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('reopening an externally-changed doc with no edits stays a document, never a merge', async () => {
    // Regression guard for the "bogus merge on reload" bug: a document that
    // changed on disk while open but with NO unsaved edits must NOT surface
    // the 3-way merge on reopen. The merge UI for genuine unsaved-edit
    // conflicts is covered by tests/views/Conflict.test.ts (accept-left/right
    // + finish-merge) and e2e/24-ssh-conflict.spec.ts (save-conflict modal);
    // the reload-prompt decision is covered by the workspace lib tests
    // (reopen_after_external_change_* in src-tauri/src/workspace.rs).
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

    // Reopen the same path. With no unsaved edits the backend must keep this a
    // Document (and offer a reload) rather than mounting the merge view.
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount on reopen' },
    );

    // The 3-way merge view must NOT appear — that was the bug.
    expect(await browser.$('[data-view="conflict"]').isExisting()).toBe(false);

    // Reopen is non-destructive: the file on disk is untouched (no merge/save
    // wrote anything), so the external content is preserved verbatim.
    const onDisk = await fs.readFile(target, 'utf8');
    expect(onDisk).toBe(incoming);
  });
});
