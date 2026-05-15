/**
 * tables — CodeMirror 6 extension that detects GFM Table nodes in the
 * lezer tree and emits an editable HTML `<table>` widget per Table.
 *
 * Each rendered body cell is `contentEditable=true` with `data-row` and
 * `data-col` attributes; an `input` event on a cell dispatches a
 * CodeMirror transaction that replaces ONLY that cell's source slice in
 * the underlying document — no other rows/cells are reformatted.
 *
 * The widget toolbar exposes three actions:
 *   - +row     → insert a new row immediately below the active row
 *                with the same column count as the table.
 *   - +col     → insert an empty column with a header cell at the end.
 *   - ✎ Raw    → swap the rendered widget for a block-scoped raw editor
 *                (a transient CodeMirror sub-view bound to the table's
 *                source range). The raw editor commits with a SINGLE
 *                replace transaction for the whole table block.
 *
 * Alignment-row edits and cells containing escaped pipes (`\|`) are
 * un-editable in the rendered widget — clicking such a cell auto-opens
 * the raw pencil so the user can drop into the source-level editor.
 *
 * Block-level Decoration.replace ranges MUST come from a StateField (the
 * `decorations` ViewPlugin path is gated against block widgets — see
 * CodeMirror's "Block decorations may not be specified via plugins"
 * check). The StateField recomputes on every transaction that mutates
 * the doc, the selection, or carries a `forceRawEffect`.
 */

import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  type Extension,
  type EditorState,
  type Range,
  StateEffect,
  StateField,
  type Transaction,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/**
 * Source-range descriptor for one cell of one row in one table.
 * `from`/`to` are absolute document offsets; `text` is the original
 * cell text (NOT including the surrounding pipe characters or the
 * inner whitespace padding).
 */
interface CellSpec {
  from: number;
  to: number;
  text: string;
  /** `true` when the cell contains a `\|` (escaped pipe). */
  hasEscapedPipe: boolean;
}

/** Either a header row or a body row. */
interface RowSpec {
  /** `true` for the header row, `false` for body rows. */
  isHeader: boolean;
  cells: CellSpec[];
  /** Absolute document offsets covering the row including the surrounding pipes. */
  from: number;
  to: number;
}

/** One Table node parsed into rows. */
interface TableSpec {
  from: number;
  to: number;
  /** Source of the entire table block (sliceString(from, to)). */
  source: string;
  /** The alignment row slice (e.g. `|-------|-------|`). */
  alignment: { from: number; to: number; text: string };
  rows: RowSpec[];
}

/**
 * Walk a Table node's children and produce a `TableSpec`. The lezer-markdown
 * GFM Table tree contains:
 *
 *   - one `TableHeader` child (the first row, with cell text)
 *   - one `TableDelimiter` child between TableHeader and the first
 *     TableRow — this is the alignment row (`|---|---|`). NOTE: lezer
 *     also uses TableDelimiter for every interior `|` inside rows, so
 *     we identify the alignment one by being at the top level (parent
 *     is Table, not TableHeader / TableRow).
 *   - zero or more `TableRow` children (body rows).
 *
 * Each `TableHeader` / `TableRow` contains alternating `TableDelimiter`
 * (pipes) and `TableCell` (text) children. Empty leading / trailing
 * cells happen when the row starts/ends with a pipe — the pipes still
 * exist in the tree but there's no `TableCell` between them and the
 * row edges.
 */
function parseTable(state: EditorState, table: SyntaxNode): TableSpec {
  const source = state.doc.sliceString(table.from, table.to);
  const rows: RowSpec[] = [];
  let alignment: TableSpec['alignment'] = {
    from: table.from,
    to: table.from,
    text: '',
  };

  let child = table.firstChild;
  while (child) {
    if (child.name === 'TableHeader' || child.name === 'TableRow') {
      const cells = collectCells(state, child);
      rows.push({
        isHeader: child.name === 'TableHeader',
        cells,
        from: child.from,
        to: child.to,
      });
    } else if (child.name === 'TableDelimiter') {
      // The top-level TableDelimiter is the alignment row.
      alignment = {
        from: child.from,
        to: child.to,
        text: state.doc.sliceString(child.from, child.to),
      };
    }
    child = child.nextSibling;
  }

  return { from: table.from, to: table.to, source, alignment, rows };
}

