import {
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

import type { Thread } from '../../types-generated';

/**
 * Effect that replaces the comment-highlight decoration set with one
 * derived from a fresh `Thread[]` snapshot. Document.ts (A.9) and
 * LiveEditor's post-save re-anchor pump (A.4 → A.7 wiring) dispatch
 * this whenever the authoritative anchor list changes: initial mount,
 * post-save re-anchor, comment thread create / resolve / delete.
 *
 * Payload shape: a plain readonly array snapshot. The extension reads
 * `thread.id` and `thread.anchor.{start,end}` only — it doesn't store
 * the array, so callers can pass throwaway slices.
 */
export const refreshAnchors = StateEffect.define<readonly Thread[]>();

/**
 * Internal shape of `commentHighlightsField`. `active` is the
 * DecorationSet of mark decorations that the editor view renders;
 * `drifting` carries thread IDs whose anchor range collapsed to zero
 * length between saves.
 *
 * Drifting threads are state-only — they have no DOM presence,
 * because CodeMirror's `Decoration.mark` does not emit a wrapper for
 * a zero-length range (no text to wrap around). We track the drifting
 * IDs separately so the next save's `refreshAnchors` dispatch can
 * either reinstate (if `resolve_anchor` returned `resolved`) or drop
 * (if `orphan`).
 *
 * The CSS rule `mark.cm-comment-anchor.is-drifting { display: none }`
 * in `comment-highlights.css` is defensive — it covers the
 * theoretical case where a future CodeMirror version paints a
 * zero-width wrapper for empty marks.
 */
export interface CommentHighlightsValue {
  /** Visible, non-drifting decorations. Wired into EditorView.decorations. */
  readonly active: DecorationSet;
  /** Thread IDs whose anchor has drifted to a zero-length range. */
  readonly drifting: ReadonlySet<string>;
}

const EMPTY: CommentHighlightsValue = {
  active: Decoration.none,
  drifting: new Set<string>(),
};

/**
 * Build the "normal" Decoration.mark for an anchor. The `tagName`
 * override is LOAD-BEARING: CodeMirror's `Decoration.mark` defaults to
 * `<span>`, and the e2e selector `mark[data-anchor]` from
 * `comment-from-selection.spec.ts` will not match a span. Don't drop
 * the override.
 */
function normalMark(threadId: string): Decoration {
  return Decoration.mark({
    tagName: 'mark',
    class: 'cm-comment-anchor',
    attributes: { 'data-anchor': threadId },
  });
}

/**
 * Build a fresh state value from a thread snapshot. Threads with
 * zero-length anchors are skipped — the caller should not be sending
 * those (re-anchor classifies them as orphan), but be defensive.
 *
 * This path always returns an EMPTY drifting set: a fresh
 * refreshAnchors clears all prior drift state. That is the design —
 * the post-save re-anchor outcome (resolved or orphan) is the only
 * authoritative source for whether a thread is currently tracked.
 */
function buildFromThreads(threads: readonly Thread[]): CommentHighlightsValue {
  const ranges: Range<Decoration>[] = [];
  for (const thread of threads) {
    // Resolved threads are sidebar-only: the user is done with them.
    // The `<mark>` highlight is reserved for ACTIVE comment threads. The
    // sidebar's `comments.show_resolved` setting governs whether
    // resolved threads remain visible in the sidebar list, but the
    // editor surface always hides them. Without this filter every
    // thread keeps painting a yellow mark forever — see the 2026-05-14
    // bug report (resolved threads still highlighted on screenshot).
    if (thread.resolved) continue;
    const { start, end } = thread.anchor;
    if (end <= start) continue;
    ranges.push(normalMark(thread.id).range(start, end));
  }
  // Decoration.set with sort=true tolerates the caller passing
  // threads in any order (sidebar order, creation order, whatever).
  return {
    active: Decoration.set(ranges, true),
    drifting: new Set<string>(),
  };
}

/**
 * Walk a DecorationSet, returning the set of thread IDs it contains.
 * Used to detect which threads disappear after mapping through a
 * transaction's changes (the diff of before / after).
 */
function indexThreadIds(set: DecorationSet): Set<string> {
  const ids = new Set<string>();
  const cursor = set.iter();
  while (cursor.value) {
    const id = (cursor.value.spec as { attributes?: Record<string, string> })
      .attributes?.['data-anchor'];
    if (typeof id === 'string') ids.add(id);
    cursor.next();
  }
  return ids;
}

/**
 * Map an existing value through a transaction's change set. Any
 * thread whose mark disappears post-map (zero-length-collapse drops
 * it from the RangeSet, per CodeMirror's rule that empty mark ranges
 * are meaningless) joins the drifting set. Threads that were already
 * drifting stay drifting — only refreshAnchors can clear that flag.
 */
function mapThroughChanges(
  value: CommentHighlightsValue,
  changes: Parameters<DecorationSet['map']>[0],
): CommentHighlightsValue {
  const idsBefore = indexThreadIds(value.active);
  const mapped = value.active.map(changes);
  const idsAfter = indexThreadIds(mapped);
  // Compute IDs that disappeared during mapping. CodeMirror drops a
  // mark range whose mapped extent becomes zero-length (per
  // RangeValue's "regular ranges are meaningless when empty"), so the
  // difference set IS the freshly-drifted population.
  const newlyDrifting = new Set(value.drifting);
  for (const id of idsBefore) {
    if (!idsAfter.has(id)) newlyDrifting.add(id);
  }
  return { active: mapped, drifting: newlyDrifting };
}

/**
 * StateField storing the comment-highlight value. The field is
 * provided to the editor's `decorations` facet via the standard
 * `from(field, get)` selector hook so only the `active` set drives
 * the view layer; the `drifting` set is internal state consumed by
 * the next refreshAnchors dispatch.
 *
 * Exported so callers and tests can read the current state via
 * `state.field(commentHighlightsField)` — necessary for tests because
 * drifting marks have no DOM presence and the drift contract is only
 * observable through the field.
 */
export const commentHighlightsField = StateField.define<CommentHighlightsValue>({
  create: () => EMPTY,
  update: (value, tr) => {
    // refreshAnchors trumps mapping: a fresh thread snapshot REBUILDS
    // the state from scratch. This is the only path that can clear
    // the drifting set (Phase-1 re-anchor reinstates if
    // `resolve_anchor` returned `resolved`, and drops the thread
    // entirely if `orphan`).
    for (const effect of tr.effects) {
      if (effect.is(refreshAnchors)) {
        return buildFromThreads(effect.value);
      }
    }
    if (!tr.docChanged) return value;
    // Map through the change set (default RangeSet.map behavior — no
    // override needed; CodeMirror's range mapping is exactly what we
    // want for inline marks under user edits) and capture any newly
    // drifted thread IDs.
    return mapThroughChanges(value, tr.changes);
  },
  provide: (field) =>
    EditorView.decorations.from(field, (v) => v.active),
});

/**
 * The CodeMirror extension. Mount this in LiveEditor's extension list
 * (A.9 wires it from Document.ts) and dispatch `refreshAnchors` to
 * paint. Without an initial dispatch, the editor shows no anchors.
 */
export function commentHighlights(): Extension {
  return [commentHighlightsField];
}
