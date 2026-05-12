import { StateEffect, type Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

import type { Ipc, Settings, Thread, ResolveOutcome } from '../ipc';
import { mountLiveEditor, type LiveEditorView } from './LiveEditor';
import { attachSelectionPopover } from './SelectionPopover';
import { inlineMarks } from './decorations/inlineMarks';
import { blockWidgets } from './decorations/blocks';
import { commentHighlights, refreshAnchors } from './decorations/commentHighlights';

// Decoration CSS — imported here so Vite picks them up via the
// Document.ts entry that Workspace.ts mounts. A.5 owns
// decorations.css (inline marks + block widgets); A.7 owns
// comment-highlights.css (the .is-drifting between-save rule).
import './decorations/decorations.css';
import './decorations/comment-highlights.css';

export interface DocumentMountArgs {
  tabId: string;
  /**
   * Pre-rendered HTML carried over from the legacy two-pane Document view.
   * **Unused** under the WYSIWYG editor — the rendering now happens inside
   * CodeMirror via the decoration extensions (A.5 inline marks, A.6 block
   * widgets). The field is kept on the mount args type purely to avoid a
   * breaking change for Workspace.ts (A.9 was the surface swap; the
   * Workspace caller signature stays). New code should not rely on it.
   */
  html?: string;
  threads: Thread[];
  /** Source markdown the LiveEditor mounts with. */
  source?: string;
  /** Absolute on-disk path; routed to LiveEditor for the dirty/save IPC. */
  path?: string;
  /** Settings snapshot — LiveEditor reads `editor.*`. */
  settings?: Settings;
  /**
   * Fired whenever the orphan list recomputes (initial mount + every
   * post-save re-anchor pass). Workspace.ts uses this to refresh the
   * sidebar's orphan section.
   */
  onOrphansChanged?(orphans: Thread[]): void;
  /**
   * Initial value rendered in the doc-toolbar's font-zoom readout. The
   * Workspace listener owns the clamp / persist / readout update flow.
   */
  fontSizePx?: number;
}

const FONT_SIZE_MIN_PX = 10;
const FONT_SIZE_MAX_PX = 24;

export interface DocumentView {
  /** Refetch threads from the IPC and dispatch refreshAnchors to repaint. */
  refreshHighlights(): Promise<void>;
  /** Threads whose latest resolveAnchor returned `orphan`. */
  orphanThreads(): Thread[];
  /** Tear down LiveEditor + SelectionPopover and clear the root. */
  destroy(): void;
}

/**
 * Mount the WYSIWYG document view. A.9 swap: the legacy two-pane
 * render-region + edit-region layout is gone; a single LiveEditor mount
 * drives both Render and Raw modes via its StateField. The decoration
 * extensions (A.5 inline marks, A.6 block widgets, A.7 comment
 * highlights) are dispatched onto the editor via
 * `StateEffect.appendConfig` immediately after mount so A.4's
 * `mountLiveEditor` factory signature stays untouched.
 *
 * The Render/Raw toggle button rides a StateEffect (NOT a doc change),
 * which is the contract that lets mode toggles skip the autosave path.
 */
export async function mountDocument(
  root: HTMLElement,
  ipc: Ipc,
  args: DocumentMountArgs,
): Promise<DocumentView> {
  root.replaceChildren();
  const view = document.createElement('div');
  view.setAttribute('data-view', 'document');

  // --- Toolbar --------------------------------------------------------
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-region', 'doc-toolbar');

  // Render/Raw toggle (A.2 two-button structure). Hidden when the
  // caller didn't supply source/path/settings (StartPage placeholder
  // paths land here). Each button carries STATIC `data-mode=<target>`
  // — i.e. the mode the button switches TO. The reflective
  // `data-mode=<current>` lives on the editor host (see below). The
  // dynamic `data-action="toggle-edit"` alias is applied to the
  // OPPOSITE-mode button by the subscribeMode handle later in this
  // function; spec 05 needs the alias on whichever button takes the
  // user out of the current mode.
  //
  // The legacy single-button surface (`button[data-action="toggle-
  // render-raw"]`) is preserved on the opposite-mode button via a
  // second space-separated token in the same `data-action` attribute,
  // because pre-A.2 tests + e2e specs use that selector.
  const toggleContainer = document.createElement('div');
  toggleContainer.setAttribute('data-testid', 'mode-toggle');
  const renderBtn = document.createElement('button');
  renderBtn.type = 'button';
  renderBtn.setAttribute('data-mode', 'render');
  renderBtn.textContent = 'Render';
  const rawBtn = document.createElement('button');
  rawBtn.type = 'button';
  rawBtn.setAttribute('data-mode', 'raw');
  rawBtn.textContent = 'Raw';
  toggleContainer.append(renderBtn, rawBtn);
  if (args.source === undefined || args.path === undefined || args.settings === undefined) {
    toggleContainer.hidden = true;
    // Back-compat for tests that query `button[data-action="toggle-
    // render-raw"]` and assert .hidden — when the whole container is
    // hidden, surface that on each button too.
    renderBtn.hidden = true;
    rawBtn.hidden = true;
  }
  toolbar.appendChild(toggleContainer);

  // Share button — C3 wire-up; unchanged from the pre-A.9 surface.
  const shareBtn = document.createElement('button');
  shareBtn.setAttribute('data-action', 'share');
  shareBtn.textContent = 'Share…';
  if (args.path === undefined) {
    shareBtn.hidden = true;
  }
  shareBtn.addEventListener('click', () => {
    if (!args.path) return;
    view.dispatchEvent(
      new CustomEvent('share-requested', {
        bubbles: true,
        detail: { tabId: args.tabId, path: args.path },
      }),
    );
  });
  toolbar.appendChild(shareBtn);

  // Font-zoom cluster — A.9 keeps the existing surface verbatim. The
  // events bubble to Workspace, which owns the clamp/persist/readout
  // update flow.
  const fontSizePx = args.fontSizePx ?? 14;
  const zoom = document.createElement('span');
  zoom.setAttribute('data-region', 'font-zoom');
  zoom.classList.add('zoom');

  const decreaseBtn = document.createElement('button');
  decreaseBtn.setAttribute('data-action', 'font-decrease');
  decreaseBtn.textContent = '−';
  decreaseBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:font-decrease'));
  });

  const readoutBtn = document.createElement('button');
  readoutBtn.setAttribute('data-action', 'font-reset');
  readoutBtn.setAttribute('data-test', 'font-readout');
  readoutBtn.setAttribute('title', 'Reset to global default');
  readoutBtn.textContent = String(fontSizePx);
  readoutBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:font-reset'));
  });

  const increaseBtn = document.createElement('button');
  increaseBtn.setAttribute('data-action', 'font-increase');
  increaseBtn.textContent = '+';
  increaseBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
  });

  if (fontSizePx <= FONT_SIZE_MIN_PX) {
    decreaseBtn.disabled = true;
    decreaseBtn.setAttribute('title', `Already at minimum (${FONT_SIZE_MIN_PX} px)`);
  } else {
    decreaseBtn.setAttribute('title', 'Decrease font size');
  }
  if (fontSizePx >= FONT_SIZE_MAX_PX) {
    increaseBtn.disabled = true;
    increaseBtn.setAttribute('title', `Already at maximum (${FONT_SIZE_MAX_PX} px)`);
  } else {
    increaseBtn.setAttribute('title', 'Increase font size');
  }

  zoom.appendChild(decreaseBtn);
  zoom.appendChild(readoutBtn);
  zoom.appendChild(increaseBtn);
  toolbar.appendChild(zoom);
  view.appendChild(toolbar);

  // --- Editor host ----------------------------------------------------
  // Selector aliases on the SAME element, each load-bearing:
  //   * data-region="editor render" — space-separated token list:
  //       "editor" is the new Phase-A surface name; "render" preserves
  //       the legacy back-compat token used by root-level e2e specs
  //       (e2e/0x-*.spec.ts) that query the rendered-HTML pane the
  //       LiveEditor replaced.
  //   * data-testid="live-editor" — wireframe contract for the
  //       Phase-1 wysiwyg WDIO specs (per wireframes/01-render-default.html).
  //   * data-test="editor" — back-compat alias for spec 05 line 22's
  //       `browser.$('[data-test="editor"]').waitForExist()`.
  //   * data-mode="<current-mode>" — reflective (which mode the editor
  //       is in right now). Set synchronously below via subscribeMode's
  //       initial-fire contract. Note: same attribute name as the
  //       toggle buttons but OPPOSITE semantics — buttons carry the
  //       TARGET mode (where this button switches to).
  const editorHost = document.createElement('div');
  editorHost.setAttribute('data-region', 'editor render');
  editorHost.setAttribute('data-testid', 'live-editor');
  editorHost.setAttribute('data-test', 'editor');
  view.appendChild(editorHost);

  // --- Hidden render-shadow div (A.2) ---------------------------------
  // Sibling to the editor host. Holds the canonical render_markdown
  // output for export / diff / parity tooling that needs semantic HTML
  // without reaching through CodeMirror's decoration tree. Populated
  // once on mount and once per save via the LiveEditor's `onSaved`
  // callback — NOT per-thread `onAnchorsResolved`, which would issue
  // one render per resolved thread and briefly hold stale content
  // between resolutions. `hidden` + `aria-hidden` keep it out of the
  // visible layout and the accessibility tree.
  const shadow = document.createElement('div');
  shadow.setAttribute('data-region', 'rendered-shadow');
  shadow.setAttribute('aria-hidden', 'true');
  shadow.hidden = true;
  view.appendChild(shadow);

  root.appendChild(view);

  // DOMParser-then-appendChild — explicitly NOT `innerHTML = html`.
  // render_markdown output is already trusted upstream (the existing
  // renderer path consumes it without sanitization), so a DOMPurify
  // step would add bundle weight and a maintenance vector with no
  // security gain for this input source. The DOMParser detour is
  // hygiene against the direct `innerHTML` string-assignment pattern.
  async function refreshShadow(source: string): Promise<void> {
    try {
      const result = await ipc.renderMarkdown(source);
      const html = (result as { html?: string }).html ?? '';
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const fresh = Array.from(parsed.body.childNodes).map((n) => n.cloneNode(true));
      shadow.replaceChildren(...fresh);
    } catch {
      // Best-effort — the shadow is a parity surface, not the user-
      // visible editor. A render failure here must not break the mount.
    }
  }

  // --- Orphan / re-anchor bookkeeping ---------------------------------
  // `currentThreads` is the canonical list passed into LiveEditor.
  // After each save it gets repaired against the latest source via the
  // `onAnchorsResolved` pump (which we feed back into refreshAnchors so
  // commentHighlights repaints). Orphans land here so Workspace's
  // orphan-sidebar surface can read them via `orphanThreads()`.
  let currentThreads: Thread[] = [...args.threads];
  let orphans: Thread[] = [];

  // Cache of the most recent resolveAnchor outcome per thread id. Used
  // by the post-save re-anchor pump to build the refreshAnchors payload
  // (which only carries `resolved` threads — `orphan` threads have no
  // visible decoration).
  const anchorOutcomes = new Map<string, ResolveOutcome>();

  function buildVisibleThreads(): Thread[] {
    // Visible threads are the ones with a resolved outcome AND a
    // matching id in currentThreads. Mapping the resolved [start,end]
    // back onto the thread snapshot is what commentHighlights consumes.
    const visible: Thread[] = [];
    for (const t of currentThreads) {
      const outcome = anchorOutcomes.get(t.id);
      if (!outcome) continue;
      if (outcome.kind !== 'resolved') continue;
      visible.push({
        ...t,
        anchor: { ...t.anchor, start: outcome.start, end: outcome.end },
      });
    }
    return visible;
  }

  function computeOrphans(): Thread[] {
    return currentThreads.filter((t) => {
      const outcome = anchorOutcomes.get(t.id);
      return outcome?.kind === 'orphan';
    });
  }

  // --- LiveEditor mount -----------------------------------------------
  // `source`/`path`/`settings` are optional on the args type for the
  // legacy StartPage placeholder paths. When they're missing we mount
  // LiveEditor with stub defaults so the [data-view="document"] test
  // surface still exists; the Render/Raw toggle stays hidden via the
  // earlier guard so the user can't switch modes on a non-document.
  const source = args.source ?? '';
  const path = args.path ?? '';
  const liveSettings: Settings =
    args.settings ?? ({
      profile: { user_id: '', display_name: '', color: '#000' },
      appearance: {
        theme: 'light',
        font_size_px: 14,
        line_height: 1.5,
        density: 'comfortable',
        startup_mode: 'clean',
        dark_variant: 'pure',
      },
      editor: {
        default_open_mode: 'render',
        auto_save: false,
        auto_save_debounce_ms: 500,
        external_change_behavior: 'ask',
        syntax_highlighting: true,
        mermaid_enabled: true,
        show_whitespace: false,
        word_wrap: true,
        render_readonly: false,
      },
      comments: {
        auto_merge: 'ask',
        reattachment_confidence: 70,
        sidecar_pattern: '{name}.comments.json',
        show_resolved: true,
      },
      advanced: { sync_provider: null, verbose_logs: false },
      shortcuts: {},
      cloud: {},
      onboarding: { cli_install_prompt_seen_for: '' },
    } as unknown as Settings);

  // Dispatch refreshAnchors with the latest visible-thread snapshot.
  // Called from both `applyAnchorOutcome` (per-thread, post-save) and
  // `refreshHighlights` (whole-batch, post-thread-create).
  let live: LiveEditorView | null = null;
  function dispatchRefreshAnchors(): void {
    if (!live) return;
    live.editorView.dispatch({
      effects: refreshAnchors.of(buildVisibleThreads()),
    });
  }

  function applyAnchorOutcome(threadId: string, outcome: ResolveOutcome): void {
    anchorOutcomes.set(threadId, outcome);
    const prevOrphans = orphans;
    orphans = computeOrphans();
    dispatchRefreshAnchors();
    // Only fire onOrphansChanged when the set actually moved — the
    // post-save pump fires per thread, and re-mounting the sidebar on
    // every individual outcome would thrash a multi-thread document.
    if (!orphansEqual(prevOrphans, orphans)) {
      args.onOrphansChanged?.(orphans.slice());
    }
  }

  live = mountLiveEditor(editorHost, ipc, {
    tabId: args.tabId,
    path,
    source,
    settings: liveSettings,
    threads: currentThreads,
    onAnchorsResolved: applyAnchorOutcome,
    // Canonical once-per-save signal. Fires exactly once per
    // successful save_document AFTER the per-thread re-anchor pump
    // has completed (see LiveEditor's flushSave). Wiring this here
    // — not onAnchorsResolved — means render_markdown runs ONCE per
    // save rather than N times for an N-thread document. The shadow
    // never holds stale content between resolutions because the
    // refresh lands after the whole pump.
    onSaved: () => {
      if (!live) return;
      void refreshShadow(live.currentSource());
    },
  });

  // --- Initial shadow population --------------------------------------
  // Fire-and-forget — tests drain microtasks before asserting. The
  // shadow remains empty until the renderMarkdown promise resolves
  // (acceptable; nothing visible to the user is held back by it).
  void refreshShadow(source);

  // --- Mode reflection + dynamic toggle-edit alias swap (A.2) ---------
  // Two pieces ride the same subscribeMode handle:
  //   1. The editor host's reflective `data-mode` attribute (the
  //      "which mode am I in" surface). render-raw-toggle.spec.ts:101
  //      / :138 read this attribute via `[data-mode="render"]` /
  //      `[data-mode="raw"]` selectors.
  //   2. The dynamic `data-action="toggle-edit"` alias on the
  //      OPPOSITE-mode button. In render mode the alias lands on the
  //      Raw button (clicking it switches to raw, i.e. "toggle to
  //      edit/raw mode"); in raw mode it lands on Render. Spec 05's
  //      click targets find the alias either way.
  //
  // The legacy `data-action="toggle-render-raw"` token sits alongside
  // `toggle-edit` on the same opposite-mode button so older selectors
  // keep working. subscribeMode's synchronous initial-fire contract
  // (see LiveEditor.subscribeMode) guarantees both attributes land
  // BEFORE this call returns, so the first DOM query after mount sees
  // a fully-populated state.
  const modeUnsub = live.subscribeMode((mode) => {
    editorHost.setAttribute('data-mode', mode);
    renderBtn.removeAttribute('data-action');
    rawBtn.removeAttribute('data-action');
    const oppositeBtn = mode === 'render' ? rawBtn : renderBtn;
    // Space-separated token list: new alias + legacy alias.
    oppositeBtn.setAttribute('data-action', 'toggle-edit toggle-render-raw');
    // Active-mode marker for the spec query at click-and-type.spec.ts:54
    // — `button[aria-pressed="true"]` on the button whose static
    // data-mode matches the current mode.
    const activeBtn = mode === 'render' ? renderBtn : rawBtn;
    activeBtn.setAttribute('aria-pressed', 'true');
    oppositeBtn.setAttribute('aria-pressed', 'false');
  });

  // Toggle-button click handlers. Each calls setMode on the LiveEditor,
  // which dispatches the mode StateEffect and notifies subscribers —
  // the subscribeMode listener above does the DOM bookkeeping.
  renderBtn.addEventListener('click', () => {
    if (!live) return;
    live.setMode('render');
  });
  rawBtn.addEventListener('click', () => {
    if (!live) return;
    live.setMode('raw');
  });

  // A.6 noted that Strikethrough needs `markdown({ base: markdownLanguage })`
  // so the parser registers the GFM strikethrough extension. Without
  // this, `~~text~~` doesn't show up as a Strikethrough node in the
  // lezer tree and the inlineMarks decoration never fires.
  const decorationExtensions: Extension[] = [
    markdown({ base: markdownLanguage, extensions: [GFM] }),
    inlineMarks(),
    blockWidgets({ renderMarkdown: (s: string) => ipc.renderMarkdown(s) }),
    commentHighlights(),
  ];
  live.editorView.dispatch({
    effects: StateEffect.appendConfig.of(decorationExtensions),
  });

  // --- SelectionPopover ------------------------------------------------
  // Returns a teardown that the destroy path calls.
  const detachSelectionPopover = attachSelectionPopover(
    live.editorView,
    ipc,
    () => args.tabId,
  );

  // --- Initial anchor resolution --------------------------------------
  // Phase-1: resolve every thread once on mount. The post-save pump
  // owns the steady-state pass after that. We deliberately don't await
  // the loop concurrently (Promise.all) because the IPC mock in some
  // tests is synchronous and the Map iteration must observe the call
  // order; serial awaits keep the test surface deterministic.
  await (async () => {
    for (const t of currentThreads) {
      try {
        const outcome = await ipc.resolveAnchor(args.tabId, t.anchor);
        anchorOutcomes.set(t.id, outcome);
      } catch {
        // Anchor resolution is best-effort.
      }
    }
    orphans = computeOrphans();
    dispatchRefreshAnchors();
    args.onOrphansChanged?.(orphans.slice());
  })();

  // (Render/Raw toggle click handlers are wired above, inside the
  // subscribeMode block — they delegate to live.setMode and let the
  // subscribeMode listener do the DOM bookkeeping.)

  return {
    refreshHighlights: async () => {
      // Re-fetch threads from the IPC and rebuild the anchor outcomes
      // map. Called from Workspace.ts after thread-created /
      // thread-replied / thread-resolved events.
      const fresh = await ipc.listThreads(args.tabId);
      currentThreads = fresh;
      anchorOutcomes.clear();
      for (const t of currentThreads) {
        try {
          const outcome = await ipc.resolveAnchor(args.tabId, t.anchor);
          anchorOutcomes.set(t.id, outcome);
        } catch {
          // Best-effort — keep going on failure so one broken anchor
          // doesn't break the rest.
        }
      }
      orphans = computeOrphans();
      dispatchRefreshAnchors();
      args.onOrphansChanged?.(orphans.slice());
    },
    orphanThreads: () => orphans.slice(),
    destroy: () => {
      // A.2 teardown: unsubscribe from the mode listener before tearing
      // down the LiveEditor — calling unsub() after live.destroy() is
      // safe (the underlying Set just removes a missing entry) but
      // explicit ordering keeps the destroy contract auditable. The
      // shadow div sits inside `view`, which `root.replaceChildren()`
      // removes; we also call shadow.remove() defensively in case the
      // root teardown ever changes shape.
      modeUnsub();
      shadow.remove();
      detachSelectionPopover();
      live?.destroy();
      live = null;
      root.replaceChildren();
    },
  };
}

/**
 * Returns true when two orphan lists are equal as ordered id sequences.
 * `applyAnchorOutcome` calls this on every per-thread re-anchor outcome
 * to decide whether to fire `onOrphansChanged` — without the check, a
 * multi-thread doc would thrash the sidebar.
 */
function orphansEqual(a: readonly Thread[], b: readonly Thread[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}