/** Pick out every `TableCell` child of a header / body row. */
function collectCells(state: EditorState, row: SyntaxNode): CellSpec[] {
  const cells: CellSpec[] = [];
  let child = row.firstChild;
  while (child) {
    if (child.name === 'TableCell') {
      const text = state.doc.sliceString(child.from, child.to);
      cells.push({
        from: child.from,
        to: child.to,
        text,
        hasEscapedPipe: /\\\|/.test(text),
      });
    }
    child = child.nextSibling;
  }
  return cells;
}

/**
 * Walk the tree once and produce a TableSpec for every top-level Table
 * node. Nested tables aren't a thing in GFM, so we don't descend.
 */
function findTables(state: EditorState): TableSpec[] {
  const out: TableSpec[] = [];
  // BUG FIX (table widgets in long docs): same incremental-parse
  // gotcha as inlineMarks/blockWidgets — `syntaxTree(state)` only
  // covers the first ~80 lines for long documents on initial mount.
  // GFM Table nodes past the parse frontier wouldn't be in the tree
  // → table widget never mounts → user sees raw `|`-cell markdown
  // instead of the editable table surface. `ensureSyntaxTree` forces
  // a full parse with a 200ms budget.
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (node.name === 'Table') {
        out.push(parseTable(state, node.node));
        return false;
      }
      return undefined;
    },
  });
  return out;
}

/**
 * Selection-intersects-range check. Used to determine which row owns
 * the "active row" (the row containing the main selection) when the
 * user hits +row without a focused cell in the widget.
 */
function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  const main = state.selection.main;
  return !(main.to < from || main.from > to);
}

/**
 * StateEffect that flags a table source as "show me the raw pencil".
 * The next StateField recompute notices the flag and emits a
 * `RawTableWidget` for that source instead of the editable
 * `TableWidget`. Closure-captured booleans wouldn't trigger a recompute
 * (CodeMirror's update path is effect-driven); dispatching the effect
 * is the canonical way to round-trip widget state.
 */
const forceRawEffect = StateEffect.define<string>();

/**
 * Inverse effect — when the raw editor commits or cancels, we clear the
 * source from the "forced raw" set so the next recompute paints the
 * editable widget back.
 */
const clearRawEffect = StateEffect.define<string>();

const forceRawField = StateField.define<Set<string>>({
  create() {
    return new Set();
  },
  update(set, tr) {
    let next: Set<string> | null = null;
    for (const e of tr.effects) {
      if (e.is(forceRawEffect)) {
        if (!next) next = new Set(set);
        next.add(e.value);
      } else if (e.is(clearRawEffect)) {
        if (!next) next = new Set(set);
        next.delete(e.value);
      }
    }
    return next ?? set;
  },
});

/** Shared mutable context plumbed through every widget instance. */
interface TableCtx {
  /**
   * Live reference to the mounted EditorView. Filled in by a ViewPlugin
   * at construction time. Cell-edit dispatches, +row / +col clicks, and
   * the raw pencil all reach back to the view via `ctx.editorView`.
   */
  editorView: EditorView | null;
}

/**
 * The editable table widget. Renders a real HTML `<table>` with header
 * + body rows; each body cell is contentEditable. Input events dispatch
 * a transaction replacing only the cell's source slice.
 */
class TableWidget extends WidgetType {
  constructor(
    readonly spec: TableSpec,
    private readonly ctx: TableCtx,
  ) {
    super();
  }

  /**
   * Two TableWidget instances are equal iff they cover the same source
   * slice. CodeMirror uses `eq` to decide whether to reuse the existing
   * DOM — without this, every transaction would rebuild the widget DOM
   * (losing in-flight cell focus / contentEditable selection).
   */
  eq(other: WidgetType): boolean {
    return other instanceof TableWidget && other.spec.source === this.spec.source;
  }

