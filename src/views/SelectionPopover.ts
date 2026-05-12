import type { EditorView } from '@codemirror/view';
import type { Ipc } from '../ipc';

/**
 * Length of the source-context window (prefix / suffix) carried in the
 * anchor payload. Matches the Bitap-disambiguation contract used by
 * `mdviewer-core::resolve_anchor` — change this here only in lock-step
 * with the Rust side.
 */
const CONTEXT_LEN = 32;

/**
 * Anchor payload shape consumed by `ipc.createThread`. Identical to the
 * old DOM-Range-derived shape; only the selection SOURCE changes.
 */
interface AnchorPayload {
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

/**
 * Read the current CodeMirror selection and build the anchor payload.
 * Returns null when the selection is collapsed (`from === to`) — the
 * caller treats that as "no popover".
 *
 * `prefix` and `suffix` are up to 32 chars of source context pulled
 * via `view.state.doc.sliceString` so the Rust-side resolver can
 * disambiguate when `exact` appears multiple times in the doc.
 */
function offsetsFromCmSelection(view: EditorView): AnchorPayload | null {
  const { from, to } = view.state.selection.main;
  if (from === to) return null;
  const doc = view.state.doc;
  return {
    start: from,
    end: to,
    exact: doc.sliceString(from, to),
    prefix: doc.sliceString(Math.max(0, from - CONTEXT_LEN), from),
    suffix: doc.sliceString(to, Math.min(doc.length, to + CONTEXT_LEN)),
  };
}

/**
 * Attach the selection popover (wireframe 04) to a CodeMirror
 * `EditorView`. After A.4 the live editor IS CodeMirror, so the
 * popover reads its selection from `view.state.selection.main`
 * rather than walking DOM Range over data-src-offset carriers.
 *
 * Output shape is identical to the old API:
 *   { start, end, exact, prefix, suffix }
 * which preserves the Bitap-disambiguation contract on the Rust side.
 *
 * Two-stage flow (unchanged from the DOM-Range version):
 *   stage 1: [Comment] [Copy] — clicking Comment swaps the popover
 *     into a body composer (textarea + Post + Cancel).
 *   stage 2: typing into the textarea + clicking Post calls
 *     `ipc.createThread(tabId, anchor, body)` and dispatches a
 *     `thread-created` CustomEvent on `view.dom` so the parent can
 *     refresh sidebar / highlights.
 *
 * Returns a teardown function that removes the mouseup listener and
 * any open popover; A.9 calls it when the editor is destroyed.
 */
export function attachSelectionPopover(
  view: EditorView,
  ipc: Ipc,
  getTabId: () => string,
): () => void {
  let popover: HTMLElement | null = null;
  // The composer (stage 2: textarea + Post + Cancel) intentionally
  // outlives a collapsed selection — the user clicks Post / Cancel
  // explicitly. Without this guard, focusing the textarea would
  // collapse the CodeMirror selection (selectionchange fires) and
  // immediately tear the composer down before the user can type.
  let composerOpen = false;

  const removePopover = (): void => {
    popover?.remove();
    popover = null;
    composerOpen = false;
  };

  // Close the popover as soon as the user clears the selection in the
  // editor. The `selectionchange` event fires for both DOM-level and
  // CodeMirror-level selection changes; we re-check the editor's own
  // selection state so caret motion (collapsed selection) tears the
  // popover down while leaving the composer alone if it's open.
  const onSelectionChange = (): void => {
    if (composerOpen) return; // user is mid-comment; don't yank the textarea
    if (!popover) return;
    const { from, to } = view.state.selection.main;
    if (from === to) removePopover();
  };
  document.addEventListener('selectionchange', onSelectionChange);

  const onMouseUp = (): void => {
    const captured = offsetsFromCmSelection(view);
    if (!captured) {
      removePopover();
      return;
    }

    // Anchor the popover at the selection's start coords. `coordsAtPos`
    // can return null when the editor has no layout, and in jsdom (unit
    // tests) it throws because `Range.getClientRects` is not implemented.
    // Fall back to a zeroed rect on either branch so the popover still
    // mounts deterministically rather than crashing — production WebView
    // always returns a real rect.
    let rect: { top: number; left: number } = { top: 0, left: 0 };
    try {
      const coords = view.coordsAtPos(captured.start);
      if (coords) rect = { top: coords.top, left: coords.left };
    } catch {
      // jsdom-only path — leave the zeroed rect.
    }

    removePopover();
    popover = document.createElement('div');
    popover.setAttribute('data-view', 'selection-popover');
    popover.style.position = 'fixed';
    popover.style.top = `${rect.top - 36}px`;
    popover.style.left = `${rect.left}px`;

    const comment = document.createElement('button');
    comment.setAttribute('data-action', 'comment');
    comment.textContent = 'Comment';
    comment.addEventListener('click', () => {
      // Stage 2: replace popover contents with a body composer. Use
      // replaceChildren() not innerHTML='' to keep the no-innerHTML rule.
      popover!.replaceChildren();
      popover!.classList.add('composer');
      // Set BEFORE focus(): focusing the textarea collapses the
      // selection synchronously, which fires selectionchange — without
      // the flag set, the listener above would tear the composer down
      // before the user can type a single character.
      composerOpen = true;
      const ta = document.createElement('textarea');
      ta.setAttribute('data-test', 'comment-body');
      ta.placeholder = 'Comment on selection…';
      const post = document.createElement('button');
      post.setAttribute('data-action', 'post-comment');
      post.textContent = 'Post';
      post.addEventListener('click', async () => {
        const thread = await ipc.createThread(
          getTabId(),
          {
            start: captured.start,
            end: captured.end,
            exact: captured.exact,
            prefix: captured.prefix,
            suffix: captured.suffix,
          },
          ta.value,
        );
        view.dom.dispatchEvent(
          new CustomEvent('thread-created', { bubbles: true, detail: { thread } }),
        );
        removePopover();
      });
      const cancel = document.createElement('button');
      cancel.setAttribute('data-action', 'cancel-comment');
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => removePopover());
      popover!.append(ta, post, cancel);
      ta.focus();
    });

    const copy = document.createElement('button');
    copy.setAttribute('data-action', 'copy');
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      // Copy from the CodeMirror state, not `window.getSelection()` —
      // the latter is unreliable under CodeMirror's contentDOM (which
      // may be using its own selection draw layer).
      void navigator.clipboard.writeText(captured.exact);
    });

    popover.append(comment, copy);
    document.body.appendChild(popover);
  };

  // Scope mouseup to the editor's content DOM (NOT `document`) so
  // selecting text in Settings, the sidebar, or any other surface
  // never raises a comment popover.
  view.contentDOM.addEventListener('mouseup', onMouseUp);

  return (): void => {
    document.removeEventListener('selectionchange', onSelectionChange);
    view.contentDOM.removeEventListener('mouseup', onMouseUp);
    removePopover();
  };
}
