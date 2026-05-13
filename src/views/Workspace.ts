import type {
  DocPref,
  DriveCollaborator,
  Ipc,
  OpenOutcome,
  Settings,
  TabBackend,
  Thread,
} from '../ipc';
import { driveGetCollaborators, driveResolvePath } from '../ipc';
import { mountStartPage } from './StartPage';
import { mountTabBar } from './TabBar';
import { mountDocument } from './Document';
import { mountCommentsSidebar } from './CommentsSidebar';
import { mountCollabChip } from './CollabChip';
import { mountConflict, type DriveConflictSource } from './Conflict';
import { mountShareDialog } from './ShareDialog';
import { mountDriveStatus } from './DriveStatus';

/**
 * C1: synthetic prefix used by `drive_open_url` for DriveApi tabs whose
 * "path" is `drive-api://<file_id>` rather than an on-disk path. Used
 * here to recover the file_id without an extra IPC round-trip.
 */
const DRIVE_API_PREFIX = 'drive-api://';

/**
 * C1: best-effort detection of whether the active tab is Drive-backed and,
 * if so, which `file_id` to ask `drive_get_collaborators` about. Returns
 * `null` when the tab is Local (or when DriveDesktop resolution rejects —
 * Drive disconnected, path outside any known mount, etc.). The TabBackend
 * label is approximate (we don't go through the Rust-side
 * `Tab::compute_backend` lookup); this is intentionally TS-only per the
 * task scope. Workspace consumers only need a Drive-vs-Local discriminator
 * plus the file_id.
 */
async function detectDriveBacking(
  path: string | undefined,
): Promise<{ backend: Exclude<TabBackend, 'local'>; fileId: string } | null> {
  if (!path) return null;
  if (path.startsWith(DRIVE_API_PREFIX)) {
    const fileId = path.slice(DRIVE_API_PREFIX.length);
    return fileId ? { backend: 'drive_api', fileId } : null;
  }
  try {
    const fileId = await driveResolvePath(path);
    return fileId ? { backend: 'drive_desktop', fileId } : null;
  } catch {
    return null;
  }
}

/**
 * Per-document font-size bounds. Match the Settings panel slider's range
 * exactly so what the user sees in Settings agrees with what `Cmd+=` does.
 * The Rust-side validator clamps to the same range as defense-in-depth.
 */
const FONT_SIZE_MIN_PX = 10;
const FONT_SIZE_MAX_PX = 24;
/**
 * Debounce window for the IPC persist call. Holding `Cmd+=` fires roughly
 * 30 events / sec via OS auto-repeat; without this debounce every tick
 * would round-trip to disk and contend on `doc_prefs.json`.
 */
const FONT_DEBOUNCE_MS = 150;

/**
 * Module-level handle on the previous mount's AbortController. The font-
 * size listeners attach to `document`, which outlives any individual root
 * element; a re-mount (rare in production, common in unit tests) needs to
 * dispose the prior mount's listeners before installing fresh ones so old
 * closures don't double-respond to a single event.
 */
let prevMountAbort: AbortController | undefined;

export interface WorkspaceState {
  tabs: { id: string; path: string; source?: string; threads?: Thread[]; html?: string }[];
  activeId: string | null;
}

export interface WorkspaceHandle {
  refresh(): Promise<void>;
  /** C2: route an OpenOutcome from the calling layer through to either
   *  Document or Conflict view. StartPage's openDocument flow funnels here
   *  via __mdv_setActive then triggers a refresh. */
  setActive(outcome: OpenOutcome): void;
  /**
   * A4: update the per-tab dirty registry. Called by TabBar's document-
   * level `mdviewer:tab-dirty` listener whenever LiveEditor reports a
   * dirty/clean transition. Dirty=true sets the bit; dirty=false removes
   * the entry (treating the Map as a presence set keeps the surface
   * minimal and makes `getDirtyState` cheap).
   */
  setTabDirty(path: string, dirty: boolean): void;
  /**
   * A4: read the per-tab dirty bit. TabBar's pill builder calls this on
   * every render so the indicator survives re-mounts (close/open/switch).
   * Returns `false` for paths the registry has never seen.
   */
  getDirtyState(path: string): boolean;
}

/**
 * Mount the workspace shell: titlebar / tabbar / body / status. The body
 * routes between StartPage (when no documents are open) and a Document
 * mount (when at least one is). Settings.ts (A11) and Conflict.ts (C2) are
 * routed by the calling layer when those views need to display.
 *
 * The `external-change` Tauri event from B2's watcher surfaces here as a
 * banner inside the body region — this is the runtime hook for issue #2
 * raised in Phase-B's implementation review.
 */