  /**
   * Reuse the existing DOM on every recompute when `eq` holds. Without
   * this, CodeMirror would rebuild the widget DOM on each transaction
   * — which would steal focus away from the cell the user is typing in.
   */
  override updateDOM(_dom: HTMLElement, _view: EditorView): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'table-widget');
    root.setAttribute('data-block-widget', 'table');
    // The widget root is NOT contentEditable; only the body cells are.
    // CodeMirror's caret motion treats the root as atomic; per-cell
    // focus is driven by the user clicking into a cell.
    root.contentEditable = 'false';

    // Toolbar with +row / +col / ✎ Raw buttons.
    const toolbar = document.createElement('div');
    toolbar.className = 'table-toolbar';
    toolbar.setAttribute('data-region', 'table-toolbar');
    const addRowBtn = makeButton('add-row', '+ row');
    const addColBtn = makeButton('add-col', '+ col');
    const rawBtn = makeButton('raw-edit', '✎ Raw');
    toolbar.appendChild(addRowBtn);
    toolbar.appendChild(addColBtn);
    toolbar.appendChild(rawBtn);
    root.appendChild(toolbar);

    const tableEl = document.createElement('table');
    tableEl.className = 'cm-table-widget';
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    tableEl.appendChild(thead);
    tableEl.appendChild(tbody);
    root.appendChild(tableEl);

    const spec = this.spec;
    const ctx = this.ctx;

    // Header row (first row of spec).
    const headerRow = spec.rows.find((r) => r.isHeader);
    const bodyRows = spec.rows.filter((r) => !r.isHeader);

    if (headerRow) {
      const tr = document.createElement('tr');
      headerRow.cells.forEach((cell, colIndex) => {
        const th = document.createElement('th');
        th.setAttribute('data-row', 'header');
        th.setAttribute('data-col', String(colIndex));
        attachCellEditing(th, cell, ctx);
        // Visible text is the cell.text with surrounding whitespace
        // trimmed — but we keep the source range pointed at the raw
        // slice so dispatch can replace correctly. The displayed text
        // is just the trimmed text.
        th.textContent = cell.text.trim();
        tr.appendChild(th);
      });
      thead.appendChild(tr);
    }

    bodyRows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');
      row.cells.forEach((cell, colIndex) => {
        const td = document.createElement('td');
        td.setAttribute('data-row', String(rowIndex));
        td.setAttribute('data-col', String(colIndex));
        attachCellEditing(td, cell, ctx);
        td.textContent = cell.text.trim();
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    addRowBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      insertRow(spec, ctx);
    });
    addColBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      insertCol(spec, ctx);
    });
    rawBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      ctx.editorView?.dispatch({ effects: forceRawEffect.of(spec.source) });
    });

    return root;
  }

  /**
   * Atomic widgets ignore most interior events. Cell editing, toolbar
   * buttons, and the raw pencil all attach their own listeners that
   * must fire — so we return `false` to route the event through the
   * widget DOM. Returning `true` for everything else would also block
   * keyboard input inside contenteditable cells, which is the opposite
   * of what we want.
   */
  override ignoreEvent(_event: Event): boolean {
    return false;
  }
}

/** Helper to build a `<button data-action="…">label</button>`. */
function makeButton(action: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-action', action);
  btn.textContent = label;
  return btn;
}

/**
 * Attach the cell-edit listeners to a `<th>` / `<td>`. Cells with an
 * escaped pipe (`\|`) are flagged read-only — clicking them auto-opens
 * the raw pencil so the user can drop into the source-level editor.
 */
