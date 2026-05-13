import type { Ipc } from '../ipc';
import type { WorkspaceState } from './Workspace';

/**
 * Render the tab strip into `root` based on the supplied workspace state.
 *
 * Each tab is a button. Clicking the body activates the tab; clicking the
 * inner "x" closes it (with stopPropagation so closing doesn't also
 * activate). A trailing "+" button is provided for opening a new file
 * (the host wires it to the same handler StartPage uses).
 *
 * Tab labels show the file's basename (the regression: we were rendering
 * the opaque tab id, which surfaced a UUID instead of the filename). The
 * full path lives on `title` for hover.
 *
 * Two callbacks distinguish the two flows because they need different
 * follow-up wiring:
 *
 * - `onActivate(tab)` — must re-load the document. Workspace caches the
 *   active tab's payload (html, threads, source); without re-loading via
 *   `openDocument`, the view re-renders the previous doc on refresh and
 *   the click appears to do nothing.
 * - `onAfterClose()` — TabBar already called `ipc.closeTab`; the host
 *   only needs to repaint the strip.
 *
 * Tab labels use `textContent` so a malicious file path cannot inject markup.
 */
export interface TabBarCallbacks {
  /** Called after the user clicks a tab body. The host should activate
   * the tab AND refresh the cached document payload (typically by calling
   * `ipc.openDocument(tab.path)` then re-mounting). */
  onActivate?: (tab: { id: string; path: string }) => void | Promise<void>;
  /** Called after `ipc.closeTab` resolves. The host repaints. */
  onAfterClose?: () => void | Promise<void>;
  /**
   * A4: read the current dirty bit for a tab path. Threaded in by the
   * Workspace so each pill renders the correct initial `hidden` state on
   * its `.tab-dirty` first child. Without this, a TabBar re-render
   * (close/open/switch) would erase the dirty indicator the user just
   * saw — the registry is the persistent source of truth, this is the
   * read channel. Defaults to "always clean" when omitted, which is the
   * pre-A4 behavior.
   */
  getDirtyState?: (path: string) => boolean;
  /**
   * A4: update the workspace's dirty registry. The TabBar's document-level
   * `mdviewer:tab-dirty` listener calls this on every event so the registry
   * stays in sync; subsequent re-renders pick it up via `getDirtyState`.
   * One-way flow: producer (LiveEditor → CustomEvent) → consumer
   * (TabBar listener → registry update). Defaults to no-op when omitted.
   */
  setTabDirty?: (path: string, dirty: boolean) => void;
}

/**
 * Module-level handle on the previous mount's tab-dirty listener so a
 * re-mount tears down the prior closure before installing a fresh one.
 * mountTabBar runs on every Workspace.refresh() — without this, every
 * refresh leaves an additional listener on `document` and a single
 * `mdviewer:tab-dirty` dispatch would mutate the registry N times.
 */
let prevTabDirtyTeardown: (() => void) | undefined;

