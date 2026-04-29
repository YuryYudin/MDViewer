import type { Ipc } from '../ipc';

/**
 * Detects whether we're running under WebdriverIO + tauri-driver. In that
 * mode the OS file dialog is undriveable, so the Open button delegates to a
 * hidden `<input type="file">` instead. The flag flows in via Vite's
 * `import.meta.env` (set by the e2e launcher) OR via a `window.__MDVIEWER_E2E`
 * stub used by unit tests, which jsdom can mutate freely.
 */
function isE2eMode(): boolean {
  const fromEnv = (import.meta as unknown as { env?: Record<string, string> }).env?.MDVIEWER_E2E;
  if (fromEnv === '1') return true;
  if (typeof window !== 'undefined') {
    const w = window as unknown as { __MDVIEWER_E2E?: boolean; __WEBDRIVER__?: unknown };
    if (w.__MDVIEWER_E2E) return true;
    // tauri-webdriver-automation injects window.__WEBDRIVER__ as a non-
    // configurable property; its presence is a reliable signal we're under
    // the e2e harness on macOS, where the OS file dialog can't be driven.
    if (w.__WEBDRIVER__) return true;
  }
  return false;
}

/**
 * Mount the start page into `root`. Matches wireframe 01:
 *   - recent-files list (clickable items)
 *   - "Open…" primary button
 *   - "Settings" button
 *
 * Production: clicking Open shows the native file dialog via
 * `@tauri-apps/plugin-dialog`. Under WebdriverIO + tauri-driver the dialog
 * cannot be driven, so we also expose a hidden `<input type="file">` and gate
 * the click-redirect on `import.meta.env.MDVIEWER_E2E === '1'`.
 */
export async function mountStartPage(root: HTMLElement, ipc: Ipc): Promise<void> {
  root.replaceChildren();
  const view = document.createElement('section');
  view.setAttribute('data-view', 'start');

  const heading = document.createElement('h2');
  heading.textContent = 'Welcome to MDViewer';
  view.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent =
    'Open a markdown file to start reading or commenting. MDViewer keeps comments in a sidecar file next to the document, so the .md itself stays untouched.';
  view.appendChild(sub);

  // Hidden file input — declared first so the click handler below can refer
  // to it even though it appears later in the DOM order.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.md,.markdown,text/markdown';
  fileInput.setAttribute('data-test', 'file-input');
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    // Under WebdriverIO + tauri-driver, browser.uploadFile(...) returns an
    // absolute path that the runner places into the input's value field;
    // reading it back yields that absolute path. In a regular browser the
    // value would be a basename only, but in production we never reach this
    // handler because the click handler below takes the dialog path.
    const path = fileInput.value || (f as unknown as { path?: string }).path || f.name;
    await ipc.openDocument(path);
  });

  const open = document.createElement('button');
  open.setAttribute('data-action', 'open-file');
  open.className = 'primary';
  open.textContent = 'Open…';
  open.addEventListener('click', async () => {
    if (isE2eMode()) {
      // E2E path: tests trigger the hidden input directly; clicking the
      // visible button still opens the input so keyboard-only flows work.
      fileInput.click();
      return;
    }
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const picked = await openDialog({
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      multiple: false,
    });
    if (typeof picked === 'string') {
      await ipc.openDocument(picked);
    }
  });
  view.appendChild(open);

  const settings = document.createElement('button');
  settings.setAttribute('data-action', 'open-settings');
  settings.textContent = 'Settings';
  settings.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:open-settings'));
  });
  view.appendChild(settings);

  view.appendChild(fileInput);

  const recents = await ipc.listRecents();
  const list = document.createElement('ul');
  list.setAttribute('data-test', 'recents');
  for (const path of recents) {
    const li = document.createElement('li');
    li.setAttribute('data-test', 'recent-item');
    // textContent prevents path-based markup injection.
    li.textContent = path;
    li.addEventListener('click', () => {
      void ipc.openDocument(path);
    });
    list.appendChild(li);
  }
  view.appendChild(list);

  root.appendChild(view);
}