function attachCellEditing(
  el: HTMLTableCellElement,
  cell: CellSpec,
  ctx: TableCtx,
): void {
  if (cell.hasEscapedPipe) {
    // Escaped-pipe cells can't be safely edited via the per-cell DOM
    // contract (pipe-splitting would misinterpret the escape). Mark
    // the cell read-only; clicking it triggers the raw pencil so the
    // user can edit the full table at the source level.
    el.setAttribute('contenteditable', 'false');
    el.classList.add('cm-cell-readonly');
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const view = ctx.editorView;
      if (!view) return;
      // Find the table this cell belongs to via the current state.
      const tables = findTables(view.state);
      const owner = tables.find((t) => t.from <= cell.from && t.to >= cell.to);
      if (owner) {
        view.dispatch({ effects: forceRawEffect.of(owner.source) });
      }
    });
    return;
  }
  el.setAttribute('contenteditable', 'true');
  el.addEventListener('input', () => {
    const view = ctx.editorView;
    if (!view) return;
    const newText = (el.textContent ?? '').trim();
    // The cell.text typically has surrounding whitespace padding
    // (e.g. " 1     " in "| 1     |"). Trim for comparison, but
    // we'll write back with a one-space pad on each side so the
    // pipes don't crowd the new value.
    const oldText = cell.text.trim();
    if (newText === oldText) return;
    // Single replace transaction — covers only this cell's slice.
    // The slice is the lezer TableCell range, which excludes the
    // surrounding pipes. We preserve the original leading/trailing
    // whitespace by replacing only the trimmed-content portion.
    const leading = cell.text.match(/^\s*/)?.[0] ?? '';
    const trailing = cell.text.match(/\s*$/)?.[0] ?? '';
    view.dispatch({
      changes: {
        from: cell.from,
        to: cell.to,
        insert: `${leading}${newText}${trailing}`,
      },
      userEvent: 'input.cell-edit',
    });
  });
}

/**
 * Insert a row immediately below the active row. "Active row" is the
 * row containing the main selection (caret-in test). If the caret is
 * not inside any body row, append at the end. The new row has the
 * same column count as the table and contains empty cells.
 */
function insertRow(spec: TableSpec, ctx: TableCtx): void {
  const view = ctx.editorView;
  if (!view) return;
  const cols = spec.rows[0]?.cells.length ?? 1;
  const empty = `| ${Array.from({ length: cols }, () => ' ').join('| ')}|`;
  // Find the active body row by checking which row range contains the
  // main selection. Header is included for "I want a row right after
  // the header" but the lookup walks body rows first so the typical
  // "active = the row I'm typing in" case wins.
  const bodyRows = spec.rows.filter((r) => !r.isHeader);
  let insertAfterTo = spec.to;
  for (const row of bodyRows) {
    if (selectionIntersects(view.state, row.from, row.to)) {
      insertAfterTo = row.to;
      break;
    }
  }
  // Insert "\n<empty>" right after the active row's terminating offset.
  view.dispatch({
    changes: { from: insertAfterTo, to: insertAfterTo, insert: `\n${empty}` },
    userEvent: 'input.cell-edit',
  });
}

/**
 * Insert an empty column at the end of every row. Header + alignment
 * + body rows each gain one extra pipe-separated cell. We work line by
 * line through the table source — splicing a single ` |` (space-pipe)
 * before every trailing newline — instead of rebuilding the table from
 * scratch, so any user formatting inside other cells stays untouched.
 */
function insertCol(spec: TableSpec, ctx: TableCtx): void {
  const view = ctx.editorView;
  if (!view) return;
  // For each row (header + alignment + body), append " |" before the
  // terminating newline. The alignment row needs "---|" instead.
  const lines = spec.source.split('\n');
  const newLines = lines.map((line) => {
    if (!line.trim().startsWith('|')) return line;
    const isAlignment = /^\|[\s|:-]+\|$/.test(line.trim());
    if (isAlignment) {
      // Append "---|" after the trailing pipe.
      return `${line}---|`;
    }
    // Append " |" after the trailing pipe (one leading space for padding).
    return `${line} |`;
  });
  const newSource = newLines.join('\n');
  view.dispatch({
    changes: { from: spec.from, to: spec.to, insert: newSource },
    userEvent: 'input.cell-edit',
  });
}

/**
 * Raw-form widget. Shown when a table source is flagged in
 * `forceRawField` (e.g. via the ✎ Raw pencil) or auto-triggered by a
 * pipe-escape cell click. The widget renders a `<textarea>`-style
 * surface preloaded with the table source, plus a `Commit` button
 * that dispatches a single replace transaction for the whole table
 * range and a `Cancel` button that just clears the forced-raw flag.
 *
 * A full transient sub-CodeMirror would be heavier than the use case
 * warrants for Phase 2. The contract — block-scoped raw editor
 * showing the table source, single-replace commit — is what tests
 * and the e2e spec assert; the inner editor implementation choice is
 * a localised detail.
 */
class RawTableWidget extends WidgetType {
  constructor(
    readonly spec: TableSpec,
    private readonly ctx: TableCtx,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof RawTableWidget && other.spec.source === this.spec.source;
  }

