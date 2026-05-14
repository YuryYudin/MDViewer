import {
  EditorState,
  StateEffect,
  StateField,
  Compartment,
  Transaction,
  type Extension,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import type { Ipc, SaveOutcome } from '../ipc';
import type { Settings, Thread, ResolveOutcome } from '../types-generated';

/**
 * Two-valued mode StateField shared by all decoration extensions
 * (the actual decoration extensions land in A.5 / A.6 / A.7 — this
 * module only stores the value and exposes it via `view.mode()`).
 */
export type LiveEditorMode = 'render' | 'raw';

/**
 * Effect that flips the mode StateField. `setMode` dispatches this;
 * the effect's payload is the new mode value. Mode toggles use a
 * StateEffect (NOT a doc change), so the autosave / dirty pathways —
 * which watch for `userEvent`-tagged transactions — stay inert.
 */
const setModeEffect = StateEffect.define<LiveEditorMode>();

/**
 * StateField holding the current mode. Initial value comes from
 * `args.initialMode` (defaults to `'render'`); mode flips are
 * processed by reading the effect off the transaction.
 */
function makeModeField(initial: LiveEditorMode): StateField<LiveEditorMode> {
  return StateField.define<LiveEditorMode>({
    create: () => initial,
    update: (value, tr) => {
      for (const eff of tr.effects) {
        if (eff.is(setModeEffect)) return eff.value;
      }
      return value;
    },
  });
}

export interface LiveEditorMountArgs {
  tabId: string;
  path: string;
  source: string;
  settings: Settings;
  threads: Thread[];
  /**
   * Optional initial mode override. Document.ts (A.9) passes this
   * based on `settings.editor.default_open_mode`. Defaults to `'render'`.
   */
  initialMode?: LiveEditorMode;
  /**
   * Fired once per thread after every successful save. Phase 1 callers
   * use this to repaint `commentHighlights` (the actual decoration
   * extension lands in A.7); this module just routes the per-thread
   * resolve_anchor outcomes back out.
   */
  onAnchorsResolved?: (threadId: string, outcome: ResolveOutcome) => void;
  /**
   * Fired EXACTLY ONCE per successful save_document, AFTER the
   * per-thread `onAnchorsResolved` pump has completed. Document.ts
   * uses this as the canonical once-per-save signal to refresh the
   * hidden render-shadow div via a single `ipc.renderMarkdown` call
   * rather than triggering one render per resolved thread. The
   * callback is invoked with the document path the editor is bound
   * to. Skipped when the view is destroyed mid-save.
   */
  onSaved?: (path: string) => void;
}

export interface LiveEditorView {
  /** Returns the current editor source contents (post-edit, pre-save). */
  currentSource(): string;
  /** Cancel pending debounce and flush the current contents to disk. */
  forceSave(): Promise<void>;
  /** Tear down the view, canceling timers and removing listeners. */
  destroy(): void;
  /** Flip the mode StateField via a StateEffect (no doc change). */
  setMode(mode: LiveEditorMode): void;
  /** Current value of the mode StateField. */
  mode(): LiveEditorMode;
  /**
   * Subscribe to mode changes. The provided listener is invoked
   * SYNCHRONOUSLY with the current mode before `subscribeMode`
   * returns (this synchronous initial fire is load-bearing —
   * Document.ts subscribes during mount and reads `data-mode` from
   * the editor host on the next microtask; a deferred initial fire
   * would race that DOM query). Subsequent invocations land after
   * each `setMode` transaction. Multiple subscribers are supported;
   * each receives the full sequence independently. Returns an
   * unsubscribe function that removes the listener.
   */
  subscribeMode(listener: (mode: LiveEditorMode) => void): () => void;
  /**
   * Internal handle exposed for tests so they can dispatch
   * transactions with `userEvent` annotations without re-implementing
   * a CodeMirror DOM-event harness. Not part of the public surface.
   */
  editorView: EditorView;
}

type SaveCapableIpc =
  | Ipc
  | {
      saveDocument(tabId: string, contents: string): Promise<SaveOutcome | void>;
      setDirty(path: string, dirty: boolean): Promise<void>;
      resolveAnchor(tabId: string, anchor: Thread['anchor']): Promise<ResolveOutcome>;
    };

const CONFLICT_OPEN_EVENT = 'mdviewer:conflict-open';
const CONFLICT_CLOSED_EVENT = 'mdviewer:conflict-closed';

/**
 * Build the editable-compartment value for the current mode. When
 * `render_readonly` is true AND mode is `'render'`, the editor is
 * read-only; raw mode is ALWAYS editable regardless of the setting,
 * because the user explicitly switched to the byte-level surface.
 */
function editableValueFor(mode: LiveEditorMode, renderReadonly: boolean): Extension[] {
  if (mode === 'render' && renderReadonly) {
    return [EditorView.editable.of(false)];
  }
  return [];
}

/**
 * Mounts a CodeMirror 6 host inside `root`. The factory shape mirrors
 * the deleted `mountEdit(...)` factory (replaced as part of the
 * WYSIWYG editing work — see design doc). A.4 ships the bare host
 * with mode/autosave/dirty/conflict/re-anchor wiring; the decoration
 * extensions land in A.5 (inline marks), A.6 (block widgets), and
 * A.7 (comment highlights).
 */
export function mountLiveEditor(
  root: HTMLElement,
  ipc: SaveCapableIpc,
  args: LiveEditorMountArgs,
): LiveEditorView {
  root.replaceChildren();

  const debounceMs = args.settings.editor.auto_save_debounce_ms;
  const renderReadonly = args.settings.editor.render_readonly;
  // B.2: editor.idle_reanchor_ms is a typed EditorSettings field that
  // ships in B.4 (the cross-phase ordering is intentional — see plan
  // task B.2 done_when). Until B.4 regenerates types-generated.ts,
  // read it through a one-line cast and default to 1500 ms.
  const idleReanchorMs =
    (args.settings.editor as unknown as { idle_reanchor_ms?: number }).idle_reanchor_ms ?? 1500;
  const initialMode: LiveEditorMode = args.initialMode ?? 'render';

  const modeField = makeModeField(initialMode);
  const editableCompartment = new Compartment();

  // Local timer / suspend state. We close over these from the update
  // listener, conflict listeners, and forceSave so all paths share
  // the same single source of truth for "is there a pending save?"
  let timer: ReturnType<typeof setTimeout> | undefined;
  // B.2 idle re-anchor timer. Separate from the autosave debounce
  // because the two cadences are independent — autosave persists the
  // doc to disk; the idle pump only refreshes anchor positions so
  // commentHighlights doesn't drift mid-edit (saves already re-anchor
  // via onAnchorsResolved, so the idle pump is suppressed while a save
  // is in flight and is cancelled when a save starts).
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let conflictPaused = false;
  let destroyed = false;
  // True from the moment `flushSave` is invoked until the post-save
  // re-anchor pump has fed every thread back through `onAnchorsResolved`.
  // The idle pump consults this flag to avoid running concurrently with
  // a save (which would issue a redundant resolveAnchor pass for the
  // same source the save will re-anchor).
  let saveInFlight = false;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  }

  async function runIdleReanchor(): Promise<void> {
    idleTimer = undefined;
    if (destroyed) return;
    // Guards mirror the spec: dirty AND no save in flight.
    if (!dirty) return;
    if (saveInFlight) return;
    // Fire resolve_anchor for each known thread. Outcomes feed back
    // through the same onAnchorsResolved callback the post-save pump
    // uses, so Document.ts can dispatch `refreshAnchors` to repaint
    // commentHighlights via its existing wiring.
    for (const thread of args.threads) {
      try {
        const resolved = await ipc.resolveAnchor(args.tabId, thread.anchor);
        if (destroyed) return;
        args.onAnchorsResolved?.(thread.id, resolved);
      } catch {
        // Anchor resolution is best-effort; one thread failing must
        // not abort the loop or surface as an unhandled rejection.
      }
    }
  }

  function scheduleIdleReanchor(): void {
    if (destroyed) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      void runIdleReanchor();
    }, idleReanchorMs);
  }

  async function flushSave(): Promise<void> {
    clearTimer();
    // Saves cancel the pending idle timer: the post-save re-anchor pump
    // covers the exact same surface, so the idle pump would only fire
    // a redundant pass (and the `saveInFlight` guard already blocks it
    // mid-save). Cancelling here keeps the idle clock from re-arming
    // immediately after a successful save with no fresh user input.
    clearIdleTimer();
    if (destroyed) return;
    saveInFlight = true;
    try {
      const contents = editorView.state.doc.toString();
      const outcome = await Promise.resolve(ipc.saveDocument(args.tabId, contents));
      if (destroyed) return;
      // Phase-1 dirty-clear: every successful save clears the dirty
      // flag. The "successful" check is implicit — if `saveDocument`
      // rejected, the await above would have thrown and we'd never
      // get here. The Rust handler reports conflicts via the resolved
      // SaveOutcome.kind (`'conflict'`); we still clear dirty in that
      // case because Conflict.ts will reopen its own dialog and the
      // dirty flag is reset by the conflict resolution flow.
      void outcome;
      dirty = false;
      try {
        await ipc.setDirty(args.path, false);
      } catch {
        // Swallow — set_dirty is a hint to the watcher, not a hard
        // contract. A transient failure here must NOT mask the save.
      }
      // A4: matching dirty:false push so the TabBar pill re-hides its
      // .tab-dirty indicator. Dispatched UNCONDITIONALLY after a successful
      // save (mirroring the setDirty(false) call above) — we rely on the
      // Rust-side reject having already thrown out of `await ipc.saveDocument`
      // so reaching this point implies the save succeeded.
      document.dispatchEvent(
        new CustomEvent('mdviewer:tab-dirty', {
          detail: { path: args.path, dirty: false },
        }),
      );
      // Post-save re-anchor pass. Each thread's anchor is resolved
      // against the just-saved source; the outcome is fed back to the
      // caller via `onAnchorsResolved` so A.7's commentHighlights can
      // repaint without owning the IPC call itself.
      for (const thread of args.threads) {
        try {
          const resolved = await ipc.resolveAnchor(args.tabId, thread.anchor);
          if (destroyed) return;
          args.onAnchorsResolved?.(thread.id, resolved);
        } catch {
          // Anchor resolution is best-effort; a failure on one thread
          // must not abort the loop or surface as an unhandled rejection.
        }
      }
      // Canonical once-per-save signal. Fires AFTER the per-thread
      // onAnchorsResolved pump so Document.ts can refresh its hidden
      // render-shadow div exactly once per save (rather than N times,
      // one per thread). Skipped when the view was destroyed mid-save
      // — the destroyed-check above the loop would have already
      // returned, but we double-check here for the zero-threads path.
      if (destroyed) return;
      try {
        args.onSaved?.(args.path);
      } catch {
        // The onSaved callback is best-effort; a caller throwing must
        // not surface as an unhandled rejection on the save promise.
      }
    } finally {
      // Always clear the in-flight flag — failure or success — so a
      // later idle pump or subsequent flushSave is not blocked by a
      // stuck flag.
      saveInFlight = false;
    }
  }

  function scheduleSave(): void {
    if (destroyed) return;
    if (conflictPaused) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      // Fire-and-forget; errors surface via the IPC layer's own paths.
      void flushSave();
    }, debounceMs);
  }

  function markDirtyOnInput(): void {
    if (dirty) return;
    dirty = true;
    // set_dirty is fire-and-forget — failures on the watcher hint
    // don't block UI input.
    void ipc.setDirty(args.path, true).catch(() => {
      /* swallow */
    });
    // A4: push a parallel CustomEvent so the TabBar can light up the
    // per-tab dirty indicator. The Rust-side setDirty has other consumers
    // (window-close prompt, save indicator) and stays as-is; this event
    // is purely the UI-side signal. Document-level dispatch keeps us
    // off callback-prop drilling through the Workspace → Document →
    // LiveEditor chain (Decisions §2).
    document.dispatchEvent(
      new CustomEvent('mdviewer:tab-dirty', {
        detail: { path: args.path, dirty: true },
      }),
    );
  }

  function onConflictOpen(): void {
    conflictPaused = true;
    clearTimer();
    // B.2: also cancel the pending idle pump while the conflict
    // dialog is open. The user is not actively editing during the
    // conflict modal, and an idle pump that fires mid-dialog would
    // race the user's reload/keep/hand-merge decision.
    clearIdleTimer();
  }

  function onConflictClosed(): void {
    conflictPaused = false;
    if (dirty) scheduleSave();
  }

  document.addEventListener(CONFLICT_OPEN_EVENT, onConflictOpen);
  document.addEventListener(CONFLICT_CLOSED_EVENT, onConflictClosed);

  const updateListener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    // Any user-event-tagged transaction in the batch counts as a
    // user input. Programmatic dispatches (mode toggle, future
    // decoration recomputes, post-save re-anchor) have no userEvent
    // annotation by convention, so they're ignored here. This is
    // the contract that lets "mode toggle alone doesn't autosave".
    const fromUser = update.transactions.some((tr: Transaction) => {
      const ue = tr.annotation(Transaction.userEvent);
      return typeof ue === 'string' && ue.length > 0;
    });
    if (!fromUser) return;
    markDirtyOnInput();
    scheduleSave();
    // B.2: every user-input transaction also resets the idle re-anchor
    // timer. The timer fires only when the editor is quiescent for
    // `idleReanchorMs` AND dirty AND no save is in flight (those guards
    // live in `runIdleReanchor`). Programmatic transactions (mode flip,
    // post-save re-anchor) are filtered out above by the `fromUser`
    // check, so they don't perturb the idle clock.
    scheduleIdleReanchor();
  });

  // Word-wrap is on by default (matches pre-A.9 behaviour where the
  // legacy HTML render region word-wrapped naturally via CSS). The
  // post-A.9 single-CodeMirror surface needs `EditorView.lineWrapping`
  // explicitly — CodeMirror's default is no wrap, which surfaced as a
  // doc-wide horizontal scrollbar after every wysiwyg-touched release.
  // Older settings snapshots may not carry the field (legacy sidecar,
  // hand-crafted test fixture) — falling through to `true` keeps those
  // users on the historical, non-scrolling behaviour.
  const wordWrapEnabled =
    (args.settings.editor as unknown as { word_wrap?: boolean }).word_wrap ?? true;

  const startState = EditorState.create({
    doc: args.source,
    extensions: [
      modeField,
      editableCompartment.of(editableValueFor(initialMode, renderReadonly)),
      ...(wordWrapEnabled ? [EditorView.lineWrapping] : []),
      updateListener,
    ],
  });
  const editorView = new EditorView({ state: startState, parent: root });

  // Mode-change subscribers. Document.ts (A.2) subscribes during
  // mount to keep `data-mode` reflective on the editor host element
  // and to swap the dynamic `data-action="toggle-edit"` alias onto
  // whichever button switches to the opposite mode. The Set is
  // iterated AFTER the dispatch returns so listeners read a
  // consistent state via `view.mode()` if they want to.
  const modeSubscribers = new Set<(mode: LiveEditorMode) => void>();

  function notifyModeSubscribers(next: LiveEditorMode): void {
    // Snapshot to a fresh array so an `unsub()` call from inside a
    // listener doesn't mutate the iteration target.
    for (const fn of [...modeSubscribers]) {
      try {
        fn(next);
      } catch {
        // Subscriber failures must not break the dispatch path.
      }
    }
  }

  function setMode(next: LiveEditorMode): void {
    if (destroyed) return;
    // Two pieces flip together: the mode StateField (effect-driven)
    // and the editable compartment (Compartment.reconfigure). Both
    // ride a single transaction so observers see a consistent state.
    editorView.dispatch({
      effects: [
        setModeEffect.of(next),
        editableCompartment.reconfigure(editableValueFor(next, renderReadonly)),
      ],
    });
    notifyModeSubscribers(next);
  }

  function getMode(): LiveEditorMode {
    return editorView.state.field(modeField);
  }

  function subscribeMode(listener: (mode: LiveEditorMode) => void): () => void {
    // Synchronous initial fire — the listener observes the current
    // mode BEFORE this call returns. Document.ts depends on this
    // to set `data-mode` on the editor host before the first DOM
    // query happens on the next microtask.
    try {
      listener(getMode());
    } catch {
      // A throwing listener still gets subscribed; its later calls
      // are wrapped the same way.
    }
    modeSubscribers.add(listener);
    return () => {
      modeSubscribers.delete(listener);
    };
  }

  // WEBDRIVER-gated test hooks. Only attached when the bridge is
  // present (production builds without WebDriver never see them).
  // The slots live on `window.__mdviewerE2E`; we initialise the parent
  // object if absent but preserve any other slots already on it
  // (`nextPick`, `open`, `emitMenuAction`, etc. from main.ts).
  //
  // Hooks added here:
  //   - forceSave(): cancel debounce and flush immediately.
  //   - setLiveEditorSelection(start, end): place caret/selection at
  //       the given source offsets. The wysiwyg specs use this to
  //       position the caret deterministically before typing —
  //       driving CodeMirror's contenteditable through the W3C
  //       WebDriver text-input path is unreliable across widget
  //       decorations.
  //   - typeIntoLiveEditor(text): dispatch a userEvent='input.type'
  //       transaction that inserts `text` at the current selection.
  //       The userEvent tag is what the autosave update listener
  //       watches for, so this path exercises the same code as a
  //       real key press.
  const w = window as unknown as {
    __WEBDRIVER__?: unknown;
    __mdviewerE2E?: Record<string, unknown>;
  };
  const webdriverActive = Boolean(w.__WEBDRIVER__);
  if (webdriverActive) {
    if (!w.__mdviewerE2E) w.__mdviewerE2E = {};
    w.__mdviewerE2E.forceSave = (): Promise<void> => flushSave();
    w.__mdviewerE2E.setLiveEditorSelection = (start: number, end: number): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const docLen = editorView.state.doc.length;
      const lo = Math.max(0, Math.min(start, docLen));
      const hi = Math.max(lo, Math.min(end, docLen));
      // Order is load-bearing: (1) dispatch the selection transaction
      // so CodeMirror updates the DOM selection synchronously; (2)
      // synthesise a bubbling `mouseup` on contentDOM. SelectionPopover
      // listens on the contentDOM and reads `window.getSelection()`
      // inside its mouseup handler — dispatching BEFORE the selection
      // transaction would surface the previous (or empty) selection.
      // Target is `contentDOM` (the `.cm-content` element), NOT
      // `view.dom`, because that is where SelectionPopover's listener
      // is attached.
      editorView.dispatch({ selection: { anchor: lo, head: hi } });
      editorView.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return Promise.resolve();
    };
    w.__mdviewerE2E.getLiveEditorSource = (): string => {
      // Delegates to the StateField-backed doc; tests and the
      // spec-05 textarea-write helper read the current source via
      // this hook (rather than reaching into the DOM). When the
      // view is destroyed this hook is removed in the cleanup
      // block below, so callers never see a stale closure.
      return editorView.state.doc.toString();
    };
    w.__mdviewerE2E.typeIntoLiveEditor = (text: string): Promise<void> => {
      if (destroyed) return Promise.resolve();
      const sel = editorView.state.selection.main;
      // userEvent='input.type' mirrors a real key press: the autosave
      // update listener's user-event check accepts it, dirty fires,
      // and the debounce schedules a save.
      editorView.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        userEvent: 'input.type',
      });
      return Promise.resolve();
    };
  }

  function destroy(): void {
    destroyed = true;
    clearTimer();
    clearIdleTimer();
    document.removeEventListener(CONFLICT_OPEN_EVENT, onConflictOpen);
    document.removeEventListener(CONFLICT_CLOSED_EVENT, onConflictClosed);
    if (webdriverActive && w.__mdviewerE2E) {
      delete w.__mdviewerE2E.forceSave;
      delete w.__mdviewerE2E.setLiveEditorSelection;
      delete w.__mdviewerE2E.typeIntoLiveEditor;
      delete w.__mdviewerE2E.getLiveEditorSource;
    }
    editorView.destroy();
  }

  return {
    currentSource: () => editorView.state.doc.toString(),
    forceSave: flushSave,
    destroy,
    setMode,
    mode: getMode,
    subscribeMode,
    editorView,
  };
}
