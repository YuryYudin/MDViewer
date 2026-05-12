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

  // Render/Raw toggle. Hidden when the caller didn't supply
  // source/path/settings (StartPage placeholder paths land here). The
  // label shows the destination mode — clicking "Raw" switches to raw
  // and the label flips to "Render", matching wireframe 07's pattern.
  const toggleBtn = document.createElement('button');
  toggleBtn.setAttribute('data-action', 'toggle-render-raw');
  toggleBtn.textContent = 'Raw';
  if (args.source === undefined || args.path === undefined || args.settings === undefined) {
    toggleBtn.hidden = true;
  }
  toolbar.appendChild(toggleBtn);

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
  // Three selector aliases on the same element, each load-bearing:
  //   * data-region="editor"  — new Phase-A surface name
  //   * data-region="render"  — back-compat for existing root-level e2e
  //     specs (e2e/0x-*.spec.ts) that query the rendered-HTML pane the
  //     LiveEditor replaces (space-separated token list).
  //   * data-testid="live-editor" — wireframe contract used by the
  //     Phase-1 wysiwyg WDIO specs (per wireframes/01-render-default.html).
  const editorHost = document.createElement('div');
  editorHost.setAttribute('data-region', 'editor render');
  editorHost.setAttribute('data-testid', 'live-editor');
  view.appendChild(editorHost);
  root.appendChild(view);

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

  // --- Render/Raw toggle handler --------------------------------------
  toggleBtn.addEventListener('click', () => {
    if (!live) return;
    const next = live.mode() === 'render' ? 'raw' : 'render';
    live.setMode(next);
    // Label shows the destination of the NEXT click — when we're in
    // render mode the label reads "Raw" (the action), and vice versa.
    toggleBtn.textContent = next === 'render' ? 'Raw' : 'Render';
  });

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
