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
      void closeTabAndRepaint(ipc, tab, callbacks);
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

    // D2: per-tab right-click context menu (wireframe 02-tab-context-menu).
    // An in-DOM menu — not the native/OS menu — so it is testable in
    // Vitest/WebdriverIO and styleable via app.css. preventDefault on the
    // contextmenu event suppresses the browser/OS menu; stopPropagation
    // keeps the same event from immediately tripping the document-level
    // outside-click dismissal below.
    btn.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openTabContextMenu(root, ipc, tab, callbacks);
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

/**
 * Shared close path used by both the inline × affordance and the context
 * menu's "Close" item. TabBar performs the Rust-side `closeTab`, then signals
 * the host to repaint the strip via `onAfterClose` (the host owns the refresh
 * because TabBar can't re-run Workspace.refresh() on its own).
 */
async function closeTabAndRepaint(
  ipc: Ipc,
  tab: { id: string; path: string },
  callbacks?: TabBarCallbacks,
): Promise<void> {
  await ipc.closeTab(tab.id);
  if (callbacks?.onAfterClose) await callbacks.onAfterClose();
}

/**
 * D2: build and mount the in-DOM tab context menu (wireframe
 * 02-tab-context-menu.html). Items, classes, and data-test hooks mirror the
 * wireframe so app.css can style it and e2e/unit tests can target it.
 *
 * - "Open in New Window" → `ipc.openInNewWindow(tab.path)`. The backend
 *   relocates the document under the one-owner invariant and raises the new
 *   window; the source strip refreshes (the host's `onAfterClose`-style
 *   repaint is not needed here because the relocate fires a window/tab event
 *   E-phase wiring listens to — D2 only owns the menu + invoke).
 * - "Move to Window ▸" → SCAFFOLD ONLY. An empty submenu placeholder is
 *   rendered; E1 populates it from `list_windows`. We deliberately do NOT
 *   list windows here (listing the current window as a move target would be
 *   wrong, and the data isn't available until E1).
 * - "Close" → the shared `closeTabAndRepaint` path (same as the × button).
 *
 * Only one menu exists at a time: any prior menu is removed first. The menu
 * dismisses on item activation and on an outside click.
 */
function openTabContextMenu(
  root: HTMLElement,
  ipc: Ipc,
  tab: { id: string; path: string },
  callbacks?: TabBarCallbacks,
): void {
  // Tear down any menu already open (e.g. right-clicking a second tab).
  dismissTabContextMenu(root);

  const floating = document.createElement('div');
  floating.setAttribute('data-test', 'tab-context-menu-layer');
  floating.className = 'floating tab-context-menu-layer';

  const menu = document.createElement('div');
  menu.setAttribute('data-test', 'tab-context-menu');
  menu.setAttribute('role', 'menu');
  menu.className = 'menu';

  const dismiss = (): void => dismissTabContextMenu(root);

  const openItem = makeMenuItem('Open in New Window', 'ctx-open-new-window');
  openItem.addEventListener('click', () => {
    dismiss();
    void ipc.openInNewWindow(tab.path);
  });
  menu.appendChild(openItem);

  // "Move to Window ▸" — scaffold only. E1 populates the submenu from
  // list_windows; here it is an empty placeholder so the structure (and its
  // data-test hooks) exist for styling and for E1 to fill.
  const moveItem = makeMenuItem('Move to Window', 'ctx-move-to-window');
  moveItem.classList.add('hot');
  moveItem.setAttribute('aria-haspopup', 'true');
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = '▸';
  moveItem.appendChild(caret);
  const submenu = document.createElement('div');
  submenu.setAttribute('data-test', 'move-to-window-submenu');
  submenu.setAttribute('role', 'menu');
  submenu.className = 'menu submenu';
  // Intentionally empty — E1 fills it. No move-target rows here.
  moveItem.appendChild(submenu);
  menu.appendChild(moveItem);

  const sep = document.createElement('div');
  sep.className = 'sep';
  menu.appendChild(sep);

  const closeItem = makeMenuItem('Close', 'ctx-close');
  closeItem.classList.add('danger');
  closeItem.addEventListener('click', () => {
    dismiss();
    void closeTabAndRepaint(ipc, tab, callbacks);
  });
  menu.appendChild(closeItem);

  floating.appendChild(menu);
  root.appendChild(floating);

  // Dismiss on the next outside click. Registered on the next tick via
  // `capture` so the very click that could bubble up doesn't immediately
  // close the freshly-opened menu. Re-querying inside the handler keeps the
  // listener idempotent if the menu was already torn down.
  const onDocClick = (ev: MouseEvent): void => {
    if (!floating.contains(ev.target as Node)) {
      dismissTabContextMenu(root);
    }
  };
  // Stash the listener so dismiss can detach it.
  (floating as MenuLayer).__onDocClick = onDocClick;
  document.addEventListener('click', onDocClick, true);
}

interface MenuLayer extends HTMLElement {
  __onDocClick?: (ev: MouseEvent) => void;
}

function dismissTabContextMenu(root: HTMLElement): void {
  const existing = root.querySelector<MenuLayer>('.tab-context-menu-layer');
  if (!existing) return;
  if (existing.__onDocClick) {
    document.removeEventListener('click', existing.__onDocClick, true);
  }
  existing.remove();
}

function makeMenuItem(label: string, testId: string): HTMLElement {
  const item = document.createElement('div');
  item.setAttribute('data-test', testId);
  item.setAttribute('role', 'menuitem');
  item.className = 'item';
  const span = document.createElement('span');
  span.className = 'item-label';
  // textContent guards against any future label that contains markup.
  span.textContent = label;
  item.appendChild(span);
  return item;
}

function basename(p: string): string {
  // Strip trailing slashes (defensive — the IPC sends file paths but a
  // future caller passing a directory shouldn't show "" as the label).
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}
