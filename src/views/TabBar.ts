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
}

export function mountTabBar(
  root: HTMLElement,
  ipc: Ipc,
  state: WorkspaceState,
  callbacks?: TabBarCallbacks,
): void {
  root.replaceChildren();
  const strip = document.createElement('div');
  strip.setAttribute('data-test', 'tabbar');
  strip.className = 'tabbar';

  for (const tab of state.tabs) {
    const btn = document.createElement('button');
    btn.setAttribute('data-test', 'tab');
    btn.setAttribute('data-tab-id', tab.id);
    btn.setAttribute('data-active', String(tab.id === state.activeId));
    btn.className = 'tab' + (tab.id === state.activeId ? ' active' : '');
    btn.title = tab.path;

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
}

function basename(p: string): string {
  // Strip trailing slashes (defensive — the IPC sends file paths but a
  // future caller passing a directory shouldn't show "" as the label).
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