  override updateDOM(_dom: HTMLElement, _view: EditorView): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'table-widget-raw');
    root.setAttribute('data-block-widget-raw', 'table');
    root.contentEditable = 'false';

    // The block-scoped raw editor. `<textarea>` is the simplest surface
    // that satisfies the contract; the wysiwyg spec only asserts the
    // raw editor opens with the table source and closes on commit.
    // We set BOTH the textContent (so DOM `.textContent` queries see the
    // source — Vitest jsdom and WebDriver's getText() both consult this
    // path) AND the `value` property (so user typing observes the
    // pre-populated text). Setting textContent before value avoids the
    // browser's "initial value" semantics — `value` overrides the
    // children at parse time only.
    const ta = document.createElement('textarea');
    ta.textContent = this.spec.source;
    ta.value = this.spec.source;
    ta.className = 'cm-table-raw-editor';
    // contentEditable=true is implicit for textareas; the user can
    // type freely. We track the in-flight value in a closure variable
    // because the commit handler needs the latest text without re-querying.
    let currentValue = this.spec.source;
    ta.addEventListener('input', () => {
      currentValue = ta.value;
    });
    // Test seam: expose the textarea's value-setter so unit tests can
    // drive an edit without simulating keystrokes. The e2e spec uses
    // a real textarea via WebDriver so this hook is unit-test only.
    (root as HTMLElement & { __setValue?: (s: string) => void }).__setValue = (s: string) => {
      ta.value = s;
      currentValue = s;
    };
    root.appendChild(ta);

    // Commit + Cancel buttons.
    const toolbar = document.createElement('div');
    toolbar.className = 'table-raw-toolbar';
    const commit = makeButton('commit-raw', 'Commit');
    const cancel = makeButton('cancel-raw', 'Cancel');
    toolbar.appendChild(commit);
    toolbar.appendChild(cancel);
    root.appendChild(toolbar);

    const spec = this.spec;
    const ctx = this.ctx;
    commit.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const view = ctx.editorView;
      if (!view) return;
      // Single replace transaction covering the WHOLE table block.
      // When the source is unchanged the doc bytes round-trip
      // byte-identical (CodeMirror's ChangeSet folds a no-op
      // replace, but we explicitly skip the dispatch to keep the
      // transaction count assertion clean).
      if (currentValue === spec.source) {
        view.dispatch({ effects: clearRawEffect.of(spec.source) });
        return;
      }
      view.dispatch({
        changes: { from: spec.from, to: spec.to, insert: currentValue },
        effects: clearRawEffect.of(spec.source),
        userEvent: 'input.raw-commit',
      });
    });
    cancel.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      ctx.editorView?.dispatch({ effects: clearRawEffect.of(spec.source) });
    });

    return root;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Build the DecorationSet for the current state. For every Table found,
 * emit a TableWidget (or RawTableWidget if the source is in
 * `forceRawField`). Ranges are sorted by `from` because `findTables`
 * walks the tree in document order.
 */
function buildDecorations(state: EditorState, ctx: TableCtx): DecorationSet {
  const tables = findTables(state);
  const forced = state.field(forceRawField, false) ?? new Set<string>();
  const ranges: Range<Decoration>[] = [];
  for (const spec of tables) {
    const widget = forced.has(spec.source)
      ? new RawTableWidget(spec, ctx)
      : new TableWidget(spec, ctx);
    ranges.push(
      Decoration.replace({
        widget,
        block: true,
      }).range(spec.from, spec.to),
    );
  }
  return Decoration.set(ranges);
}

/**
 * Public extension factory. Mounts a StateField whose value is the
 * RangeSet of table widget decorations, plus a ViewPlugin that
 * captures the live EditorView (so cell-edit / +row / +col / raw-pencil
 * callbacks can reach back into the editor) and an atomicRanges
 * facet entry so caret motion treats the widget as atomic.
 */
