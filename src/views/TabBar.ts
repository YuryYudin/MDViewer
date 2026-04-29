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
 * Tab labels use `textContent` so a malicious file path cannot inject markup.
 */
export function mountTabBar(root: HTMLElement, ipc: Ipc, state: WorkspaceState): void {
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

    const label = document.createElement('span');
    label.className = 'tab-label';
    // textContent prevents path-based markup injection.
    label.textContent = tab.path;
    btn.appendChild(label);

    const close = document.createElement('span');
    close.setAttribute('data-test', 'tab-close');
    close.className = 'x';
    close.textContent = '×';
    close.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void ipc.closeTab(tab.id);
    });
    btn.appendChild(close);

    btn.addEventListener('click', () => {
      void ipc.activateTab(tab.id);
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
