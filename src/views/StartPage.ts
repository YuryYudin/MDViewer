import type { Ipc, OpenOutcome } from '../ipc';

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
/**
 * `onOpened` is invoked with the OpenOutcome after every successful
 * `ipc.openDocument` call (button, file input, or recents). Workspace
 * passes a callback that caches the outcome via setActive() and re-runs
 * its refresh — without this hook the StartPage's three open-paths
 * silently discarded the result and the WebView stayed on the start
 * screen even after the dialog returned a path.
 */
export async function mountStartPage(
  root: HTMLElement,
  ipc: Ipc,
  onOpened?: (outcome: OpenOutcome) => void | Promise<void>,
): Promise<void> {
  // Read settings + recents up-front so the layout is one-shot — no
  // mid-render IPC churn.
  const [settings, recents] = await Promise.all([
    ipc.getSettings().catch(() => undefined),
    ipc.listRecents().catch(() => [] as Awaited<ReturnType<Ipc['listRecents']>>),
  ]);

  root.replaceChildren();
  const view = document.createElement('section');
  view.setAttribute('data-view', 'start');

  // Centered "stack" (matches wireframe-01's `.stack`): heading,
  // subtitle, recents list, then a row of three action buttons.
  const stack = document.createElement('div');
  stack.className = 'stack';
  view.appendChild(stack);

  // Personalized welcome — the wireframe reads "Welcome back, Mira".
  // Falls back to the generic copy when the user hasn't set a name yet
  // (first-launch ProfileSetup is responsible for filling that in).
  const heading = document.createElement('h2');
  heading.setAttribute('data-test', 'welcome-heading');
  const displayName = settings?.profile?.display_name?.trim() ?? '';
  heading.textContent = displayName
    ? `Welcome back, ${displayName}`
    : 'Welcome to MDViewer';
  stack.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'sub';
  sub.textContent =
    'Open a markdown file to start reading or commenting. MDViewer keeps comments in a sidecar file next to the document, so the .md itself stays untouched.';
  stack.appendChild(sub);

  // Recents list — wireframe-01 row shape: filename (bold), tilde-path
  // (mono dim), "when" relative time. Hidden entirely when there's no
  // recents to suppress an empty-bordered card.
  if (recents.length > 0) {
    const list = document.createElement('div');
    list.setAttribute('data-test', 'recents');
    list.className = 'recent-list';
    for (const entry of recents) {
      const item = document.createElement('div');
      item.setAttribute('data-test', 'recent-item');
      item.dataset.path = entry.path;
      item.className = 'recent-item';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'name';
      name.setAttribute('data-test', 'recent-name');
      name.textContent = basename(entry.path);
      const path = document.createElement('div');
      path.className = 'path';
      path.setAttribute('data-test', 'recent-path');
      path.textContent = withTilde(entry.path);
      left.append(name, path);

      // A11: SSH badge — wireframe-01 specifies a small "SSH" text pill on
      // remote entries so the user can tell at a glance which row will
      // trigger an SSH auth round-trip. The predicate is the RecentEntry
      // .kind field (added by A10), NOT a startswith on entry.path — a
      // future tweak to how SSH paths are stringified can't drift the UI
      // without also drifting the badge.
      if (entry.kind === 'ssh') {
        const badge = document.createElement('span');
        badge.className = 'recents-badge recents-badge--ssh';
        badge.setAttribute('aria-label', 'Remote file');
        badge.textContent = 'SSH';
        left.appendChild(badge);
      }

      const when = document.createElement('div');
      when.className = 'when';
      when.setAttribute('data-test', 'recent-when');
      when.textContent = entry.mtime != null ? relativeTime(Number(entry.mtime)) : '—';

      item.append(left, when);
      item.addEventListener('click', () => {
        void (async () => {
          const outcome = await ipc.openDocument(entry.path);
          if (onOpened) await onOpened(outcome);
        })();
      });
      list.appendChild(item);
    }
    stack.appendChild(list);
  }

  // Hidden file input — only used by e2e where the OS dialog is undriveable.
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.md,.markdown,text/markdown';
  fileInput.setAttribute('data-test', 'file-input');
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    const p = fileInput.value || (f as unknown as { path?: string }).path || f.name;
    const outcome = await ipc.openDocument(p);
    if (onOpened) await onOpened(outcome);
  });

  // Action row: Open · New document · Settings (wireframe order).
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.setAttribute('data-test', 'startpage-actions');

  const open = document.createElement('button');
  open.setAttribute('data-action', 'open-file');
  open.className = 'primary';
  open.textContent = 'Open file…';
  open.addEventListener('click', async () => {
    if (isE2eMode()) {
      fileInput.click();
      return;
    }
    const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
    const picked = await openDialog({
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      multiple: false,
    });
    if (typeof picked === 'string') {
      const outcome = await ipc.openDocument(picked);
      if (onOpened) await onOpened(outcome);
    }
  });

  const newDoc = document.createElement('button');
  newDoc.setAttribute('data-action', 'new-document');
  newDoc.textContent = 'New document';
  newDoc.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:new-document'));
  });

  const settingsBtn = document.createElement('button');
  settingsBtn.setAttribute('data-action', 'open-settings');
  settingsBtn.textContent = 'Settings…';
  settingsBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:open-settings'));
  });

  actions.append(open, newDoc, settingsBtn);
  stack.appendChild(actions);
  view.appendChild(fileInput);

  root.appendChild(view);
}

// ---------------------------------------------------------------------------
// Path/time helpers — kept colocated with the only consumer rather than a
// shared utils file. They're small, single-purpose, and have no other caller.
// ---------------------------------------------------------------------------

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function withTilde(p: string): string {
  // Replace the user's HOME prefix with ~ so paths read as wireframe
  // examples ("~/Documents/...") on macOS / Linux. Detection is best-
  // effort: we look for the conventional `/Users/<name>/` and `/home/<name>/`
  // prefixes since the WebView has no access to process.env.HOME.
  const m = p.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(\/.*)?$/);
  return m ? `~${m[2] ?? ''}` : p;
}

function relativeTime(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixSeconds);
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 86_400) {
    const h = Math.floor(diff / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (diff < 86_400 * 2) return 'Yesterday';
  if (diff < 86_400 * 7) {
    const d = Math.floor(diff / 86_400);
    return `${d} days ago`;
  }
  // Older than a week → absolute date "Mar 14".
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
