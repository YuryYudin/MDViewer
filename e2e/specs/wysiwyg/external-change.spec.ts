import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../../helpers/app';

/**
 * Phase-1 WYSIWYG acceptance: "External-change dialog appears over editor."
 *
 * Given the editor is dirty, when the file is modified outside the app
 * (wireframe 09-conflict-dialog.html), then the reload / keep /
 * hand-merge dialog appears AND autosave is paused until the user
 * dismisses it.
 *
 * RED until A.10 (LiveEditor dirty-flag + autosave pause hook) lands.
 * The dialog testid is [data-testid="external-change-modal"] per the
 * wireframe; its action buttons are data-action="discard-local",
 * "keep-local", and "hand-merge".
 */
describe('WYSIWYG: external-change dialog surfaces over the dirty live editor', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('pops the conflict modal and pauses autosave when the file changes externally', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    const original = await fs.readFile(target, 'utf8');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-testid="live-editor"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    // Make the editor dirty: type into the live editor without
    // forceSave so the local state diverges from disk.
    const insertAt = original.indexOf('A short paragraph') + 'A short paragraph'.length;
    await browser.executeAsync(
      function (off: number, done: (v: unknown) => void): void {
        const w = window as unknown as {
          __mdviewerE2E?: {
            setLiveEditorSelection?: (s: number, e: number) => Promise<void>;
            typeIntoLiveEditor?: (text: string) => Promise<void>;
          };
        };
        if (!w.__mdviewerE2E?.setLiveEditorSelection || !w.__mdviewerE2E?.typeIntoLiveEditor) {
          done({ error: 'live-editor hooks missing' });
          return;
        }
        w.__mdviewerE2E
          .setLiveEditorSelection(off, off)
          .then(() => w.__mdviewerE2E!.typeIntoLiveEditor!('Q'))
          .then(() => done(null), (e) => done({ error: String(e) }));
      },
      insertAt,
    );

    // Dirty indicator: tab strip carries [data-testid="tab-dirty"] per
    // wireframe 09 once the LiveEditor flips the dirty flag.
    await browser.waitUntil(
      async () => browser.$('[data-testid="tab-dirty"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'tab never marked dirty after live-editor type' },
    );

    // External rewrite outside the app — the watcher notices, the dirty
    // flag is set, so the conflict pathway fires the modal instead of
    // silently reloading.
    const incoming = original.replace('Section Two', 'EXTERNALLY Section Two');
    await fs.writeFile(target, incoming, 'utf8');

    const modal = browser.$('[data-testid="external-change-modal"]');
    await browser.waitUntil(
      async () => modal.isExisting(),
      { timeout: 10_000, timeoutMsg: 'external-change modal never appeared' },
    );

    // While the modal is open, autosave MUST be paused — even after the
    // debounce window elapses, the local dirty bytes don't land on disk.
    // We wait past the debounce (500ms) plus a generous margin.
    await new Promise((r) => setTimeout(r, 1500));
    const onDiskWhileModal = await fs.readFile(target, 'utf8');
    expect(onDiskWhileModal).toBe(incoming);
    expect(onDiskWhileModal.includes('AQ short paragraph')).toBe(false);

    // The three action buttons per wireframe-09.
    expect(await modal.$('button[data-action="discard-local"]').isExisting()).toBe(true);
    expect(await modal.$('button[data-action="keep-local"]').isExisting()).toBe(true);
    expect(await modal.$('button[data-action="hand-merge"]').isExisting()).toBe(true);

    // Dismiss with "keep-local" — autosave resumes and the next debounce
    // tick writes the local (dirty) bytes back to disk, overwriting the
    // external change.
    await modal.$('button[data-action="keep-local"]').click();
    await browser.waitUntil(
      async () => !(await modal.isExisting()),
      { timeout: 5_000, timeoutMsg: 'external-change modal never dismissed' },
    );

    await browser.waitUntil(
      async () => {
        const onDisk = await fs.readFile(target, 'utf8');
        return onDisk.includes('AQ short paragraph') || onDisk.includes('A short paragraphQ');
      },
      { timeout: 5_000, timeoutMsg: 'autosave never resumed after dialog dismissal' },
    );
  });
});