export function mountTabBar(
  root: HTMLElement,
  ipc: Ipc,
  state: WorkspaceState,
  callbacks?: TabBarCallbacks,
): void {
  // Tear down any prior mount's document-level listener before we install
  // the new one. The closure captures `strip` and `setTabDirty` from the
  // previous mount, which would otherwise outlive their scope.
  prevTabDirtyTeardown?.();
  prevTabDirtyTeardown = undefined;

  root.replaceChildren();
  const strip = document.createElement('div');
  strip.setAttribute('data-test', 'tabbar');
  strip.className = 'tabbar';

  const getDirtyState = callbacks?.getDirtyState ?? (() => false);
  const setTabDirty = callbacks?.setTabDirty ?? (() => undefined);

  for (const tab of state.tabs) {
    const btn = document.createElement('button');
    btn.setAttribute('data-test', 'tab');
    btn.setAttribute('data-tab-id', tab.id);
    btn.setAttribute('data-active', String(tab.id === state.activeId));
    btn.className = 'tab' + (tab.id === state.activeId ? ' active' : '');
    btn.title = tab.path;
    // A4: expose the path via dataset so the document-level
    // mdviewer:tab-dirty listener can look up the matching pill by
    // direct string equality. (Attribute selectors would require CSS-
    // escaping every special char in a path — colons, dots, backslashes,
    // spaces, brackets all need escaping; direct string equality dodges
    // the issue entirely.)
    btn.dataset.path = tab.path;

    // A4: dirty indicator as the FIRST child of the pill. The wireframe
    // and e2e spec key off `[data-testid="tab-dirty"]`; visibility uses
    // the HTML `hidden` attribute (matches the spec's `.isExisting()`
    // / `.isDisplayed()` checks) rather than CSS-only `display: none`.
    const dot = document.createElement('span');
    dot.className = 'tab-dirty';
    dot.setAttribute('data-testid', 'tab-dirty');
    if (!getDirtyState(tab.path)) {
      dot.setAttribute('hidden', '');
    }
    btn.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'tab-label';
    // textContent prevents path-based markup injection. Basename is the
    // user-facing label — the full path is exposed via the title tooltip.
    label.textContent = basename(tab.path);
    btn.appendChild(label);

    const close = document.createElement('span');
    close.setAttribute('data-test', 'tab-close');
    close.className = 'x';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void (async () => {
        await ipc.closeTab(tab.id);
        if (callbacks?.onAfterClose) await callbacks.onAfterClose();
      })();
    });
    btn.appendChild(close);

    btn.addEventListener('click', () => {
      // The Rust-side activate is delegated to the host's `onActivate`
      // callback because activation typically requires re-loading the
      // document (openDocument) — calling activateTab(id) alone updates
      // Rust's active id but does NOT refresh the host's cached payload,
      // so the rendered doc stays stale.
      void (async () => {
        if (callbacks?.onActivate) {
          await callbacks.onActivate({ id: tab.id, path: tab.path });
        } else {
          // Defensive fallback when no host wiring is provided (unit tests
          // that exercise just the dispatch). Mirrors prior behavior.
          await ipc.activateTab(tab.id);
        }
      })();
    });
    strip.appendChild(btn);
  }

  const add = document.createElement('button');
  add.setAttribute('data-test', 'new-tab');
  add.className = 'tab new';
  add.textContent = '+';
  add.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:open-file'));
  });
  strip.appendChild(add);

  root.appendChild(strip);

  // A4: document-level mdviewer:tab-dirty listener. LiveEditor dispatches
  // this on first user input (dirty:true) and after a successful save
  // (dirty:false). We funnel the value into the registry via the
  // `setTabDirty` callback (so a future re-render reads the correct
  // state) and then toggle `hidden` on the matching pill in-place — no
  // full re-render needed. Pill lookup is by direct dataset.path string
  // equality inside a `querySelectorAll('[data-test="tab"]')` walk,
  // NOT a CSS attribute selector: paths with colons, dots, backslashes,
  // spaces, or brackets would all need CSS escaping and direct equality
  // dodges that entirely.
  const onTabDirty = (ev: Event): void => {
    const ce = ev as CustomEvent<{ path: string; dirty: boolean }>;
    const detail = ce.detail;
    if (!detail || typeof detail.path !== 'string') return;
    setTabDirty(detail.path, detail.dirty);
    strip.querySelectorAll<HTMLElement>('[data-test="tab"]').forEach((pill) => {
      if (pill.dataset.path !== detail.path) return;
      const dot = pill.firstElementChild as HTMLElement | null;
      if (!dot) return;
      if (detail.dirty) dot.removeAttribute('hidden');
      else dot.setAttribute('hidden', '');
    });
  };
  document.addEventListener('mdviewer:tab-dirty', onTabDirty);
  prevTabDirtyTeardown = () => {
    document.removeEventListener('mdviewer:tab-dirty', onTabDirty);
  };
}

function basename(p: string): string {
  // Strip trailing slashes (defensive — the IPC sends file paths but a
  // future caller passing a directory shouldn't show "" as the label).
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
