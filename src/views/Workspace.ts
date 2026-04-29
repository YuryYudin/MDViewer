import type { Ipc, OpenOutcome, Settings, Thread } from '../ipc';
import { mountStartPage } from './StartPage';
import { mountTabBar } from './TabBar';
import { mountDocument } from './Document';
import { mountCommentsSidebar } from './CommentsSidebar';
import { mountConflict } from './Conflict';
import { mountShareDialog } from './ShareDialog';

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
  root.replaceChildren();
  const shell = document.createElement('div');
  shell.setAttribute('data-view', 'workspace');
  shell.className = 'workspace';
  for (const region of ['titlebar', 'tabbar', 'body', 'status']) {
    const el = document.createElement('div');
    el.setAttribute('data-region', region);
    // The status region also serves as wireframe-03's status-bar; expose
    // it via data-view so spec selectors (and CSS theming) can target it
    // by purpose, not just position.
    if (region === 'status') el.setAttribute('data-view', 'status-bar');
    if (region === 'titlebar') el.setAttribute('data-view', 'titlebar');
    if (region === 'tabbar') el.setAttribute('data-view', 'tabs');
    shell.appendChild(el);
  }
  root.appendChild(shell);

  // Static title in the titlebar; the active tab path will be wired in by
  // A10 once Document.ts owns the active doc.
  const titlebar = shell.querySelector<HTMLElement>('[data-region="titlebar"]')!;
  const titleText = document.createElement('span');
  titleText.className = 'title';
  titleText.textContent = 'MDViewer';
  titlebar.appendChild(titleText);

  const status = shell.querySelector<HTMLElement>('[data-region="status"]')!;
  const statusText = document.createElement('span');
  statusText.textContent = 'Ready';
  status.appendChild(statusText);
  // Display the user's profile chip in the status bar (wireframe 03/05).
  // Settings are loaded inside refresh() but we need a placeholder element
  // present immediately so spec assertions on shape (not value) don't race.
  const userName = document.createElement('span');
  userName.setAttribute('data-test', 'user-name');
  userName.className = 'profile-chip';
  status.appendChild(userName);

  const state: WorkspaceState = { tabs: [], activeId: null };
  const tabbar = shell.querySelector<HTMLElement>('[data-region="tabbar"]')!;
  const body = shell.querySelector<HTMLElement>('[data-region="body"]')!;

  // Cache the active tab's data the most recent open_document call gave us
  // so refresh() doesn't have to re-open just to re-render.
  const activeTab: { tabId?: string; path?: string; source?: string; threads?: Thread[]; html?: string } = {};
  // C2: when the most recent OpenOutcome was a Conflict, refresh() routes
  // to Conflict.ts instead of Document.ts. Cleared when a Document outcome
  // arrives or when the user finishes the merge.
  let pendingConflict: { tabId: string; path: string; local: string; incoming: string } | null = null;
  let settings: Settings | null = null;

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
    const ids = await ipc.listOpenDocuments();
    state.tabs = ids.map((id) => ({ id, path: id }));
    state.activeId = state.tabs.length > 0 ? (state.activeId ?? state.tabs[0].id) : null;
    mountTabBar(tabbar, ipc, state);

    // C2: a pending Conflict outcome wins over both StartPage and Document
    // — the user must resolve it before doing anything else. Conflicts
    // can fire even when no tab is registered (the Workspace returns
    // Conflict from open_document before the new tab is constructed),
    // hence this branch sits before the empty-tabs check.
    if (pendingConflict) {
      body.replaceChildren();
      const conflictArgs = pendingConflict;
      const handle = await mountConflict(body, ipc, conflictArgs);
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
      await mountStartPage(body, ipc, async (outcome) => {
        // Cache the open-document payload and re-mount so the document
        // (or conflict view) replaces the StartPage. Without this the
        // dialog/recents/file-input flows would silently no-op.
        setActive(outcome);
        await refresh();
      });
      return;
    }

    // Mount a real Document with the cached open-document payload from the
    // most recent openDocument call. If we don't have one (active tab
    // changed without a re-open), the placeholder is acceptable until the
    // user re-opens.
    body.replaceChildren();
    const docRoot = document.createElement('div');
    body.appendChild(docRoot);
    const sidebarRoot = document.createElement('div');
    sidebarRoot.setAttribute('data-region', 'sidebar');
    body.appendChild(sidebarRoot);

    // SelectionPopover dispatches `thread-created` on the document root
    // when the user posts a new comment; ThreadDetail dispatches
    // `thread-replied` and `thread-resolved`. All three need the same
    // refresh — re-fetch threads, repaint highlights, re-mount sidebar.
    const refreshThreads = (): void => {
      void (async () => {
        const tabId = activeTab.tabId ?? state.activeId;
        if (!tabId) return;
        const fresh = await ipc.listThreads(tabId);
        activeTab.threads = fresh;
        await view.refreshHighlights();
        mountCommentsSidebar(sidebarRoot, ipc, fresh, {
          showResolved: settings?.comments.show_resolved ?? false,
          orphans: view.orphanThreads(),
          activeTabId: tabId,
        });
      })();
    };
    docRoot.addEventListener('thread-created', refreshThreads);
    sidebarRoot.addEventListener('thread-replied', refreshThreads);
    sidebarRoot.addEventListener('thread-resolved', refreshThreads);

    const tab = activeTab;
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
        mountCommentsSidebar(sidebarRoot, ipc, tab.threads ?? [], {
          showResolved: settings?.comments.show_resolved ?? false,
          orphans,
          activeTabId: tab.tabId ?? state.activeId ?? undefined,
        });
      },
    });
    mountCommentsSidebar(sidebarRoot, ipc, tab.threads ?? [], {
      showResolved: settings?.comments.show_resolved ?? false,
      orphans: view.orphanThreads(),
      activeTabId: tab.tabId ?? state.activeId ?? undefined,
    });

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
   */
  function setActive(outcome: OpenOutcome): void {
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
  try {
    const tauriEvent = await import('@tauri-apps/api/event');
    await tauriEvent.listen<{ tab_id: string; path: string; local: string; incoming: string }>(
      'show-conflict',
      (ev) => {
        setActive({ kind: 'conflict', ...ev.payload });
        void refresh();
      },
    );
  } catch {
    // No Tauri runtime in jsdom — same fallback as the external-change
    // listener above. The setActive hook is still callable from tests.
  }

  await refresh();
  return { refresh, setActive };
}
