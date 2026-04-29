import type { Ipc } from '../ipc';
import { mountStartPage } from './StartPage';
import { mountTabBar } from './TabBar';

export interface WorkspaceState {
  tabs: { id: string; path: string }[];
  activeId: string | null;
}

export interface WorkspaceHandle {
  refresh(): Promise<void>;
}

/**
 * Mount the workspace shell: titlebar / tabbar / body / status. The body
 * routes between StartPage (when no documents are open) and a Document
 * placeholder (when at least one is). Document.ts (A10), Settings.ts (A11),
 * and Conflict.ts (C2) replace the placeholder when those tasks land.
 */
export async function mountWorkspace(root: HTMLElement, ipc: Ipc): Promise<WorkspaceHandle> {
  root.replaceChildren();
  const shell = document.createElement('div');
  shell.setAttribute('data-view', 'workspace');
  shell.className = 'workspace';
  for (const region of ['titlebar', 'tabbar', 'body', 'status']) {
    const el = document.createElement('div');
    el.setAttribute('data-region', region);
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

  const state: WorkspaceState = { tabs: [], activeId: null };
  const tabbar = shell.querySelector<HTMLElement>('[data-region="tabbar"]')!;
  const body = shell.querySelector<HTMLElement>('[data-region="body"]')!;

  async function refresh(): Promise<void> {
    const ids = await ipc.listOpenDocuments();
    state.tabs = ids.map((id) => ({ id, path: id }));
    state.activeId = state.tabs.length > 0 ? (state.activeId ?? state.tabs[0].id) : null;
    mountTabBar(tabbar, ipc, state);
    if (state.tabs.length === 0) {
      await mountStartPage(body, ipc);
    } else {
      // TODO(A10/A11/C2): replace this placeholder with Document/Settings/Conflict
      // routing keyed off the active tab kind.
      body.replaceChildren();
      const placeholder = document.createElement('div');
      placeholder.setAttribute('data-view', 'document');
      placeholder.textContent = 'Document view (mounted by A10)';
      body.appendChild(placeholder);
    }
  }

  await refresh();
  return { refresh };
}
