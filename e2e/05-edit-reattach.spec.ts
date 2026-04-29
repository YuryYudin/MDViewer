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
    // Read the editor contents and set the new value via direct DOM
    // assignment — wdio's setValue/addValue routes go through the plugin's
    // send-keys path which doesn't reliably populate textareas under
    // WKWebView. Dispatching `input` ensures Edit.ts's autosave debounce
    // fires (although autoSave is off by default, the path being taken
    // matches the manual-save flow that toggleEdit force-flushes).
    const inserted = await browser.execute((expectedFind: string, replace: string) => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-test="editor"]');
      if (!ta) throw new Error('editor missing');
      ta.value = ta.value.replace(expectedFind, replace);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    }, 'Selectable phrase one', 'edited Selectable phrase one');
    expect(inserted).toContain('edited Selectable phrase one');

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
