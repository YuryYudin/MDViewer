import { describe, it, expect, afterEach } from 'vitest';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import {
  commentHighlights,
  commentHighlightsField,
  refreshAnchors,
} from '../../../src/views/decorations/commentHighlights';
import type { Thread, ResolveOutcome } from '../../../src/types-generated';

/**
 * Read the comment-highlight tracked anchors out of the StateField
 * as a flat list. CodeMirror's `Decoration.mark` does not emit a DOM
 * element for a zero-length range (no text to wrap) AND drops empty
 * mark ranges from the set, so the drift-state assertions must
 * inspect the StateField directly — that is the authoritative source
 * for whether a thread's anchor is currently tracked, drifting, or
 * absent.
 */
interface MarkProbe {
  from: number;
  to: number;
  threadId: string;
  isDrifting: boolean;
}

function probeMarks(view: EditorView): MarkProbe[] {
  const value = view.state.field(commentHighlightsField);
  const probes: MarkProbe[] = [];
  const cursor = value.active.iter();
  while (cursor.value) {
    const spec = cursor.value.spec as {
      attributes?: Record<string, string>;
    };
    const id = spec.attributes?.['data-anchor'];
    if (typeof id === 'string') {
      probes.push({
        from: cursor.from,
        to: cursor.to,
        threadId: id,
        isDrifting: false,
      });
    }
    cursor.next();
  }
  for (const id of value.drifting) {
    probes.push({ from: -1, to: -1, threadId: id, isDrifting: true });
  }
  return probes;
}

/**
 * Build a Thread with the minimal shape commentHighlights cares about.
 * The decoration extension only reads `id` and `anchor.{start,end}`.
 */
function makeThread(id: string, start: number, end: number, exact = ''): Thread {
  return {
    id,
    anchor: { start, end, exact, prefix: '', suffix: '' },
    comments: [],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
  };
}

function mount(source: string, extensions: Extension[] = []): EditorView {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const state = EditorState.create({
    doc: source,
    extensions: [commentHighlights(), ...extensions],
  });
  return new EditorView({ state, parent: root });
}

