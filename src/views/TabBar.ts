import type { Ipc, WindowSummary } from '../ipc';
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

  // "Move to Window ▸" — E1 populates the submenu from list_windows, listing
  // only OTHER open windows (the current window is excluded — moving a tab to
  // its own window is a no-op the user shouldn't be offered). Each target is
  // labeled by the window's active_doc_name (with a placeholder when none).
  // Picking a target calls move_tab(tab_id, to_window); a rejection toasts +
  // refreshes rather than crashing.
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
  moveItem.appendChild(submenu);
  menu.appendChild(moveItem);
  // Populate asynchronously: list_windows is an IPC round-trip. The menu is
  // already mounted (D2 structure), so we fill the submenu rows when they
  // arrive. Failures here leave the item disabled rather than crashing.
  void populateMoveToWindow(moveItem, submenu, ipc, tab, dismiss, callbacks);

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

/**
 * E1: fill the Move-to-Window submenu with one row per OTHER open window.
 *
 * - Calls `list_windows` (D1) and filters out the current window so the user
 *   can't "move" a tab to the window it already lives in. We identify the
 *   current window by `getCurrentWindow().label`; under jsdom (unit tests) the
 *   API is mocked, and in a no-runtime context the resolver returns null so we
 *   fall back to the WindowSummary.focused flag.
 * - Each row is labeled by the target's `active_doc_name` (a placeholder when
 *   the window has no document) and carries `data-window-label` for the e2e
 *   spec / move dispatch.
 * - Picking a row dismisses the menu and invokes `move_tab(tab_id, to_window)`.
 *   On rejection it toasts the error and refreshes the source strip
 *   (`onAfterClose`) so the UI re-syncs with backend truth.
 * - When there are no other windows, the Move-to-Window item is disabled
 *   (greyed) per wireframe 03's single-window edge case.
 */
async function populateMoveToWindow(
  moveItem: HTMLElement,
  submenu: HTMLElement,
  ipc: Ipc,
  tab: { id: string; path: string },
  dismiss: () => void,
  callbacks?: TabBarCallbacks,
): Promise<void> {
  let windows: WindowSummary[];
  let currentLabel: string | null;
  try {
    [windows, currentLabel] = await Promise.all([ipc.listWindows(), currentWindowLabel()]);
  } catch {
    // Couldn't enumerate windows — leave the item disabled rather than crash.
    disableMoveItem(moveItem);
    return;
  }

  // OTHER windows only. Prefer an explicit current-label match; if we couldn't
  // resolve the label (no runtime), fall back to excluding the focused window
  // (the IPC layer fills `focused`).
  const others = windows.filter((w) =>
    currentLabel != null ? w.label !== currentLabel : !w.focused,
  );

  if (others.length === 0) {
    disableMoveItem(moveItem);
    return;
  }

  for (const w of others) {
    const row = document.createElement('div');
    row.setAttribute('data-test', 'move-target');
    row.setAttribute('role', 'menuitem');
    row.setAttribute('data-window-label', w.label);
    row.className = 'item';
    const span = document.createElement('span');
    span.className = 'item-label';
    // textContent guards against a doc name containing markup. The placeholder
    // keeps an empty window pickable (and non-blank) in the list.
    span.textContent = w.active_doc_name ?? 'Empty window';
    row.appendChild(span);
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dismiss();
      void moveTabToWindow(ipc, tab, w.label, callbacks);
    });
    submenu.appendChild(row);
  }
}

/** Grey out the Move-to-Window item (single-window edge case). */
function disableMoveItem(moveItem: HTMLElement): void {
  moveItem.classList.add('disabled');
  moveItem.setAttribute('aria-disabled', 'true');
}

/**
 * Invoke `move_tab(tab_id, to_window)`. The relocate fires window-addressed
 * `workspace-changed` events (B2 emits to both source and target) that the
 * boot-time listeners refresh on — so on success we don't repaint here. On
 * rejection (unknown tab/window, etc.) we toast the error and refresh the
 * source strip via `onAfterClose` so the UI matches backend truth.
 */
async function moveTabToWindow(
  ipc: Ipc,
  tab: { id: string; path: string },
  toWindow: string,
  callbacks?: TabBarCallbacks,
): Promise<void> {
  try {
    await ipc.moveTab(tab.id, toWindow);
  } catch (e) {
    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', {
        detail: { message: `Move failed: ${errorText(e)}`, level: 'error' },
      }),
    );
    if (callbacks?.onAfterClose) await callbacks.onAfterClose();
  }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  return String(e);
}

/**
 * Resolve this window's label via the Tauri window API, loaded lazily and
 * guarded so jsdom unit tests (which mock `@tauri-apps/api/window`) and any
 * no-runtime context don't throw. Returns null when the runtime is absent —
 * the caller then falls back to the WindowSummary.focused flag.
 */
async function currentWindowLabel(): Promise<string | null> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    return getCurrentWindow().label;
  } catch {
    return null;
  }
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
