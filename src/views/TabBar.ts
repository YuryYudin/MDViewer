import type { Ipc } from '../ipc';
import type { WorkspaceState } from './Workspace';

/**
 * Render the tab strip into `root` based on the supplied workspace state.
 *
 * Each tab is a button that calls `ipc.activateTab(id)` on click. A small "x"
 * inside each tab calls `ipc.closeTab(id)` and stops propagation so closing a
 * tab does not also activate it. A trailing "+" button is provided for
 * opening a new file (the host wires it to the same handler StartPage uses).
 *
 * Tab labels show the file's basename (the regression: we were rendering
 * the opaque tab id, which surfaced a UUID instead of the filename). The
 * full path lives on `title` for hover.
 *
 * `onAfterChange` is fired after activate / close IPCs resolve so the
 * caller (Workspace) can repaint — without this, clicking × removed the
 * tab on the Rust side but left the stale strip on screen.
 *
 * Tab labels use `textContent` so a malicious file path cannot inject markup.
 */
export function mountTabBar(
  root: HTMLElement,
  ipc: Ipc,
  state: WorkspaceState,
  onAfterChange?: () => void | Promise<void>,
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
        if (onAfterChange) await onAfterChange();
      })();
    });
    btn.appendChild(close);

    btn.addEventListener('click', () => {
      void (async () => {
        await ipc.activateTab(tab.id);
        if (onAfterChange) await onAfterChange();
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