function anchorMarks(view: EditorView): HTMLElement[] {
  return Array.from(
    view.dom.querySelectorAll<HTMLElement>('mark.cm-comment-anchor'),
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('commentHighlights', () => {
  it('paints a <mark> per thread on refreshAnchors with class and data-anchor attribute', () => {
    const view = mount('hello world');
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t1', 0, 5, 'hello')]),
    });

    const marks = anchorMarks(view);
    expect(marks).toHaveLength(1);
    const [mark] = marks;
    // Load-bearing: e2e selector mark[data-anchor] from
    // comment-from-selection.spec.ts requires the tagName to be MARK,
    // not the CodeMirror default of SPAN.
    expect(mark.tagName).toBe('MARK');
    expect(mark.classList.contains('cm-comment-anchor')).toBe(true);
    expect(mark.getAttribute('data-anchor')).toBe('t1');
    expect(mark.classList.contains('is-drifting')).toBe(false);
    expect(mark.textContent).toBe('hello');

    view.destroy();
  });

  it('starts with no decorations before refreshAnchors fires', () => {
    const view = mount('hello world');
    expect(anchorMarks(view)).toHaveLength(0);
    view.destroy();
  });

  it('keeps an anchor range valid when an edit is adjacent to (not inside) the range', () => {
    // Doc: "hello world"   thread covers offsets 6..11 ("world").
    // Insert "AB" at offset 0 -> doc "ABhello world"; thread should
    // now cover 8..13 thanks to RangeSet.map.
    const view = mount('hello world');
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t1', 6, 11, 'world')]),
    });
    view.dispatch({ changes: { from: 0, insert: 'AB' } });

    const marks = anchorMarks(view);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('world');
    expect(marks[0].classList.contains('is-drifting')).toBe(false);

    view.destroy();
  });

  it('marks an anchor is-drifting when its entire anchored phrase is deleted', () => {
    // Doc: "hello world". Anchor 0..5 ("hello"). Delete 0..5 -> the
    // mapped range becomes zero-length; the mark must gain
    // is-drifting and remain in the set (so the next save's
    // refreshAnchors can reinstate or orphan it).
    //
    // We inspect the StateField directly here: CodeMirror does not
    // emit a DOM element for a zero-length mark decoration (there is
    // no text to wrap), so the drift-state contract is only
    // observable through the field. The CSS rule
    // `mark.cm-comment-anchor.is-drifting { display: none }` exists
    // as a defensive guard in case the renderer ever does paint a
    // node — and aligns with the design-doc requirement that
    // drifting marks be visually absent.
    const view = mount('hello world');
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t1', 0, 5, 'hello')]),
    });
    view.dispatch({ changes: { from: 0, to: 5, insert: '' } });

    const probes = probeMarks(view);
    expect(probes).toHaveLength(1);
    expect(probes[0].isDrifting).toBe(true);
    expect(probes[0].threadId).toBe('t1');
    expect(probes[0].from).toBe(probes[0].to);
    // DOM-side: no mark element rendered (zero-length).
    expect(anchorMarks(view)).toHaveLength(0);

    view.destroy();
  });

  it('reinstates an is-drifting mark when refreshAnchors brings new offsets after a save', () => {
    // Doc: "hello world" — thread anchored on "hello" (0..5).
    // Delete "hello " (0..6) -> doc becomes "world"; anchor collapses
    // (drifting). Save fires, re-anchor finds "hello" gone but the
    // caller's threads list still contains t1 with a new anchor
    // (e.g. simulated resolution to "world"). refreshAnchors rebuilds
    // from scratch and the drifting set clears.
    const view = mount('hello world');
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t1', 0, 5, 'hello')]),
    });
    // Delete the anchored phrase plus the trailing space -> drifting
    // (state-only; no DOM). Including the space avoids ambiguity
    // about whether the mapped range collapsed exactly.
    view.dispatch({ changes: { from: 0, to: 6, insert: '' } });
    const driftProbes = probeMarks(view);
    expect(driftProbes).toHaveLength(1);
    expect(driftProbes[0].isDrifting).toBe(true);

    // Simulate the post-save outcome: re-anchor placed the thread at
    // 0..5 of the new doc ("world"). The Phase-1 caller observes
    // this via onAnchorsResolved and dispatches a refreshAnchors with
    // the resolved thread; the decoration rebuilds from scratch and
    // the is-drifting class clears.
    const resolved: ResolveOutcome = { kind: 'resolved', start: 0, end: 5 };
    void resolved;
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t1', 0, 5, 'world')]),
    });

    const probes = probeMarks(view);
    expect(probes).toHaveLength(1);
    expect(probes[0].isDrifting).toBe(false);
    const marks = anchorMarks(view);
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('world');

    view.destroy();
  });

  it('drops a mark when the thread is missing from a subsequent refreshAnchors (orphan)', () => {
    const view = mount('hello world');
    view.dispatch({
      effects: refreshAnchors.of([
        makeThread('t1', 0, 5, 'hello'),
        makeThread('t2', 6, 11, 'world'),
      ]),
    });
    expect(anchorMarks(view)).toHaveLength(2);

    // Save fires; resolve_anchor for t1 came back orphan, so the
    // caller drops t1 from the threads list it passes to
    // refreshAnchors. Decoration must drop the corresponding mark.
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t2', 6, 11, 'world')]),
    });

    const marks = anchorMarks(view);
    expect(marks).toHaveLength(1);
    expect(marks[0].getAttribute('data-anchor')).toBe('t2');

    view.destroy();
  });

  it('renders multiple non-overlapping anchors at once', () => {
    const view = mount('alpha beta gamma');
    view.dispatch({
      effects: refreshAnchors.of([
        makeThread('a', 0, 5, 'alpha'),
        makeThread('b', 6, 10, 'beta'),
        makeThread('c', 11, 16, 'gamma'),
      ]),
    });

    const marks = anchorMarks(view);
    expect(marks).toHaveLength(3);
    const ids = marks.map((m) => m.getAttribute('data-anchor')).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
    // Every paint must be a real <mark>, not the Decoration.mark
    // default of <span>. Re-asserting per element so the e2e contract
    // can't drift in a way that affects only some anchors.
    for (const mark of marks) {
      expect(mark.tagName).toBe('MARK');
    }

    view.destroy();
  });

  it('defensively skips zero-length thread anchors on refreshAnchors', () => {
    // Callers should never send a thread with start == end (re-anchor
    // classifies those as orphan and the caller drops them), but the
    // build path is defensive: skip rather than create a degenerate
    // decoration that would throw.
    const view = mount('alpha beta');
    view.dispatch({
      effects: refreshAnchors.of([
        makeThread('zero', 3, 3, ''),
        makeThread('good', 0, 5, 'alpha'),
      ]),
    });

    const probes = probeMarks(view);
    expect(probes).toHaveLength(1);
    expect(probes[0].threadId).toBe('good');
    view.destroy();
  });

  it('ignores transactions that carry neither refreshAnchors nor doc changes', () => {
    // A pure selection-change transaction must not perturb the
    // decoration state. This protects the early-return in the
    // StateField update path.
    const view = mount('hello world');
    view.dispatch({
      effects: refreshAnchors.of([makeThread('t1', 0, 5, 'hello')]),
    });
    const before = view.state.field(commentHighlightsField);
    view.dispatch({ selection: { anchor: 2, head: 2 } });
    const after = view.state.field(commentHighlightsField);
    expect(after).toBe(before);
    view.destroy();
  });

  it('preserves out-of-order thread input (RangeSet sorts on build)', () => {
    // The Decoration.set() API requires sorted ranges OR an explicit
    // sort=true. We pass them out of order; the extension must still
    // produce a valid set.
    const view = mount('alpha beta gamma');
    view.dispatch({
      effects: refreshAnchors.of([
        makeThread('c', 11, 16, 'gamma'),
        makeThread('a', 0, 5, 'alpha'),
        makeThread('b', 6, 10, 'beta'),
      ]),
    });

    expect(anchorMarks(view)).toHaveLength(3);
    view.destroy();
  });
});
