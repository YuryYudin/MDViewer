import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../../helpers/app';

/**
 * Phase-2 WYSIWYG acceptance: table-cell edit + raw-pencil fallback.
 *
 *  (a) Editing a cell in the rendered table autosaves ONLY that cell's
 *      source — other rows/cells remain byte-identical (wireframe
 *      07-table-cell-edit.html).
 *  (b) Clicking the ✎ Raw pencil opens a block-scoped raw editor for the
 *      table's GFM source and closes on commit.
 *
 * The schema places this spec in the Phase-1 e2e-red wave so the suite
 * is RED across the whole feature — the green-flip lands with the
 * tables.ts decoration extension in Phase 2 (B.1+).
 */
describe('WYSIWYG: table cell edit autosaves and ✎ Raw opens a block-scoped editor', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('changes only the target cell and leaves the rest of the table byte-identical', async () => {
    // The sample.md fixture contains a 2x2 GFM table — | Col A | Col B |
    // with rows | 1 | 2 |. We change the "1" to "999" and assert the
    // rest of the table doesn't get reformatted.
    const target = path.join(fixture.tmpDir, 'sample.md');
    const original = await fs.readFile(target, 'utf8');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-testid="live-editor"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    const table = browser.$('[data-testid="table-widget"]');
    await browser.waitUntil(
      async () => table.isExisting(),
      { timeout: 5_000, timeoutMsg: 'table widget never rendered' },
    );

    // Find the cell whose text content is "1" and edit it via the
    // contenteditable surface. The tables.ts extension makes <td>s
    // editable in place; we drive the edit through the e2e hook to
    // avoid WebDriver/contenteditable focus quirks.
    await browser.executeAsync(function (done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { editTableCell?: (rowIndex: number, colIndex: number, newValue: string) => Promise<void> };
      };
      if (!w.__mdviewerE2E?.editTableCell) {
        done({ error: 'editTableCell hook missing' });
        return;
      }
      // Row 0 / col 0 of the BODY (the "1" cell — header rows are not
      // counted in the body-relative index).
      w.__mdviewerE2E.editTableCell(0, 0, '999').then(
        () => done(null),
        (e) => done({ error: String(e) }),
      );
    });

    await browser.executeAsync(function (done: (v: unknown) => void): void {
      const w = window as unknown as { __mdviewerE2E?: { forceSave?: () => Promise<void> } };
      if (!w.__mdviewerE2E?.forceSave) {
        done({ error: 'forceSave hook missing' });
        return;
      }
      w.__mdviewerE2E.forceSave().then(() => done(null), (e) => done({ error: String(e) }));
    });

    await browser.waitUntil(
      async () => {
        const onDisk = await fs.readFile(target, 'utf8');
        return onDisk.includes('| 999');
      },
      { timeout: 5_000, timeoutMsg: 'autosave never landed table edit' },
    );

    const saved = await fs.readFile(target, 'utf8');
    // Only the target cell changed: every line UN-related to the body
    // row stays byte-identical.
    const origLines = original.split('\n');
    const savedLines = saved.split('\n');
    expect(savedLines.length).toBe(origLines.length);
    for (let i = 0; i < origLines.length; i++) {
      if (origLines[i].trim().startsWith('| 1 ')) {
        // Edited row: "1" -> "999"; column B value unchanged.
        expect(savedLines[i]).toContain('999');
        expect(savedLines[i]).toContain('| 2');
      } else {
        expect(savedLines[i]).toBe(origLines[i]);
      }
    }
  });

  it('✎ Raw pencil opens a block-scoped raw editor and closes on commit', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-testid="live-editor"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    const table = browser.$('[data-testid="table-widget"]');
    await browser.waitUntil(
      async () => table.isExisting(),
      { timeout: 5_000, timeoutMsg: 'table widget never rendered' },
    );

    const pencil = table.$('button[data-action="raw-edit"]');
    expect(await pencil.isExisting()).toBe(true);
    await pencil.click();

    // The pencil opens a block-scoped raw editor — a CodeMirror sub-view
    // showing just the table's GFM source, with the same testid pattern
    // as code-widget-raw but for table.
    const rawEditor = browser.$('[data-testid="table-widget-raw"]');
    await browser.waitUntil(
      async () => rawEditor.isExisting(),
      { timeout: 5_000, timeoutMsg: 'block-scoped raw table editor never opened' },
    );
    // The raw editor surface displays the literal GFM pipes.
    expect(await rawEditor.getText()).toContain('| Col A | Col B |');

    // Commit closes the raw editor and brings the rendered widget back.
    const commit = rawEditor.$('button[data-action="commit-raw"]');
    expect(await commit.isExisting()).toBe(true);
    await commit.click();
    await browser.waitUntil(
      async () => !(await rawEditor.isExisting()),
      { timeout: 5_000, timeoutMsg: 'raw table editor never closed on commit' },
    );
    await browser.waitUntil(
      async () => browser.$('[data-testid="table-widget"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'rendered table widget never returned post-commit' },
    );
  });
});
