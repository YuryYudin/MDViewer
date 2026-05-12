import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

describe('Edit the document and reattach anchors', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('reattaches t-1 and t-2 after a small edit, with no orphans', async () => {
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // Toggle into edit mode.
    await browser.$('[data-action="toggle-edit"]').click();
    await browser.waitUntil(
      async () => browser.$('[data-test="editor"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'editor did not mount' },
    );

    // Read the editor contents via the LiveEditor source hook (A.1).
    // Phase A's editor is a CodeMirror EditorView whose authoritative text
    // lives in `view.state.doc`, not a textarea. The previous `value = ...`
    // write path resolved `[data-test="editor"]` to the editor host DIV
    // under A.2's alias triple, so the assignment was a silent no-op. We
    // round-trip the source through the E2E hook on both read and write.
    const source = await browser.execute(() => {
      const api = (window as unknown as {
        __mdviewerE2E?: { getLiveEditorSource?: () => string };
      }).__mdviewerE2E;
      if (!api || typeof api.getLiveEditorSource !== 'function') {
        throw new Error('getLiveEditorSource hook not present');
      }
      return api.getLiveEditorSource();
    });

    // Locate the target phrase's byte offset (zero-width caret position
    // BEFORE the 'S' of "Selectable"). The pre-Phase-A code used
    // `value.replace('Selectable phrase one', 'edited Selectable phrase one')`
    // which inserts the 7-char delta at the offset of "Selectable" — NOT at
    // offset 0. We preserve that anchor-reattach-byte-faithful semantic by
    // locating the phrase with `indexOf` and positioning the caret there.
    const phrase = 'Selectable phrase one';
    const offset = source.indexOf(phrase);
    if (offset < 0) {
      throw new Error(`spec 05: phrase '${phrase}' not found in source`);
    }

    // Position the caret immediately before "Selectable" via
    // setLiveEditorSelection(offset, offset) (zero-width selection = caret
    // only), insert "edited " via typeIntoLiveEditor, then forceSave so the
    // sidecar reattachment pass downstream sees the updated source. The
    // forceSave call is load-bearing: the spec's reattachment assertion
    // reads the file after the save lands, and without it the assertion
    // races the autosave debounce.
    await browser.execute((off: number) => {
      const api = (window as unknown as {
        __mdviewerE2E?: {
          setLiveEditorSelection?: (s: number, e: number) => unknown;
          typeIntoLiveEditor?: (text: string) => unknown;
          forceSave?: () => unknown;
        };
      }).__mdviewerE2E;
      if (
        !api ||
        typeof api.setLiveEditorSelection !== 'function' ||
        typeof api.typeIntoLiveEditor !== 'function' ||
        typeof api.forceSave !== 'function'
      ) {
        throw new Error('spec 05: required __mdviewerE2E hooks missing');
      }
      api.setLiveEditorSelection(off, off);
      api.typeIntoLiveEditor('edited ');
      api.forceSave();
    }, offset);

    // Re-read the source through the hook to confirm the insertion landed
    // in the CodeMirror StateField (i.e. forceSave saw the updated doc).
    const updatedSource = await browser.execute(() => {
      const api = (window as unknown as {
        __mdviewerE2E?: { getLiveEditorSource?: () => string };
      }).__mdviewerE2E;
      if (!api || typeof api.getLiveEditorSource !== 'function') {
        throw new Error('getLiveEditorSource hook not present');
      }
      return api.getLiveEditorSource();
    });
    expect(updatedSource).toContain('edited Selectable phrase one');

    // Toggle back to view; the reattachment pass runs.
    await browser.$('[data-action="toggle-edit"]').click();
    await browser.waitUntil(
      async () => browser.$('[data-region="render"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'render region did not return' },
    );

    // Both t-1 and t-2 stay anchored; orphan count is zero.
    await browser.waitUntil(
      async () => {
        const t1 = await browser.$('[data-anchor="t-1"]').isExisting();
        const t2 = await browser.$('[data-anchor="t-2"]').isExisting();
        return t1 && t2;
      },
      { timeout: 15_000, timeoutMsg: 't-1 / t-2 not reattached' },
    ).catch(async () => {
      // Diagnostics: read the saved file from disk and the sidebar text.
      const fs = await import('node:fs/promises');
      const body = await fs.readFile(path.join(fixture.tmpDir, 'sample.md'), 'utf8');
      throw new Error(
        `reattach failed; saved bytes start: ${body.slice(0, 200)}`,
      );
    });

    expect(
      await browser
        .$('[data-view="sidebar-comments"] [data-test="anchored-count"]')
        .getText(),
    ).toBe('2');
    expect(
      await browser
        .$('[data-view="sidebar-comments"] [data-test="orphaned-count"]')
        .getText(),
    ).toBe('0');
  });
});
