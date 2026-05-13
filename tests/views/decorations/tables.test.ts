import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

import { tables } from '../../../src/views/decorations/tables';

/**
 * Spin up a real EditorView with the markdown language + the tables
 * extension. Attached to document.body so CodeMirror renders the DOM
 * for inspection. Each test cleans up via the afterEach hook below.
 */
function makeView(doc: string, selection?: { from: number; to?: number }): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: selection
      ? EditorSelection.single(selection.from, selection.to ?? selection.from)
      : EditorSelection.single(doc.length, doc.length),
    extensions: [markdown({ base: markdownLanguage, extensions: [GFM] }), tables()],
  });
  return new EditorView({ state, parent });
}

afterEach(() => {
  document.body.replaceChildren();
  // Reset E2E hooks set by the extension when __WEBDRIVER__ is enabled.
  const w = window as unknown as { __WEBDRIVER__?: unknown; __mdviewerE2E?: Record<string, unknown> };
  delete w.__WEBDRIVER__;
  if (w.__mdviewerE2E) {
    delete w.__mdviewerE2E.editTableCell;
  }
});

describe('tables extension', () => {
  describe('detection', () => {
    it('emits one [data-testid="table-widget"] per Table node', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const widgets = view.dom.querySelectorAll('[data-testid="table-widget"]');
      expect(widgets.length).toBe(1);
      view.destroy();
    });

    it('emits zero widgets when no Table is present', () => {
      const view = makeView('# Heading\n\nA paragraph.\n');
      expect(view.dom.querySelector('[data-testid="table-widget"]')).toBeNull();
      view.destroy();
    });

    it('emits two widgets for two separate tables', () => {
      const src = [
        '| a | b |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '| x | y |',
        '| - | - |',
        '| 9 | 8 |',
        '',
      ].join('\n');
      const view = makeView(src);
      expect(view.dom.querySelectorAll('[data-testid="table-widget"]').length).toBe(2);
      view.destroy();
    });
  });

  describe('per-cell DOM contract', () => {
    it('renders one contentEditable=true cell per body cell with data-row/data-col attributes', () => {
      const src = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |\n';
      const view = makeView(src);
      const cells = Array.from(
        view.dom.querySelectorAll<HTMLElement>(
          '[data-testid="table-widget"] [data-row][data-col]',
        ),
      );
      // Header row (row=-1 or "h") + body row 0; two columns each = 4 cells.
      expect(cells.length).toBeGreaterThanOrEqual(4);
      // Body cells are contentEditable=true.
      const bodyCells = cells.filter((c) => c.getAttribute('data-row') === '0');
      expect(bodyCells.length).toBe(2);
      bodyCells.forEach((c) => expect(c.getAttribute('contenteditable')).toBe('true'));
      // data-col indexes are stable 0/1.
      expect(bodyCells.map((c) => c.getAttribute('data-col')).sort()).toEqual(['0', '1']);
      view.destroy();
    });

    it('sets data-row="header" on header cells', () => {
      const src = '| Col A | Col B |\n|-------|-------|\n| 1 | 2 |\n';
      const view = makeView(src);
      const headers = view.dom.querySelectorAll<HTMLElement>(
        '[data-testid="table-widget"] [data-row="header"]',
      );
      expect(headers.length).toBe(2);
      view.destroy();
    });

    it('the toolbar exposes +row, +col, and ✎ Raw buttons', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const tbl = view.dom.querySelector<HTMLElement>('[data-testid="table-widget"]');
      expect(tbl).not.toBeNull();
      expect(tbl!.querySelector('button[data-action="add-row"]')).not.toBeNull();
      expect(tbl!.querySelector('button[data-action="add-col"]')).not.toBeNull();
      expect(tbl!.querySelector('button[data-action="raw-edit"]')).not.toBeNull();
      view.destroy();
    });
  });

  describe('cell edit', () => {
    it('cell edit dispatches a transaction replacing only the changed cell slice', () => {
      const src = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |\n';
      const view = makeView(src);
      const beforeDoc = view.state.doc.toString();

      // Locate the body row 0, col 0 cell — the "1" cell.
      const cell = view.dom.querySelector<HTMLElement>(
        '[data-testid="table-widget"] [data-row="0"][data-col="0"]',
      );
      expect(cell).not.toBeNull();
      const spyDispatch = vi.spyOn(view, 'dispatch');

      // Simulate typing into the cell via DOM mutation + input event.
      cell!.textContent = '999';
      cell!.dispatchEvent(new Event('input', { bubbles: true }));

      // Exactly one dispatch call.
      expect(spyDispatch).toHaveBeenCalledTimes(1);
      const arg = spyDispatch.mock.calls[0][0] as { changes?: { from: number; to: number; insert: string }; userEvent?: string };
      expect(arg.changes).toBeDefined();
      // The replaced slice must be the cell's source range (not the
      // whole row, not the whole table).
      const origCellOffset = beforeDoc.indexOf('1     ');
      expect(arg.changes!.from).toBe(origCellOffset);
      expect(arg.changes!.to).toBeLessThanOrEqual(origCellOffset + '1     '.length);
      expect(arg.changes!.insert).toContain('999');
      // userEvent annotation must be present so autosave fires.
      expect(arg.userEvent).toBeTruthy();

      spyDispatch.mockRestore();
      view.destroy();
    });

    it('cell edit leaves other rows/cells byte-identical', () => {
      const src = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |\n';
      const view = makeView(src);
      const cell = view.dom.querySelector<HTMLElement>(
        '[data-testid="table-widget"] [data-row="0"][data-col="0"]',
      );
      expect(cell).not.toBeNull();
      cell!.textContent = '999';
      cell!.dispatchEvent(new Event('input', { bubbles: true }));

      const after = view.state.doc.toString();
      const beforeLines = src.split('\n');
      const afterLines = after.split('\n');
      expect(afterLines.length).toBe(beforeLines.length);
      // Header + alignment row + trailing empty line stay byte-identical.
      expect(afterLines[0]).toBe(beforeLines[0]);
      expect(afterLines[1]).toBe(beforeLines[1]);
      // Body row changed only in the "1" cell.
      expect(afterLines[2]).toContain('999');
      expect(afterLines[2]).toContain('| 2');
      view.destroy();
    });

    it('cell edits without actual change (same text) skip the dispatch (no-op)', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const cell = view.dom.querySelector<HTMLElement>(
        '[data-testid="table-widget"] [data-row="0"][data-col="0"]',
      );
      expect(cell).not.toBeNull();
      const spy = vi.spyOn(view, 'dispatch');
      // Same text — no-op dispatch.
      cell!.textContent = '1';
      cell!.dispatchEvent(new Event('input', { bubbles: true }));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      view.destroy();
    });
  });

  describe('+ row', () => {
    it('inserts a new row below the active row with the same column count', () => {
      const src = '| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n';
      const view = makeView(src);
      const tbl = view.dom.querySelector<HTMLElement>('[data-testid="table-widget"]');
      const addRow = tbl!.querySelector<HTMLButtonElement>('button[data-action="add-row"]');
      expect(addRow).not.toBeNull();
      // Focus a body cell first so "active row" is row 0.
      const cell = tbl!.querySelector<HTMLElement>('[data-row="0"][data-col="0"]');
      cell!.focus();
      addRow!.click();
      const after = view.state.doc.toString();
      const afterLines = after.split('\n').filter((l) => l.length > 0);
      // Header (1) + alignment (1) + original body row (1) + new row (1) = 4.
      expect(afterLines.length).toBe(4);
      // New row has three columns and is empty.
      const newRow = afterLines[3];
      // Three pipe-separated empty cells == 4 pipes.
      const pipes = (newRow.match(/\|/g) ?? []).length;
      expect(pipes).toBe(4);
      view.destroy();
    });

    it('appends the new row at the end when no body cell has focus', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const tbl = view.dom.querySelector<HTMLElement>('[data-testid="table-widget"]');
      const addRow = tbl!.querySelector<HTMLButtonElement>('button[data-action="add-row"]');
      addRow!.click();
      const after = view.state.doc.toString();
      const afterLines = after.split('\n').filter((l) => l.length > 0);
      expect(afterLines.length).toBe(4);
      // Column count preserved.
      const pipes = (afterLines[afterLines.length - 1].match(/\|/g) ?? []).length;
      expect(pipes).toBe(3);
      view.destroy();
    });

    it('inserts after the row whose source range intersects the main selection', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n';
      const view = makeView(src, { from: 22 }); // inside the "| 1 | 2 |" row
      const addRow = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="add-row"]',
      );
      addRow!.click();
      const after = view.state.doc.toString();
      const afterLines = after.split('\n').filter((l) => l.length > 0);
      // header + alignment + original 2 body rows + new row = 5
      expect(afterLines.length).toBe(5);
      // The newly-inserted empty row should be at line index 3 (between
      // the original "1 | 2" and "3 | 4" rows). Its trimmed content
      // is a sequence of pipes + spaces only.
      const cells3 = afterLines[3].split('|').filter((c) => c.length > 0);
      cells3.forEach((c) => expect(c.trim()).toBe(''));
      view.destroy();
    });
  });

  describe('+ col', () => {
    it('inserts an empty column with a header cell', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const tbl = view.dom.querySelector<HTMLElement>('[data-testid="table-widget"]');
      const addCol = tbl!.querySelector<HTMLButtonElement>('button[data-action="add-col"]');
      expect(addCol).not.toBeNull();
      addCol!.click();
      const after = view.state.doc.toString();
      const afterLines = after.split('\n').filter((l) => l.length > 0);
      expect(afterLines.length).toBe(3);
      // Each row now has 4 pipes (3 columns).
      afterLines.forEach((line) => {
        const pipes = (line.match(/\|/g) ?? []).length;
        expect(pipes).toBe(4);
      });
      // The alignment row's new column is a dash placeholder.
      expect(afterLines[1]).toMatch(/-/);
      view.destroy();
    });
  });

  describe('✎ Raw pencil', () => {
    it('opens a block-scoped raw editor for the table source on click', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const tbl = view.dom.querySelector<HTMLElement>('[data-testid="table-widget"]');
      const pencil = tbl!.querySelector<HTMLButtonElement>('button[data-action="raw-edit"]');
      expect(pencil).not.toBeNull();
      pencil!.click();
      // After click, the rendered widget is replaced by a raw editor.
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(raw).not.toBeNull();
      // The raw editor displays the literal GFM pipes.
      expect(raw!.textContent).toContain('| a | b |');
      expect(raw!.textContent).toContain('| 1 | 2 |');
      view.destroy();
    });

    it('raw pencil commit closes the raw editor and dispatches a single replace transaction for the whole table block', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const pencil = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="raw-edit"]',
      );
      pencil!.click();
      // Locate the sub-CodeMirror's textarea / contentDOM.
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(raw).not.toBeNull();
      // Modify the raw editor's contents via its E2E setter — the
      // production cell-editor exposes the value via a hidden helper
      // attribute that the test driver consumes.
      const setValue = (raw as HTMLElement & { __setValue?: (s: string) => void }).__setValue;
      expect(setValue).toBeTypeOf('function');
      setValue!('| a | b |\n| - | - |\n| 99 | 88 |');
      // Spy on dispatch BEFORE clicking commit so we see exactly one
      // dispatch for the table replacement.
      const spy = vi.spyOn(view, 'dispatch');
      const commit = raw!.querySelector<HTMLButtonElement>('button[data-action="commit-raw"]');
      expect(commit).not.toBeNull();
      commit!.click();
      // Exactly one dispatch on commit.
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0][0] as { changes?: { from: number; to: number; insert: string } };
      expect(arg.changes).toBeDefined();
      expect(arg.changes!.from).toBe(0);
      // The replacement spans the original table block — up to the
      // table source end (29 for this fixture before trailing newline).
      expect(arg.changes!.insert).toContain('| 99 | 88 |');
      // Raw editor is gone after commit (rendered table returns on next paint).
      expect(view.dom.querySelector('[data-testid="table-widget-raw"]')).toBeNull();
      spy.mockRestore();
      view.destroy();
    });

    it('raw pencil round-trips bytes byte-identical when committed with no edit', () => {
      const src = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |\n';
      const view = makeView(src);
      const before = view.state.doc.toString();
      const pencil = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="raw-edit"]',
      );
      pencil!.click();
      const commit = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget-raw"] button[data-action="commit-raw"]',
      );
      commit!.click();
      const after = view.state.doc.toString();
      expect(after).toBe(before);
      view.destroy();
    });

    it('cancel returns to the rendered widget and leaves the source byte-identical', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const before = view.state.doc.toString();
      const pencil = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="raw-edit"]',
      );
      pencil!.click();
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(raw).not.toBeNull();
      // Even if the user typed something, cancel discards the changes.
      const setValue = (raw as HTMLElement & { __setValue?: (s: string) => void }).__setValue;
      setValue!('garbage content the user typed');
      const cancel = raw!.querySelector<HTMLButtonElement>('button[data-action="cancel-raw"]');
      expect(cancel).not.toBeNull();
      cancel!.click();
      expect(view.state.doc.toString()).toBe(before);
      // Rendered widget is back; raw editor is gone.
      expect(view.dom.querySelector('[data-testid="table-widget-raw"]')).toBeNull();
      expect(view.dom.querySelector('[data-testid="table-widget"]')).not.toBeNull();
      view.destroy();
    });

    it('typing in the raw editor updates the in-flight value tracked by the commit handler', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const pencil = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="raw-edit"]',
      );
      pencil!.click();
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      const textarea = raw!.querySelector<HTMLTextAreaElement>('textarea');
      expect(textarea).not.toBeNull();
      // Simulate the user editing the textarea — the closure-tracked
      // currentValue follows the textarea.value through the 'input'
      // event listener.
      textarea!.value = '| zz | yy |\n| - | - |\n| qq | ww |';
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      const commit = raw!.querySelector<HTMLButtonElement>('button[data-action="commit-raw"]');
      commit!.click();
      expect(view.state.doc.toString()).toContain('| zz | yy |');
      view.destroy();
    });
  });

  describe('alignment-row + pipe-escape fall back to raw pencil', () => {
    it('clicking a cell whose source contains an escaped pipe automatically opens the raw pencil', () => {
      const src = '| a | b |\n| - | - |\n| 1\\|x | 2 |\n';
      const view = makeView(src);
      // The cell with the escaped pipe should be flagged as read-only
      // (contentEditable=false) and triggering input on it does nothing.
      const cell = view.dom.querySelector<HTMLElement>(
        '[data-testid="table-widget"] [data-row="0"][data-col="0"]',
      );
      expect(cell).not.toBeNull();
      expect(cell!.getAttribute('contenteditable')).toBe('false');
      // Clicking it triggers the raw pencil.
      cell!.click();
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(raw).not.toBeNull();
      view.destroy();
    });
  });

  describe('E2E hook', () => {
    beforeEach(() => {
      (window as unknown as { __WEBDRIVER__?: unknown }).__WEBDRIVER__ = true;
    });

    it('exposes window.__mdviewerE2E.editTableCell when __WEBDRIVER__ is set', async () => {
      const src = '| Col A | Col B |\n|-------|-------|\n| 1     | 2     |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: (r: number, c: number, v: string) => Promise<void> } };
      expect(w.__mdviewerE2E?.editTableCell).toBeTypeOf('function');
      await w.__mdviewerE2E!.editTableCell!(0, 0, '999');
      const after = view.state.doc.toString();
      const afterLines = after.split('\n');
      expect(afterLines[2]).toContain('999');
      // Header unchanged.
      expect(afterLines[0]).toBe('| Col A | Col B |');
      view.destroy();
    });

    it('editTableCell rejects when the target row is out of range', async () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: (r: number, c: number, v: string) => Promise<void> } };
      await expect(w.__mdviewerE2E!.editTableCell!(99, 0, 'x')).rejects.toThrow(/row 99 out of range/);
      view.destroy();
    });

    it('editTableCell rejects when the target col is out of range', async () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: (r: number, c: number, v: string) => Promise<void> } };
      await expect(w.__mdviewerE2E!.editTableCell!(0, 99, 'x')).rejects.toThrow(/col 99 out of range/);
      view.destroy();
    });

    it('editTableCell rejects with negative row index', async () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: (r: number, c: number, v: string) => Promise<void> } };
      await expect(w.__mdviewerE2E!.editTableCell!(-1, 0, 'x')).rejects.toThrow();
      view.destroy();
    });

    it('editTableCell rejects with negative col index', async () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: (r: number, c: number, v: string) => Promise<void> } };
      await expect(w.__mdviewerE2E!.editTableCell!(0, -1, 'x')).rejects.toThrow();
      view.destroy();
    });

    it('editTableCell rejects when the document has no table', async () => {
      const src = '# Heading only — no table here.\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: (r: number, c: number, v: string) => Promise<void> } };
      await expect(w.__mdviewerE2E!.editTableCell!(0, 0, 'x')).rejects.toThrow(/no tables/);
      view.destroy();
    });

    it('installs the hook alongside other __mdviewerE2E slots without clobbering them', () => {
      const w = window as unknown as { __mdviewerE2E?: Record<string, unknown> };
      // Pre-existing slot from a sibling module (e.g. LiveEditor's forceSave).
      w.__mdviewerE2E = { someExistingSlot: 'preserve me' };
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const after = window as unknown as { __mdviewerE2E?: { editTableCell?: unknown; someExistingSlot?: unknown } };
      expect(after.__mdviewerE2E?.someExistingSlot).toBe('preserve me');
      expect(after.__mdviewerE2E?.editTableCell).toBeTypeOf('function');
      view.destroy();
    });

    it('cleans up the editTableCell hook on view destroy', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: unknown } };
      expect(w.__mdviewerE2E?.editTableCell).toBeTypeOf('function');
      view.destroy();
      expect(w.__mdviewerE2E?.editTableCell).toBeUndefined();
    });

    it('does not attach the hook when __WEBDRIVER__ is unset', () => {
      // Remove the flag this beforeEach set.
      delete (window as unknown as { __WEBDRIVER__?: unknown }).__WEBDRIVER__;
      // Wipe any leftover hook from previous tests.
      const w0 = window as unknown as { __mdviewerE2E?: Record<string, unknown> };
      if (w0.__mdviewerE2E) delete w0.__mdviewerE2E.editTableCell;
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const w = window as unknown as { __mdviewerE2E?: { editTableCell?: unknown } };
      expect(w.__mdviewerE2E?.editTableCell).toBeUndefined();
      view.destroy();
    });
  });

  describe('export shape', () => {
    it('tables() returns a CodeMirror Extension', () => {
      const ext = tables();
      const state = EditorState.create({ doc: '', extensions: [ext] });
      expect(state.doc.length).toBe(0);
    });
  });

  describe('widget lifecycle', () => {
    it('TableWidget.ignoreEvent returns false to route interior events into the widget DOM', () => {
      // The contract: interior events (cell input, toolbar clicks) must
      // reach the widget DOM. If ignoreEvent returned true, the toolbar
      // buttons themselves would never fire. We assert the contract by
      // dispatching a non-handled event (mousedown) — the widget DOM
      // must still be present afterwards, and the test exercises the
      // override's "return false" line.
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const widget = view.dom.querySelector<HTMLElement>('[data-testid="table-widget"]');
      expect(widget).not.toBeNull();
      widget!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      // Still rendered.
      expect(view.dom.querySelector('[data-testid="table-widget"]')).not.toBeNull();
      view.destroy();
    });

    it('RawTableWidget.ignoreEvent returns false (interior typing reaches the textarea)', () => {
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n';
      const view = makeView(src);
      const pencil = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="raw-edit"]',
      );
      pencil!.click();
      const raw = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(raw).not.toBeNull();
      // A mousedown on the raw root must still leave the widget mounted
      // (the override returning `false` is what lets the textarea inside
      // receive focus normally).
      raw!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      expect(view.dom.querySelector('[data-testid="table-widget-raw"]')).not.toBeNull();
      view.destroy();
    });

    it('RawTableWidget reuses DOM across recomputes when source unchanged (eq + updateDOM)', () => {
      // Need a doc that has trailing content the test can edit without
      // disturbing the table — that way the StateField recomputes
      // (docChanged) and the eq/updateDOM path on RawTableWidget fires.
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n\ntrailing prose.';
      const view = makeView(src);
      const pencil = view.dom.querySelector<HTMLButtonElement>(
        '[data-testid="table-widget"] button[data-action="raw-edit"]',
      );
      pencil!.click();
      const firstRoot = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(firstRoot).not.toBeNull();
      // Edit OUTSIDE the table — the table's source bytes are
      // unchanged, so a fresh RawTableWidget is constructed by
      // buildDecorations but eq() returns true against the previous
      // one and updateDOM() returns true to reuse the existing DOM.
      const trailingOffset = src.indexOf('trailing');
      view.dispatch({
        changes: { from: trailingOffset, insert: 'X' },
        userEvent: 'input.type',
      });
      const secondRoot = view.dom.querySelector<HTMLElement>('[data-testid="table-widget-raw"]');
      expect(secondRoot).toBe(firstRoot);
      view.destroy();
    });

    it('selection-only transactions re-map the RangeSet without rebuilding widgets', () => {
      // Exercises the `return value.map(tr.changes)` branch of the
      // StateField update. A selection-only transaction leaves the
      // RangeSet identity stable; the widget DOM is unchanged.
      const src = '| a | b |\n| - | - |\n| 1 | 2 |\n\nsome trailing prose.';
      const view = makeView(src);
      const widget1 = view.dom.querySelector('[data-testid="table-widget"]');
      expect(widget1).not.toBeNull();
      // Dispatch a pure selection change (no doc change, no raw effect).
      view.dispatch({ selection: { anchor: src.length - 1 } });
      const widget2 = view.dom.querySelector('[data-testid="table-widget"]');
      // Same DOM element (eq + updateDOM kept the existing widget).
      expect(widget2).toBe(widget1);
      view.destroy();
    });
  });
});
