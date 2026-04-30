import type { Ipc, SaveOutcome } from '../ipc';

/**
 * Wireframe 07: raw `.md` editor. The textarea uses `white-space: pre` (or
 * `pre-wrap` if word-wrap is on) so saved bytes match what the user typed —
 * a contenteditable would normalize whitespace and diverge. Autosave is
 * debounced *here* in the WebView rather than in Rust because the keystroke
 * stream lives in the frontend; debouncing on the Rust side would still
 * receive every keystroke event and defeat the point.
 */
export interface EditMountArgs {
  tabId: string;
  path: string;
  source: string;
  autoSave: boolean;
  autoSaveDebounceMs: number;
  wordWrap: boolean;
  showWhitespace: boolean;
}

export interface EditView {
  /** Returns the current textarea contents (post-edit, pre-save). */
  currentSource(): string;
  /** Cancel pending debounce and flush the current contents to disk. */
  forceSave(): Promise<void>;
  /** Tear down the view, canceling any pending autosave timer. */
  destroy(): void;
}

type SaveCapableIpc =
  | Ipc
  | { saveDocument(tabId: string, contents: string): Promise<SaveOutcome | void> };

export function mountEdit(
  root: HTMLElement,
  ipc: SaveCapableIpc,
  args: EditMountArgs,
): EditView {
  root.replaceChildren();

  const view = document.createElement('div');
  view.setAttribute('data-view', 'edit');

  // Toolbar with a manual Save button — wireframe 07 puts it above the
  // textarea so users have an explicit flush even when autosave is on.
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-region', 'edit-toolbar');
  const saveBtn = document.createElement('button');
  saveBtn.setAttribute('data-action', 'save');
  saveBtn.textContent = 'Save';
  toolbar.appendChild(saveBtn);
  view.appendChild(toolbar);

  const ta = document.createElement('textarea');
  ta.setAttribute('data-test', 'editor');
  ta.value = args.source;
  // pre vs pre-wrap is the entire user-facing word-wrap toggle: pre keeps a
  // single horizontal line (with horizontal scroll); pre-wrap soft-wraps at
  // the textarea boundary while preserving newlines.
  ta.style.whiteSpace = args.wordWrap ? 'pre-wrap' : 'pre';
  if (args.showWhitespace) ta.classList.add('show-whitespace');
  view.appendChild(ta);
  root.appendChild(view);

  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function flush(): Promise<void> {
    clearTimer();
    // B2: pass tabId (not path) so the dispatch can pick the right backend.
    // The returned SaveOutcome is consumed by the caller (Document.ts /
    // Workspace.ts) — Edit.ts itself only needs the resolution as a
    // fire-and-forget acknowledgement here.
    return Promise.resolve(ipc.saveDocument(args.tabId, ta.value)).then(() => undefined);
  }

  function schedule(): void {
    if (!args.autoSave) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      // Fire-and-forget; failures surface via the IPC layer's own error path.
      void ipc.saveDocument(args.tabId, ta.value);
    }, args.autoSaveDebounceMs);
  }

  ta.addEventListener('input', schedule);
  saveBtn.addEventListener('click', () => {
    void flush();
  });

  return {
    currentSource: () => ta.value,
    forceSave: flush,
    destroy: () => {
      clearTimer();
      ta.remove();
      saveBtn.remove();
      view.remove();
    },
  };
}
