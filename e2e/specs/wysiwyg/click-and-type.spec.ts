import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../../helpers/app';

/**
 * Phase-1 WYSIWYG acceptance: "Click-and-type in a paragraph."
 *
 * Given the user opens a document, when they click inside a paragraph in
 * `wireframes/01-render-default.html` and type a character, then the
 * autosaved file contains the new character at the corresponding source
 * offset.
 *
 * This spec is RED until A.10 / A.11 (LiveEditor + autosave timer) lands.
 * The CodeMirror-based [data-testid="live-editor"] surface and its
 * `__mdviewerE2E.forceSave()` handle don't exist on the current build.
 */
describe('WYSIWYG: click-and-type in a paragraph autosaves at the source offset', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // No sidecar comments — keep this spec independent of comment plumbing.
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('inserts the typed character into the file at the matching source offset', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    const original = await fs.readFile(target, 'utf8');

    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // The new LiveEditor mounts a CodeMirror surface tagged
    // data-testid="live-editor". A1's RED state: this testid does not
    // exist yet — Document.ts still mounts the legacy render/edit pair.
    const liveEditor = browser.$('[data-testid="live-editor"]');
    await browser.waitUntil(
      async () => liveEditor.isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    // Render mode must be the new default (wireframe 01). The mode-toggle
    // testid is set by Document.ts's new toolbar and reads "render" when
    // the live editor opens.
    const modeToggle = browser.$('[data-testid="mode-toggle"]');
    expect(await modeToggle.isExisting()).toBe(true);
    const activeMode = await browser.execute(() => {
      const tg = document.querySelector('[data-testid="mode-toggle"]');
      const onBtn = tg?.querySelector('button.on') ?? tg?.querySelector('button[aria-pressed="true"]');
      return onBtn?.getAttribute('data-mode') ?? null;
    });
    expect(activeMode).toBe('render');

    // Click somewhere inside the rendered "A short paragraph..." text.
    // The CodeMirror surface lays out a contenteditable carrying the
    // rendered HTML; clicking inside it should set the caret at the
    // matching markdown source offset, which the LiveEditor's
    // EditorView.state.selection.main reports.
    const charToInsert = 'Z';
    // We use the e2e hook to (a) position the caret deterministically at
    // a known source offset (just after "A short paragraph ") and (b)
    // dispatch the character so the WDIO -> WebDriver text-input path
    // doesn't have to navigate the CM widget surface.
    const expectedOffset = original.indexOf('A short paragraph ') + 'A short paragraph '.length;
    expect(expectedOffset).toBeGreaterThan(0);

    await browser.executeAsync(
      function (offset: number, ch: string, done: (v: unknown) => void): void {
        const w = window as unknown as {
          __mdviewerE2E?: {
            setLiveEditorSelection?: (start: number, end: number) => Promise<void>;
            typeIntoLiveEditor?: (text: string) => Promise<void>;
          };
        };
        if (!w.__mdviewerE2E?.setLiveEditorSelection || !w.__mdviewerE2E?.typeIntoLiveEditor) {
          done({ error: 'live-editor e2e hook missing' });
          return;
        }
        w.__mdviewerE2E
          .setLiveEditorSelection(offset, offset)
          .then(() => w.__mdviewerE2E!.typeIntoLiveEditor!(ch))
          .then(() => done(null), (e) => done({ error: String(e) }));
      },
      expectedOffset,
      charToInsert,
    );

    // Force autosave so we don't have to race the 500ms debounce timer.
    await browser.executeAsync(function (done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { forceSave?: () => Promise<void> };
      };
      if (!w.__mdviewerE2E?.forceSave) {
        done({ error: 'forceSave hook missing' });
        return;
      }
      w.__mdviewerE2E.forceSave().then(() => done(null), (e) => done({ error: String(e) }));
    });

    await browser.waitUntil(
      async () => {
        const onDisk = await fs.readFile(target, 'utf8');
        return onDisk.length === original.length + 1;
      },
      { timeout: 5_000, timeoutMsg: 'autosave never landed after type' },
    );

    const saved = await fs.readFile(target, 'utf8');
    expect(saved[expectedOffset]).toBe(charToInsert);
    expect(saved.slice(0, expectedOffset)).toBe(original.slice(0, expectedOffset));
    expect(saved.slice(expectedOffset + 1)).toBe(original.slice(expectedOffset));
  });
});