export async function mountWorkspace(root: HTMLElement, ipc: Ipc): Promise<WorkspaceHandle> {
  // Drop any document-level listeners installed by a prior mount before we
  // install fresh ones. In production this is a no-op (mountWorkspace is
  // called exactly once at startup); in jsdom unit tests it's what keeps
  // the font-size listeners from accumulating across `mountWorkspace` calls
  // and double-incrementing the inline `--doc-font-size` on a single event.
  prevMountAbort?.abort();
  const mountAbort = new AbortController();
  prevMountAbort = mountAbort;

  root.replaceChildren();
  const shell = document.createElement('div');
  shell.setAttribute('data-view', 'workspace');
  shell.className = 'workspace';
  // Three regions: tabbar (36px), body (1fr), status (22px). The OS
  // already renders the window title in the native chrome — an in-app
  // titlebar would duplicate it, and leaving a hidden 4th track in the
  // grid causes auto-placement to slot the visible items into the wrong
  // tracks (tabbar collapsing, status floating in the middle).
  for (const region of ['tabbar', 'body', 'status']) {
    const el = document.createElement('div');
    el.setAttribute('data-region', region);
    // The status region also serves as wireframe-01/03/05's status-bar
    // and the tabbar is wireframe "tabs"; expose those via data-view so
    // spec selectors and theming hooks can target them by purpose.
    if (region === 'status') el.setAttribute('data-view', 'status-bar');
    if (region === 'tabbar') el.setAttribute('data-view', 'tabs');
    shell.appendChild(el);
  }
  root.appendChild(shell);

  // Status bar (wireframe-01/03/05): profile chip on the left, a flexible
  // spacer, and "MDViewer vX.Y.Z" version label on the right. (The
  // wireframes' "Tauri 2 · vX.Y.Z" placeholder mentioned the runtime,
  // not the product — users see the product name.)
  const status = shell.querySelector<HTMLElement>('[data-region="status"]')!;
  const userName = document.createElement('span');
  userName.setAttribute('data-test', 'user-name');
  userName.className = 'profile-chip';
  status.appendChild(userName);
  // URL hover preview — populated by Document.ts via the
  // `mdviewer:link-hover` CustomEvent. Empty string when no link is
  // hovered; the CSS rule hides the chip in that state so it doesn't
  // leave a gap in the status bar.
  const linkPreview = document.createElement('span');
  linkPreview.setAttribute('data-test', 'link-preview');
  linkPreview.className = 'link-preview';
  status.appendChild(linkPreview);
  const grow = document.createElement('span');
  grow.className = 'grow';
  status.appendChild(grow);
  // A8: Drive status pill — sits between the spacer and the version label
  // on the right side of the status bar. mountDriveStatus subscribes to
  // `drive-status-changed` events from the Rust side; the host element
  // owns its own data-connected/data-online attributes for theming.
  //
  // Opt-in (2025-05-01): only mount the pill content when the user has
  // explicitly enabled the Drive API integration via Settings → Drive →
  // Advanced. Default users see an empty pill host (which CSS hides via
  // `.drive-status-pill:empty`). The host element itself is appended
  // SYNCHRONOUSLY so DOM order remains stable for layout tests; the
  // listener subscription happens async after getSettings resolves.
  const driveStatusHost = document.createElement('span');
  status.appendChild(driveStatusHost);
  void (async () => {
    try {
      const s = await ipc.getSettings();
      if (!s.cloud?.drive?.feature_enabled) return;
      const unmountDriveStatus = mountDriveStatus(driveStatusHost);
      mountAbort.signal.addEventListener('abort', () => {
        try {
          unmountDriveStatus();
        } catch {
          // best-effort cleanup; never let a stale unsub crash a re-mount.
        }
      });
    } catch {
      // jsdom / unit tests without IPC — no pill subscription.
    }
  })();
  const versionText = document.createElement('span');
  versionText.setAttribute('data-test', 'version-label');
  versionText.className = 'version-label';
  status.appendChild(versionText);
  document.addEventListener(
    'mdviewer:link-hover',
    (ev: Event) => {
      const detail = (ev as CustomEvent<{ href: string | null }>).detail;
      linkPreview.textContent = detail?.href ?? '';
    },
    { signal: mountAbort.signal },
  );
  // Populate the version chip from app_info; the chip stays empty if
  // the IPC fails (defensive — unit tests stub it out).
  void ipc.appInfo()
    .then((info) => {
      versionText.textContent = `MDViewer v${info.version}`;
    })
    .catch(() => {});

  const state: WorkspaceState = { tabs: [], activeId: null };
  const tabbar = shell.querySelector<HTMLElement>('[data-region="tabbar"]')!;
  const body = shell.querySelector<HTMLElement>('[data-region="body"]')!;

  // A4: per-tab dirty registry. The Map is the source of truth for
  // `[data-testid="tab-dirty"]` visibility on each tab pill. Two flows
  // converge on this state:
  //   - LiveEditor dispatches `mdviewer:tab-dirty` (with detail
  //     {path, dirty}) on first input AND after a successful save;
  //     TabBar's document-level listener calls setTabDirty(...) for us.
  //   - TabBar's pill builder calls getDirtyState(path) at render time
  //     so re-mounts (open/close/switch) reflect the current bit.
  // We treat the Map as a presence set: dirty=true sets the entry,
  // dirty=false deletes it. Cheaper than persisting booleans.
  const dirtyRegistry = new Map<string, boolean>();
  function setTabDirty(path: string, dirty: boolean): void {
    if (dirty) dirtyRegistry.set(path, true);
    else dirtyRegistry.delete(path);
  }
  function getDirtyState(path: string): boolean {
    return dirtyRegistry.get(path) === true;
  }

  // Comments-sidebar visibility (in-session only — not persisted). Three
  // input surfaces converge on `mdviewer:toggle-sidebar`: the close button
  // inside CommentsSidebar, the View → Toggle Comments Sidebar menu item
  // (via menuBridge), and the Cmd+Shift+S keymap action (via main.ts's
  // dispatchAction). All three flip `sidebarHidden` here, which the body's
  // `data-sidebar` attribute reflects so app.css's hide rule applies.
  let sidebarHidden = false;
  function applySidebarVisibility(): void {
    if (sidebarHidden) body.setAttribute('data-sidebar', 'hidden');
    else body.removeAttribute('data-sidebar');
  }
  document.addEventListener(
    'mdviewer:toggle-sidebar',
    () => {
      sidebarHidden = !sidebarHidden;
      applySidebarVisibility();
    },
    { signal: mountAbort.signal },
  );

  // Manual reload-comments button (2025-05-01): the sidebar's ↻ button
  // dispatches `mdviewer:reload-comments` and we delegate to the existing
  // reload_document IPC. That handler re-reads the .md AND its sidecar,
  // then refresh() repaints the sidebar with the fresh thread list.
  // Useful when Drive Desktop has just synced down a collaborator's edit
  // but the watcher hasn't yet picked it up (rare on macOS, more common
  // on network filesystems). The watcher already auto-reloads sidecar
  // changes when it sees them — this is a "kick it now" escape hatch.
  document.addEventListener(
    'mdviewer:reload-comments',
    () => {
      const path = activeTab.path;
      if (!path) return;
      void (async () => {
        try {
          const fresh = await ipc.reloadDocument(path);
          activeTab.threads = fresh.threads;
          activeTab.source = fresh.source;
          activeTab.html = fresh.html;
          await refresh();
        } catch (e) {
          console.warn('reload-comments failed:', e);
        }
      })();
    },
    { signal: mountAbort.signal },
  );

  // Cache the active tab's data the most recent open_document call gave us
  // so refresh() doesn't have to re-open just to re-render.
  const activeTab: { tabId?: string; path?: string; source?: string; threads?: Thread[]; html?: string } = {};
  // C2: when the most recent OpenOutcome was a Conflict, refresh() routes
  // to Conflict.ts instead of Document.ts. Cleared when a Document outcome
  // arrives or when the user finishes the merge.
  //
  // Phase B implementation review fix #2: `driveSource` is the wireframe-07
  // banner discriminator — preserve it through pendingConflict so the
  // mountConflict call can pass it on. Local-backend conflicts (open_document
  // detected divergence on a non-Drive tab) leave it `null`, which Conflict.ts
  // treats as "omit the Drive banner".
  let pendingConflict:
    | {
        tabId: string;
        path: string;
        local: string;
        incoming: string;
        driveSource?: DriveConflictSource | null;
      }
    | null = null;
  let settings: Settings | null = null;

  // Font-size feature (A9): the most recent per-doc override for the active
  // tab (or `null` if the tab has none). Set during the tab-activation hook
  // and updated when the user changes the size from the toolbar / shortcut.
  // Used by the `mdviewer:settings-changed` listener to decide whether the
  // readout should follow the new global default.
  let activeDocPref: DocPref | null = null;
  // Single shared timer for the debounced IPC persist call. A new gesture
  // resets the timer so a burst of presses coalesces to one disk write.
  let fontPersistTimer: ReturnType<typeof setTimeout> | undefined;

  // Subscribe to the watcher's external-change event from B2. tauri's
  // event listener is async-awaitable in setup; loaded lazily so unit
  // tests against this view in jsdom don't need the @tauri-apps/api shim.
  type EventListener = (path: string, action: 'reload' | 'ask' | 'ignore') => void;
  let externalListener: EventListener | null = null;
  try {
    const tauriEvent = await import('@tauri-apps/api/event');
    await tauriEvent.listen<{ path: string; kind: string; action: string }>(
      'external-change',
      (ev) => {
        const banner = body.querySelector<HTMLElement>('[data-view="external-change"]');
        const action = (ev.payload.action as 'reload' | 'ask' | 'ignore') ?? 'ask';
        if (action === 'ignore') return;
        externalListener?.(ev.payload.path, action);
        // Even if the active view doesn't claim the event, render a default
        // banner with a Reload action so the user always has a path back.
        if (!banner) {
          const b = document.createElement('aside');
          b.setAttribute('data-view', 'external-change');
          b.className = `banner banner-${action}`;
          b.textContent = action === 'reload'
            ? `${ev.payload.path} changed on disk — reloading.`
            : `${ev.payload.path} changed on disk.`;
          body.prepend(b);
          if (action === 'reload') {
            // Auto-dismiss the banner after a short delay; the document
            // has already been re-read by refresh_tab on the IPC side.
            setTimeout(() => b.remove(), 3000);
          }
        }
      },
    );
  } catch {
    // jsdom / unit tests don't have the Tauri runtime — skip silently.
  }

  /**
   * Compute the effective font size for the current document. The order of
   * precedence is: inline `--doc-font-size` on `<html>` (set by either the
   * tab-activation hook or a recent `applyFontDelta` call) → cached global
   * default → 14 px hardcoded fallback. Reading from the inline property
   * (when set) avoids drift between the rendered size and our internal
   * count after the user holds `Cmd+=` for a moment.
   */
  function currentEffectiveSize(): number {
    const inline = document.documentElement.style.getPropertyValue('--doc-font-size').trim();
    if (inline) {
      const px = parseInt(inline, 10);
      if (!Number.isNaN(px)) return px;
    }
    return settings?.appearance?.font_size_px ?? 14;
  }

  /**
   * Sync the doc-toolbar's readout text + the `−` / `+` button disabled
   * states to the current effective size. Called after every applyFontDelta
   * AND after tab activation. The toolbar elements live inside the body
   * region; queries against `root` are scoped to the workspace shell so
   * cross-test pollution can't bleed in.
   */
  function updateReadout(): void {
    const px = currentEffectiveSize();
    const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]');
    if (readout) readout.textContent = String(px);
    const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]');
    const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]');
    if (dec) {
      const atMin = px <= FONT_SIZE_MIN_PX;
      dec.disabled = atMin;
      dec.setAttribute(
        'title',
        atMin ? `Already at minimum (${FONT_SIZE_MIN_PX} px)` : 'Decrease font size',
      );
    }
    if (inc) {
      const atMax = px >= FONT_SIZE_MAX_PX;
      inc.disabled = atMax;
      inc.setAttribute(
        'title',
        atMax ? `Already at maximum (${FONT_SIZE_MAX_PX} px)` : 'Increase font size',
      );
    }
  }

  /**
   * Apply a font-size delta against the active tab. `delta = 1` increases by
   * one pixel (clamped at MAX), `delta = -1` decreases (clamped at MIN), and
   * `delta = null` is the reset path which REMOVES the inline `--doc-font-size`
   * so the CSS fallback re-applies — Settings changes propagate to reset
   * documents without remount. Persistence happens after a 150 ms debounce so
   * a key-repeat burst coalesces to one disk write; untitled / scratch tabs
   * (no on-disk path) skip the IPC entirely.
   */
  function applyFontDelta(delta: 1 | -1 | null): void {
    const activePath = activeTab.path;
    if (delta === null) {
      // Reset: clear the inline property AND drop our cached override so a
      // subsequent `mdviewer:settings-changed` event re-renders the readout.
      document.documentElement.style.removeProperty('--doc-font-size');
      activeDocPref = null;
      updateReadout();
      if (activePath) {
        clearTimeout(fontPersistTimer);
        fontPersistTimer = setTimeout(() => {
          void ipc.deleteDocPref(activePath);
        }, FONT_DEBOUNCE_MS);
      }
      return;
    }
    const current = currentEffectiveSize();
    const next = Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, current + delta));
    if (next === current) {
      // No-op at the bound — refresh the disabled state in case the toolbar
      // was just mounted and hasn't been updated yet.
      updateReadout();
      return;
    }
    document.documentElement.style.setProperty('--doc-font-size', `${next}px`);
    // Preserve the existing per-file Drive-detect dismissal (C2) when
    // overwriting the doc-pref entry — the font-size flow must not silently
    // re-enable the toast on a file the user already dismissed for.
    const preservedDismiss = activeDocPref?.drive_detect_dismissed ?? false;
    activeDocPref = { font_size_px: next, drive_detect_dismissed: preservedDismiss };
    updateReadout();
    if (activePath) {
      clearTimeout(fontPersistTimer);
      fontPersistTimer = setTimeout(() => {
        void ipc.setDocPref(activePath, {
          font_size_px: next,
          drive_detect_dismissed: preservedDismiss,
        });
      }, FONT_DEBOUNCE_MS);
    }
  }

  // Three document-level CustomEvent listeners share the same helper. The
  // events are fired by Document.ts toolbar buttons, by `src/keymap.ts`'s
  // shortcut dispatcher (Cmd+= / Cmd+- / Cmd+0), and by `src/menuBridge.ts`
  // when the user picks View → Zoom In/Out/Reset from the native menu. The
  // `signal` ties their lifetime to this mount so a re-mount tears them
  // down before installing fresh closures.
  document.addEventListener('mdviewer:font-increase', () => applyFontDelta(1), {
    signal: mountAbort.signal,
  });
  document.addEventListener('mdviewer:font-decrease', () => applyFontDelta(-1), {
    signal: mountAbort.signal,
  });
  document.addEventListener('mdviewer:font-reset', () => applyFontDelta(null), {
    signal: mountAbort.signal,
  });

  // When `setSettings` resolves, `src/ipc.ts` dispatches `mdviewer:settings-
  // changed` with the new Settings as the event detail. We refresh our cached
  // copy and, when the active tab has no override, re-render the readout so
  // it tracks the new global default. Tabs WITH an override keep their
  // override on display because that's the user's explicit choice.
  document.addEventListener(
    'mdviewer:settings-changed',
    (ev: Event) => {
      const detail = (ev as CustomEvent<Settings>).detail;
      if (detail) settings = detail;
      if (!activeDocPref) updateReadout();
    },
    { signal: mountAbort.signal },
  );

  async function refresh(): Promise<void> {
    settings ??= await ipc.getSettings();
    // Re-read on every refresh so the status-bar chip stays in sync if the
    // user changes their display_name from the Settings view. Defensive
    // optional access — unit-test mocks don't always include profile, and
    // the mock can resolve to undefined when only one resolved value was
    // queued via `mockResolvedValueOnce`.
    if (settings?.profile?.display_name) {
      userName.textContent = settings.profile.display_name;
    }
    const summaries = await ipc.listOpenDocuments();
    state.tabs = summaries.map((s) => ({ id: s.id, path: s.path }));
    // Align state.activeId with Rust's authoritative active tab when the
    // WebView's local cache is empty. This is the session-restore boot
    // path: Rust restored open_tabs + active_tab from session.json, and
    // we need to display the same active tab on the WebView side. After
    // a tab is clicked or opened from the WebView, state.activeId stays
    // in sync via setActive — no need to ping Rust on every refresh.
    if (state.activeId === null && state.tabs.length > 0) {
      try {
        const active = await ipc.getActiveTabId();
        state.activeId = active ?? state.tabs[0].id;
      } catch {
        // jsdom unit-test mocks may not stub this — fall back to the old
        // default rather than wedging refresh.
        state.activeId = state.tabs[0].id;
      }
    } else if (state.tabs.length === 0) {
      state.activeId = null;
    }
    // Tab-strip wiring:
    //   - onActivate: a tab click must reload the document (openDocument
    //     re-activates an existing tab on the Rust side AND returns its
    //     OpenResult so we can refresh the cached `activeTab` payload).
    //     Without this, refresh() re-mounts using the previously-active
    //     tab's html/threads and the click appears to do nothing.
    //   - onAfterClose: × already called ipc.closeTab; just repaint so
    //     the closed tab disappears and StartPage returns when the last
    //     tab closes.
    mountTabBar(tabbar, ipc, state, {
      onActivate: async (tab) => {
        try {
          const outcome = await ipc.openDocument(tab.path);
          state.activeId = tab.id;
          setActive(outcome);
        } catch (e) {
          // openDocument failure (file deleted, permissions changed) shouldn't
          // wedge the strip — log and refresh so the user sees stale state
          // rather than a frozen window.
          // eslint-disable-next-line no-console
          console.warn('tab activation failed:', e);
        }
        await refresh();
      },
      onAfterClose: () => { void refresh(); },
      // A4: thread the dirtyRegistry read+write surface through so
      // (a) each pill's initial `hidden` reflects the current state and
      // (b) the document-level mdviewer:tab-dirty listener can funnel
      // LiveEditor's transitions back into the same Map.
      getDirtyState,
      setTabDirty,
    });

    // C2: a pending Conflict outcome wins over both StartPage and Document
    // — the user must resolve it before doing anything else. Conflicts
    // can fire even when no tab is registered (the Workspace returns
    // Conflict from open_document before the new tab is constructed),
    // hence this branch sits before the empty-tabs check.
    if (pendingConflict) {
      body.replaceChildren();
      const conflictArgs = pendingConflict;
      const handle = await mountConflict(body, ipc, {
        tabId: conflictArgs.tabId,
        path: conflictArgs.path,
        local: conflictArgs.local,
        incoming: conflictArgs.incoming,
        // Phase B fix #2: thread the Drive context through so the
        // wireframe-07 banner picks the right copy.
        driveSource: conflictArgs.driveSource ?? null,
      });
      void handle;
      // Clear the pending state when the user finishes the merge so a
      // subsequent refresh routes to Document.
      body.addEventListener(
        'conflict-resolved',
        () => {
          pendingConflict = null;
          void refresh();
        },
        { once: true },
      );
      return;
    }

    if (state.tabs.length === 0) {
      // Body holds StartPage in single-pane layout — drop the
      // doc-mode class so the row-flex rules below don't try to
      // split a non-existent doc + sidebar.
      body.classList.remove('with-document');
      await mountStartPage(body, ipc, async (outcome) => {
        // Cache the open-document payload and re-mount so the document
        // (or conflict view) replaces the StartPage. Without this the
        // dialog/recents/file-input flows would silently no-op.
        setActive(outcome);
        await refresh();
      });
      return;
    }

    // Session-restore boot path: Rust restored tabs from session.json,
    // so listOpenDocuments returns them, but the WebView's setActive
    // cache hasn't been primed yet (no setActive call ran). Without
    // this, mountDocument below would render with empty html/threads.
    // Detect "tabs exist but cache is empty" and fetch the active
    // tab's payload via openDocument (idempotent for already-open
    // tabs — Rust just re-activates and returns the cached state).
    // Skip when the active tab has no path (untitled / scratch tabs
    // can't be re-opened by path; the test for that case asserts no
    // IPC call fires).
    if (!activeTab.tabId && state.tabs.length > 0) {
      const activeTabRecord = state.tabs.find((t) => t.id === state.activeId)
        ?? state.tabs[0];
      if (activeTabRecord.path) {
        try {
          const outcome = await ipc.openDocument(activeTabRecord.path);
          setActive(outcome);
          // Bug fix (2025-05-01): the session-restore path never evaluated
          // the Drive-detect toast gate, so users with a previously-opened
          // Drive document never saw the "Connect to Drive?" prompt. Fire
          // a CustomEvent that main.ts subscribes to (avoids importing
          // main.ts from a view module — that would create a cycle).
          document.dispatchEvent(
            new CustomEvent('mdviewer:session-tab-restored', {
              detail: { path: activeTabRecord.path },
            }),
          );
        } catch (e) {
          // Path may have moved/disappeared between sessions. Log and
          // fall through — refresh will mount with empty state, which
          // is at least better than wedging the boot.
          // eslint-disable-next-line no-console
          console.warn('session-restore openDocument failed:', e);
        }
      }
    }

    // Mount a real Document with the cached open-document payload from the
    // most recent openDocument call. The `with-document` class flips the
    // body region into row-flex layout (doc + sidebar). Class-based gate
    // is more reliable across WebViews than CSS `:has()` — the prior rule
    // worked on paper but didn't propagate height correctly in WKWebView.
    body.classList.add('with-document');
    body.replaceChildren();
    // Re-apply the sidebar visibility flag — body.replaceChildren() above
    // doesn't strip body's own `data-sidebar` attribute, but we re-call
    // applySidebarVisibility() so the attribute round-trips on every
    // refresh (matters for the multi-tab case where one refresh might
    // race with a toggle).
    applySidebarVisibility();
    const docRoot = document.createElement('div');
    body.appendChild(docRoot);
    const sidebarRoot = document.createElement('div');
    sidebarRoot.setAttribute('data-region', 'sidebar');
    body.appendChild(sidebarRoot);

    // Floating "Show comments" pill — visible only when sidebar is hidden
    // (CSS rule keys off body[data-sidebar='hidden']). Clicking dispatches
    // the same toggle event so the listener above flips the flag back.
    const showSidebarBtn = document.createElement('button');
    showSidebarBtn.setAttribute('data-test', 'sidebar-show');
    showSidebarBtn.setAttribute('data-action', 'show-sidebar');
    showSidebarBtn.setAttribute('title', 'Show comments sidebar');
    showSidebarBtn.setAttribute('aria-label', 'Show comments sidebar');
    showSidebarBtn.textContent = '💬 Comments';
    showSidebarBtn.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
    });
    body.appendChild(showSidebarBtn);

    // C1: Drive backend + collaborator cache for the active tab. We fetch
    // the collaborator list once per `refresh()` (Drive-backed tabs only)
    // and pass it BOTH to mountCollabChip (sidebar header avatars) AND to
    // mountCommentsSidebar (per-thread author avatars). driveBacking is
    // null on Local tabs (or when DriveDesktop resolution fails — Drive
    // disconnected, path outside any known mount), in which case neither
    // surface renders an avatar.
    const tab = activeTab;
    const driveBacking = await detectDriveBacking(tab.path);
    let collaborators: DriveCollaborator[] = [];
    if (driveBacking) {
      try {
        collaborators = await driveGetCollaborators(driveBacking.fileId);
      } catch {
        // Best-effort: an offline / scope-mismatch / 5xx response shouldn't
        // wedge the sidebar render. The chip stays empty (its own loader
        // path will retry on the next refresh).
        collaborators = [];
      }
    }

    // Sidebar mounter — bundles the chip + comments mount so every refresh
    // re-installs both atomically. Without this, the chip's host would
    // disappear on every threads-changed re-render of the sidebar.
    const remountSidebar = (threads: Thread[], orphans: Thread[]): void => {
      mountCommentsSidebar(sidebarRoot, ipc, threads, {
        showResolved: settings?.comments.show_resolved ?? false,
        orphans,
        activeTabId: tab.tabId ?? state.activeId ?? undefined,
        backend: driveBacking?.backend,
        collaborators,
        // Wire orphan "Delete": call the Rust-side delete_thread IPC (which
        // rewrites the sidecar) and then refresh the sidebar so the card
        // disappears. Without this, OrphanComments dispatches a bubbling
        // `mdviewer:delete-thread` event into the void — the confirm
        // dialog appears, the user clicks OK, nothing happens.
        onDeleteOrphan: (id: string) => {
          const tid = activeTab.tabId ?? state.activeId;
          if (!tid) return;
          void ipc.deleteThread(tid, id).then(refreshThreads);
        },
      });
      if (driveBacking) {
        const sidebarHeader = sidebarRoot.querySelector<HTMLElement>(
          '[data-region="sidebar-header"]',
        );
        if (sidebarHeader && !sidebarHeader.querySelector('.collab-chip')) {
          const chipHost = document.createElement('div');
          sidebarHeader.appendChild(chipHost);
          // Pass a loader that returns the already-cached list so the chip
          // never duplicates the IPC call. This keeps quota usage to one
          // drive_get_collaborators per refresh().
          mountCollabChip(chipHost, {
            fileId: driveBacking.fileId,
            collaboratorsLoader: async () => collaborators,
          });
        }
      }
    };

    // SelectionPopover dispatches `thread-created` on the document root
    // when the user posts a new comment; ThreadDetail dispatches
    // `thread-replied` and `thread-resolved`. All three need the same
    // refresh — re-fetch threads, repaint highlights, re-mount sidebar.
    // `thread-created` ALSO auto-shows the sidebar if it was hidden so the
    // new comment is immediately visible — matches the spec ask.
    const refreshThreads = (): void => {
      void (async () => {
        const tabId = activeTab.tabId ?? state.activeId;
        if (!tabId) return;
        const fresh = await ipc.listThreads(tabId);
        activeTab.threads = fresh;
        await view.refreshHighlights();
        remountSidebar(fresh, view.orphanThreads());
      })();
    };
    docRoot.addEventListener('thread-created', () => {
      if (sidebarHidden) {
        sidebarHidden = false;
        applySidebarVisibility();
      }
      refreshThreads();
    });
    sidebarRoot.addEventListener('thread-replied', refreshThreads);
    sidebarRoot.addEventListener('thread-resolved', refreshThreads);

    const view = await mountDocument(docRoot, ipc, {
      tabId: tab.tabId ?? state.activeId!,
      html: tab.html ?? '',
      threads: tab.threads ?? [],
      source: tab.source,
      path: tab.path,
      settings: settings ?? undefined,
      onOrphansChanged: (orphans) => {
        // Re-mount sidebar when orphan list changes so the orphan
        // section reflects the latest reattachment outcome.
        remountSidebar(tab.threads ?? [], orphans);
      },
    });
    remountSidebar(tab.threads ?? [], view.orphanThreads());

    // Tab-activation font-size hook (A9). Untitled / scratch tabs (no
    // on-disk path) skip the IPC entirely; they get the global default
    // from the cascade and the readout reflects it. For real paths we
    // round-trip getDocPref and apply / clear the inline `--doc-font-size`
    // accordingly so the rendered size and the toolbar number agree.
    if (tab.path) {
      try {
        const pref = await ipc.getDocPref(tab.path);
        activeDocPref = pref;
        if (pref) {
          document.documentElement.style.setProperty(
            '--doc-font-size',
            `${pref.font_size_px}px`,
          );
        } else {
          // Removing rather than setting to the default lets a future
          // Settings change propagate via the CSS fallback without remount.
          document.documentElement.style.removeProperty('--doc-font-size');
        }
      } catch {
        // The doc-prefs IPC isn't available in some test/dev environments;
        // fall through with no override so the cascade still produces a
        // sensible rendered size.
        activeDocPref = null;
        document.documentElement.style.removeProperty('--doc-font-size');
      }
    } else {
      activeDocPref = null;
      document.documentElement.style.removeProperty('--doc-font-size');
    }
    updateReadout();

    // The external-change listener installed above forwards reload events
    // to the active document. We have to round-trip through the IPC's
    // reload_document so the Rust-side `Workspace` re-reads the bytes
    // from disk; without that step the refresh below would re-mount the
    // cached HTML and the user would never see the new content.
    externalListener = (path, action) => {
      if (path !== tab.path) return;
      if (action === 'reload') {
        void (async () => {
          try {
            const fresh = await ipc.reloadDocument(path);
            activeTab.html = fresh.html;
            activeTab.source = fresh.source;
            activeTab.threads = fresh.threads;
          } catch {
            // The reload IPC can fail (file deleted, permissions changed);
            // fall through to a refresh that will redraw whatever cache
            // we still have so the user isn't left looking at a black
            // screen.
          }
          void refresh();
        })();
      }
    };
  }

  /**
   * Public hook used by the StartPage (and the show-conflict event) when
   * openDocument resolves so the Workspace can cache the freshly-loaded
   * payload (Document) or queue the divergence handoff (Conflict).
   *
   * Accepts an enriched conflict outcome — the show-conflict Tauri event
   * (Phase B fix #1+#2) carries `driveSource` for save-time conflicts; the
   * open_document conflict path (Local mtime mismatch) leaves it undefined,
   * which Conflict.ts treats as "omit the Drive banner".
   */
  function setActive(
    outcome: OpenOutcome | (Extract<OpenOutcome, { kind: 'conflict' }> & { driveSource?: DriveConflictSource | null }),
  ): void {
    if (outcome.kind === 'document') {
      activeTab.tabId = outcome.tab_id;
      activeTab.path = outcome.path;
      activeTab.html = outcome.html;
      activeTab.source = outcome.source;
      activeTab.threads = outcome.threads;
      pendingConflict = null;
    } else if (outcome.kind === 'conflict') {
      pendingConflict = {
        tabId: outcome.tab_id,
        path: outcome.path,
        local: outcome.local,
        incoming: outcome.incoming,
        driveSource:
          'driveSource' in outcome ? (outcome.driveSource ?? null) : null,
      };
    }
  }

  // Expose setActive on the workspace root via a property so StartPage's
  // openDocument flow can populate the active tab cache. Kept off the
  // public WorkspaceHandle for now — opening from Recents already drives
  // through ipc.openDocument and a refresh.
  (root as unknown as { __mdv_setActive?: typeof setActive }).__mdv_setActive = setActive;

  // C3 wire-up: Document.ts dispatches `share-requested` when the user
  // clicks the Share toolbar button. Mount the ShareDialog as an overlay
  // inside the body region so it sits on top of the document. Auto-
  // dismiss on `share-exported` (Export succeeded) or `share-dismissed`
  // (Cancel) so the user lands back on the document view.
  body.addEventListener('share-requested', (ev) => {
    const detail = (ev as CustomEvent<{ tabId: string; path: string }>).detail;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('data-region', 'share-overlay');
    body.appendChild(overlay);
    void mountShareDialog(overlay, ipc, {
      tabId: detail.tabId,
      path: detail.path,
      sidecarPattern: settings?.comments.sidecar_pattern,
    });
    const dismiss = () => overlay.remove();
    overlay.addEventListener('share-dismissed', dismiss);
    overlay.addEventListener('share-exported', dismiss);
  });

  // C2: subscribe to the show-conflict event the IPC layer emits when
  // open_document detects divergence. This catches the case where the
  // watcher (B2) fires "external-change" while a tab is already open and
  // the IPC handler re-runs open_document under the covers.
  //
  // Phase B fix #1+#2: save_document also emits show-conflict for Drive
  // save conflicts, with `drive_source` populated. Coerce the wire string
  // ("DriveApiEtag" | "DriveDesktopWatcher") into the TS literal type the
  // Conflict view expects; an unrecognized string falls back to `null` so
  // the banner is suppressed rather than silently mislabeling.
  const COERCE_DRIVE_SOURCE = (
    s: string | null | undefined,
  ): DriveConflictSource | null => {
    if (s === 'DriveApiEtag' || s === 'DriveDesktopWatcher') return s;
    return null;
  };
  try {
    const tauriEvent = await import('@tauri-apps/api/event');
    await tauriEvent.listen<{
      tab_id: string;
      path: string;
      local: string;
      incoming: string;
      drive_source?: string | null;
    }>('show-conflict', (ev) => {
      setActive({
        kind: 'conflict',
        tab_id: ev.payload.tab_id,
        path: ev.payload.path,
        local: ev.payload.local,
        incoming: ev.payload.incoming,
        driveSource: COERCE_DRIVE_SOURCE(ev.payload.drive_source),
      });
      void refresh();
    });
  } catch {
    // No Tauri runtime in jsdom — same fallback as the external-change
    // listener above. The setActive hook is still callable from tests.
  }

  await refresh();
  return { refresh, setActive, setTabDirty, getDirtyState };
}