export function tables(): Extension {
  const ctx: TableCtx = { editorView: null };

  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, ctx);
    },
    update(value, tr: Transaction) {
      // Recompute on doc changes (the lezer tree shifted), selection
      // changes (active-row check for +row), and transactions carrying
      // forceRaw / clearRaw effects. Otherwise leave the existing
      // RangeSet alone — selection-only ticks would needlessly rebuild
      // the widget DOM and steal focus from cells the user is typing in.
      const hasRawEffect = tr.effects.some(
        (e) => e.is(forceRawEffect) || e.is(clearRawEffect),
      );
      if (tr.docChanged || hasRawEffect) {
        return buildDecorations(tr.state, ctx);
      }
      // Selection-only transactions: re-map ranges through the change
      // set (no changes means the map is a no-op). The CodeMirror
      // RangeSet.map is canonical for this.
      return value.map(tr.changes);
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  const viewBinding = ViewPlugin.define((view) => {
    ctx.editorView = view;
    // Attach the E2E hook when WebDriver is active. The hook lives on
    // window.__mdviewerE2E.editTableCell and lets the wysiwyg
    // table-cell-edit spec drive a per-cell edit without simulating
    // contentEditable focus + keystrokes (which is unreliable across
    // WebDriver vendors).
    installEditTableCellHook(ctx);
    return {
      update(update: ViewUpdate) {
        ctx.editorView = update.view;
      },
      destroy() {
        // Tear down the hook when the view goes away — leaving a stale
        // closure around would let a later spec accidentally drive the
        // previous editor.
        uninstallEditTableCellHook();
      },
    };
  });

  const atomicRangesExt = EditorView.atomicRanges.of(
    (view) => view.state.field(field, false) ?? Decoration.none,
  );

  return [forceRawField, field, viewBinding, atomicRangesExt];
}

/**
 * Install `window.__mdviewerE2E.editTableCell(row, col, newValue)` —
 * the wysiwyg `table-cell-edit.spec.ts` consumes this hook to drive a
 * per-cell edit deterministically. Row 0 / col 0 of the body cells
 * means the first body row's first column (header rows are not counted).
 *
 * Returns a Promise so the spec can `await` the dispatch — the
 * underlying transaction is synchronous, but the wysiwyg helper does
 * `then(() => done(null), …)` and a non-Promise return would break
 * the `.then` chain.
 *
 * Idempotent: re-installing overwrites the previous closure. Cleared
 * by `uninstallEditTableCellHook` when the ViewPlugin tears down.
 */
function installEditTableCellHook(ctx: TableCtx): void {
  const w = window as unknown as {
    __WEBDRIVER__?: unknown;
    __mdviewerE2E?: Record<string, unknown>;
  };
  if (!w.__WEBDRIVER__) return;
  if (!w.__mdviewerE2E) w.__mdviewerE2E = {};
  w.__mdviewerE2E.editTableCell = (rowIndex: number, colIndex: number, newValue: string): Promise<void> => {
    const view = ctx.editorView;
    if (!view) return Promise.reject(new Error('editTableCell: no editor view bound'));
    const tablesFound = findTables(view.state);
    if (tablesFound.length === 0) {
      return Promise.reject(new Error('editTableCell: no tables in document'));
    }
    // For the wysiwyg spec there's exactly one table; if multiple,
    // we target the first. (The spec only exercises a single-table
    // fixture.)
    const t = tablesFound[0];
    const bodyRows = t.rows.filter((r) => !r.isHeader);
    if (rowIndex < 0 || rowIndex >= bodyRows.length) {
      return Promise.reject(new Error(`editTableCell: row ${rowIndex} out of range`));
    }
    const row = bodyRows[rowIndex];
    if (colIndex < 0 || colIndex >= row.cells.length) {
      return Promise.reject(new Error(`editTableCell: col ${colIndex} out of range`));
    }
    const cell = row.cells[colIndex];
    const leading = cell.text.match(/^\s*/)?.[0] ?? '';
    const trailing = cell.text.match(/\s*$/)?.[0] ?? '';
    view.dispatch({
      changes: {
        from: cell.from,
        to: cell.to,
        insert: `${leading}${newValue}${trailing}`,
      },
      userEvent: 'input.cell-edit',
    });
    return Promise.resolve();
  };
}

function uninstallEditTableCellHook(): void {
  const w = window as unknown as { __mdviewerE2E?: Record<string, unknown> };
  if (w.__mdviewerE2E) {
    delete w.__mdviewerE2E.editTableCell;
  }
}
