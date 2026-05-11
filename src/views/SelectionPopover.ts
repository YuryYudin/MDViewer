import type { Ipc } from '../ipc';

/**
 * Attach the selection popover (wireframe 04) to the document root. The
 * `mouseup` listener is scoped to `documentRoot` rather than `document` so
 * selecting text in Settings or the sidebar never raises a comment popover.
 *
 * Two-stage flow:
 *   stage 1: [Comment] [Copy] — clicking Comment swaps the popover into a
 *     body composer (textarea + Post + Cancel).
 *   stage 2: typing into the textarea + clicking Post calls
 *     `ipc.createThread(tabId, anchor, body)` and dispatches a
 *     `thread-created` event so the parent can refresh sidebar / highlights.
 */
export function attachSelectionPopover(
  documentRoot: HTMLElement,
  ipc: Ipc,
  getTabId: () => string,
  getOffsets: () => {
    start: number;
    end: number;
    exact: string;
    prefix?: string;
    suffix?: string;
  } | null,
): void {
  let popover: HTMLElement | null = null;
  // The composer (stage 2: textarea + Post + Cancel) intentionally
  // outlives a collapsed selection — the user clicks Post / Cancel
  // explicitly. Without this guard, focusing the textarea would clear
  // the selection and immediately tear the composer down, making it
  // impossible to type a comment.
  let composerOpen = false;

  const removePopover = (): void => {
    popover?.remove();
    popover = null;
    composerOpen = false;
  };

  // Close the popover as soon as the user clears the selection ANYWHERE
  // — clicking in the sidebar, the toolbar, or even inside the document
  // outside the highlighted range. Without this listener, the popover
  // only updated on mouseup inside documentRoot, so a click in the
  // sidebar left a stale floating button cluster behind.
  document.addEventListener('selectionchange', () => {
    if (composerOpen) return; // user is mid-comment; don't yank the textarea
    if (!popover) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      removePopover();
    }
  });

  documentRoot.addEventListener('mouseup', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      removePopover();
      return;
    }
    if (!documentRoot.contains(sel.anchorNode)) return;
    // jsdom (used in unit tests) does not implement Range.getBoundingClientRect;
    // fall back to a zeroed rect so the popover still anchors deterministically.
    // The production WebView always returns a real rect.
    const range = sel.getRangeAt(0);
    const rect: { top: number; left: number } =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : { top: 0, left: 0 };

    // Capture offsets BEFORE the popover opens. Clicking the button
    // (next mousedown) collapses the native selection, so getOffsets()
    // would return null if we waited until the click handler ran.
    const capturedOffsets = getOffsets();

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
      const offsets = capturedOffsets ?? getOffsets();
      if (!offsets) return;
      // Stage 2: replace popover contents with a body composer. Use
      // replaceChildren() not innerHTML='' to keep the no-innerHTML rule.
      popover!.replaceChildren();
      popover!.classList.add('composer');
      // Set BEFORE focus(): focusing the textarea collapses the selection
      // synchronously, which fires selectionchange — without the flag set,
      // the listener above would tear the composer down before the user
      // can type a single character.
      composerOpen = true;
      const ta = document.createElement('textarea');
      ta.setAttribute('data-test', 'comment-body');
      ta.placeholder = 'Comment on selection…';
      const post = document.createElement('button');
      post.setAttribute('data-action', 'post-comment');
      post.textContent = 'Post';
      post.addEventListener('click', async () => {
        // Use the prefix/suffix captured from the source by Document's
        // offsetsFromSelection — these carry up-to-32 chars of context that
        // the Rust-side resolver uses to disambiguate when `exact` appears
        // more than once in the document. Falls back to empty strings for
        // the legacy test path that doesn't supply them.
        const thread = await ipc.createThread(
          getTabId(),
          {
            start: offsets.start,
            end: offsets.end,
            exact: offsets.exact,
            prefix: offsets.prefix ?? '',
            suffix: offsets.suffix ?? '',
          },
          ta.value,
        );
        documentRoot.dispatchEvent(
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
      void navigator.clipboard.writeText(sel.toString());
    });

    popover.append(comment, copy);
    document.body.appendChild(popover);
  });
}
