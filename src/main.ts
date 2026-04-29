import { tauriIpc, type Settings } from './ipc';
import { mountWorkspace } from './views/Workspace';
import { mountProfileSetup } from './views/ProfileSetup';
import { installKeymap, type Action } from './keymap';
import './styles/theme.css';
import './styles/app.css';

type AppliedTheme = 'light' | 'dark' | 'follow_system';

/**
 * Bootstrap the WebView shell.
 *
 * - Apply the cached theme synchronously to avoid a flash of unstyled
 *   content while we wait for `get_settings` to round-trip.
 * - Reconcile the cached theme with the persisted theme as soon as settings
 *   arrive.
 * - Mount ProfileSetup if the user has no display_name yet, otherwise
 *   Workspace.
 * - Install the keymap from `settings.shortcuts`.
 */
export async function main(): Promise<void> {
  const cachedTheme = (localStorage.getItem('mdviewer.theme') ?? 'light') as 'light' | 'dark';
  document.body.classList.toggle('theme-dark', cachedTheme === 'dark');

  const root = document.getElementById('app');
  if (!root) throw new Error('#app element missing from index.html');

  const settings: Settings = await tauriIpc.getSettings();

  let currentTheme: AppliedTheme = settings.appearance.theme;

  const applyTheme = (theme: AppliedTheme): void => {
    currentTheme = theme;
    const dark =
      theme === 'dark' ||
      (theme === 'follow_system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-follow-system', theme === 'follow_system');
    localStorage.setItem('mdviewer.theme', dark ? 'dark' : 'light');
  };
  applyTheme(currentTheme);

  // Settings overlay: mounted on `mdviewer:open-settings` (dispatched by
  // the keymap's `open_settings` action and the StartPage button) and
  // unmounted on `mdviewer:close-settings` (the Settings view's close
  // button bubbles this back). Pre-Phase-A this routing was missing,
  // making the Settings view effectively unreachable.
  document.addEventListener('mdviewer:open-settings', () => {
    let overlay = document.querySelector<HTMLElement>('[data-region="settings-overlay"]');
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.setAttribute('data-region', 'settings-overlay');
    overlay.className = 'modal-overlay settings-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('mdviewer:close-settings', () => overlay!.remove());
    void (async () => {
      const { mountSettings } = await import('./views/Settings');
      await mountSettings(overlay!, tauriIpc);
    })();
  });

  let workspace: Awaited<ReturnType<typeof mountWorkspace>> | null = null;
  async function mountWorkspaceAndStash(): Promise<void> {
    workspace = await mountWorkspace(root!, tauriIpc);
  }

  // Global "open another document" entry point. The TabBar's "+" button
  // and the open_file keymap action both dispatch this, plus StartPage
  // dispatches it from its Open button so the three paths converge on
  // a single dialog flow. Without this listener "+" was a dead button
  // (Screenshot regression).
  document.addEventListener('mdviewer:open-file', () => {
    // Wrap so a dialog/import failure (jsdom has no __TAURI_INTERNALS__,
    // a real-runtime failure surfaces an Error, etc.) doesn't escalate
    // into an unhandled rejection that crashes the WebView console or
    // poisons unit-test runs.
    runOpenFileFlow().catch((err) => {
      console.warn('open-file flow failed:', err);
    });
  });

  async function runOpenFileFlow(): Promise<void> {
    const w = window as unknown as {
      __WEBDRIVER__?: unknown;
      __mdviewerE2E?: { nextPick?: string };
    };
    let picked: string | null = null;
    if (w.__WEBDRIVER__) {
      // tauri-webdriver-automation can't drive the OS dialog. Specs set
      // window.__mdviewerE2E.nextPick = absPath right before clicking the
      // "+" button; we consume it once and proceed.
      const next = w.__mdviewerE2E?.nextPick;
      if (typeof next === 'string') {
        picked = next;
        if (w.__mdviewerE2E) delete w.__mdviewerE2E.nextPick;
      }
    } else {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const result = await openDialog({
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
        multiple: false,
      });
      if (typeof result === 'string') picked = result;
    }
    if (!picked) return;
    const outcome = await tauriIpc.openDocument(picked);
    const setActive = (root as unknown as {
      __mdv_setActive?: (o: typeof outcome) => void;
    }).__mdv_setActive;
    if (setActive) setActive(outcome);
    if (workspace) await workspace.refresh();
  }
  if (!settings.profile.display_name) {
    await mountProfileSetup(root, tauriIpc);
    // ProfileSetup fires `mdviewer:profile-saved` on success but doesn't
    // own routing — wire the transition to Workspace here so the user
    // doesn't need a manual reload.
    document.addEventListener(
      'mdviewer:profile-saved',
      () => { void mountWorkspaceAndStash(); },
      { once: true },
    );
  } else {
    await mountWorkspaceAndStash();
  }

  // E2E side-channel: tauri-webdriver-automation can't drive the OS file
  // dialog and `setValue` on a <input type=file> uploads file *contents*
  // (not a path) — but openDocument needs an absolute path string. Expose
  // a minimal hook on `window` so specs can drive the open flow without
  // round-tripping through DOM file inputs. Only attached when the
  // WebDriver bridge is present, so production builds never expose it.
  if (typeof window !== 'undefined' && (window as unknown as { __WEBDRIVER__?: unknown }).__WEBDRIVER__) {
    (window as unknown as Record<string, unknown>).__mdviewerE2E = {
      async open(absPath: string): Promise<void> {
        const outcome = await tauriIpc.openDocument(absPath);
        const setActive = (root as unknown as {
          __mdv_setActive?: (o: typeof outcome) => void;
        }).__mdv_setActive;
        if (setActive) setActive(outcome);
        if (workspace) await workspace.refresh();
      },
      async importComments(tabId: string, incomingPath: string): Promise<void> {
        await tauriIpc.importComments({ tabId, incomingPath });
        // Re-fetching threads happens lazily on the next refresh, but the
        // sidebar reads from the workspace's cached activeTab.threads —
        // dispatch the same `thread-replied` event Workspace listens for
        // so it re-fetches the merged store and re-mounts.
        document
          .querySelector('[data-region="sidebar"]')
          ?.dispatchEvent(new CustomEvent('thread-replied', { bubbles: true }));
      },
    };
  }

  const dispatchAction = (action: Action): void => {
    switch (action) {
      case 'open_file':
        // Was: click the StartPage file-input. That only existed when
        // StartPage was mounted, so the shortcut died once a doc was open.
        // The mdviewer:open-file listener above handles both phases.
        document.dispatchEvent(new CustomEvent('mdviewer:open-file'));
        break;
      case 'save_file':
        document.dispatchEvent(new CustomEvent('mdviewer:save-active'));
        break;
      case 'toggle_edit':
        document.dispatchEvent(new CustomEvent('mdviewer:toggle-edit'));
        break;
      case 'comment_on_selection':
        document.dispatchEvent(new CustomEvent('mdviewer:comment-on-selection'));
        break;
      case 'toggle_sidebar':
        document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
        break;
      case 'resolve_thread':
        document.dispatchEvent(new CustomEvent('mdviewer:resolve-focused-thread'));
        break;
      case 'close_tab':
        document.dispatchEvent(new CustomEvent('mdviewer:close-tab'));
        break;
      case 'open_settings':
        document.dispatchEvent(new CustomEvent('mdviewer:open-settings'));
        break;
      case 'toggle_dark':
        applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
        break;
    }
  };
  installKeymap(settings, dispatchAction);
}

// Auto-run only when loaded as the production entry point. Tests import
// `main` directly and provide their own settings stubs.
if ((import.meta as unknown as { env?: Record<string, string> }).env?.MODE !== 'test') {
  main().catch((err) => {
    document.body.append(`Bootstrap error: ${err}`);
  });
}
