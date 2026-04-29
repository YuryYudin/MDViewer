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

  if (!settings.profile.display_name) {
    await mountProfileSetup(root, tauriIpc);
  } else {
    await mountWorkspace(root, tauriIpc);
  }

  const dispatchAction = (action: Action): void => {
    switch (action) {
      case 'open_file':
        document.querySelector<HTMLInputElement>('[data-test="file-input"]')?.click();
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
