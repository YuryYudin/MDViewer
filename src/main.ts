import { invoke } from '@tauri-apps/api/core';
import { tauriIpc, type DocPref, type Settings } from './ipc';
import { mountWorkspace } from './views/Workspace';
import { mountProfileSetup } from './views/ProfileSetup';
import { installKeymap, type Action } from './keymap';
import { installMenuBridge } from './menuBridge';
import './styles/theme.css';
import './styles/app.css';

type AppliedTheme = 'light' | 'dark' | 'follow_system';

/**
 * C2: Shape of the dependencies `maybeShowDriveDetectToast` injects so the
 * unit test can run the predicate without a Tauri runtime AND without
 * dynamic-importing the toast view. Production callers leave both fields
 * undefined; the defaults call `invoke` from `@tauri-apps/api/core` and
 * dynamically import `./views/DriveDetectToast`. This is the same DI shape
 * `runOpenFileFlow` would have used if it had needed test isolation; we
 * only formalise it for this gate because the four-predicate logic has
 * boundary cases (early return order, IPC-skip optimisations) worth
 * covering by themselves.
 */
export interface DriveDetectTriggerDeps {
  invoke?: <T = unknown>(cmd: string, args?: unknown) => Promise<T>;
  /** Replaces the dynamic-import + mountDriveDetectToast call so the unit
   *  test can assert "would-have-mounted" without rendering anything. */
  mount?: (host: HTMLElement, filePath: string) => void;
}

/**
 * Canonical default `DocPref` used when a fresh entry has to be written
 * before any prior pref exists for that file. Centralised so the value
 * tracks `Settings.appearance.font_size_px`'s default rather than drifting
 * apart from a hardcoded literal in the Drive-detect-dismissal write-back.
 * Returns a fresh object on every call so callers can spread-mutate
 * without aliasing the shared default.
 */
export function defaultDocPref(): DocPref {
  return { font_size_px: 14, drive_detect_dismissed: false };
}

/**
 * Decide whether to mount the Drive-detect toast for the just-opened
 * `filePath` and, if so, mount it under `host`. Predicate (all four must
 * hold):
 *
 *   1. The user is not already connected to Drive
 *      (`settings.cloud.drive.connected === false`)
 *   2. The global suppression flag from a prior successful connect is off
 *      (`settings.cloud.drive.detect_toast_suppressed === false`)
 *   3. The file's per-doc-pref dismissal flag is off
 *      (`get_doc_pref(path).drive_detect_dismissed === false`)
 *   4. The file's path resolves to a Drive Desktop mount
 *      (`is_drive_desktop_path(path) === true`)
 *
 * Order matters for cost: the two settings checks are pure in-memory and
 * run first; the IPC roundtrips run only when the cheap gates haven't
 * already disqualified the toast. The `is_drive_desktop_path` IPC is the
 * cheapest of the two (pure path classification, no auth) so it runs
 * before `get_doc_pref` (which hits the JSON store).
 */
export async function maybeShowDriveDetectToast(
  host: HTMLElement,
  filePath: string,
  settings: {
    cloud?: { drive?: { connected?: boolean; detect_toast_suppressed?: boolean; feature_enabled?: boolean } };
  } | null,
  deps: DriveDetectTriggerDeps = {},
): Promise<void> {
  const drive = settings?.cloud?.drive;
  // Opt-in (2025-05-01): the toast is part of the Drive API integration
  // surface. When the user has not opted in (the default), we don't
  // prompt them to connect — they'd just see a Connect button that
  // requires a Google Cloud OAuth client ID they probably can't get.
  if (!drive?.feature_enabled) return;
  // Cheap gates first — both are in-memory reads from the cached settings
  // snapshot. Either one being true means the toast must NOT mount AND we
  // must skip the IPC roundtrips entirely (opening any local file should
  // not pay the cost of two cross-process calls when we already know the
  // toast is suppressed).
  if (drive?.connected) return;
  if (drive?.detect_toast_suppressed) return;

  const doInvoke =
    deps.invoke ??
    (<T>(cmd: string, args?: unknown): Promise<T> => invoke<T>(cmd, args as Record<string, unknown>));

  // Path classifier first (cheap, no auth). When the file isn't on a
  // Drive mount we skip the doc-prefs roundtrip too.
  const onDriveMount = await doInvoke<boolean>('is_drive_desktop_path', { path: filePath });
  if (!onDriveMount) return;

  const docPref = await doInvoke<DocPref | null>('get_doc_pref', { path: filePath });
  if (docPref?.drive_detect_dismissed) return;

  if (deps.mount) {
    deps.mount(host, filePath);
    return;
  }
  const { mountDriveDetectToast } = await import('./views/DriveDetectToast');
  mountDriveDetectToast(host, {
    filePath,
    onDismiss: async (p) => {
      // Read-merge-write: preserve the existing font-size override (the
      // other field on DocPref) so a dismissal doesn't accidentally reset
      // the user's per-document font size to its default. When no prior
      // pref exists we seed from `defaultDocPref()` so the canonical
      // default lives in one place and tracks future changes to the
      // global Settings.appearance.font_size_px default.
      const existing =
        (await doInvoke<DocPref | null>('get_doc_pref', { path: p })) ?? defaultDocPref();
      await doInvoke<void>('set_doc_pref', {
        path: p,
        pref: { ...existing, drive_detect_dismissed: true },
      });
    },
    onConnected: async () => {
      // Read-modify-write the full settings snapshot — set_settings takes
      // the whole struct (see Ipc.setSettings in src/ipc.ts), not a patch.
      const current = await doInvoke<Settings>('get_settings');
      const next: Settings = {
        ...current,
        cloud: {
          ...current.cloud,
          drive: { ...current.cloud.drive, detect_toast_suppressed: true },
        },
      };
      await doInvoke<void>('set_settings', { settings: next });
    },
  });
}

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
  // Pre-paint the cool variant from cache so the FOUC window doesn't briefly
  // flash the Pure palette before settings load.
  const cachedDarkVariant = localStorage.getItem('mdviewer.darkVariant') ?? 'pure';
  document.body.classList.toggle('theme-cool', cachedDarkVariant === 'cool');

  const root = document.getElementById('app');
  if (!root) throw new Error('#app element missing from index.html');

  const settings: Settings = await tauriIpc.getSettings();

  let currentTheme: AppliedTheme = settings.appearance.theme;

  const applyTheme = (theme: AppliedTheme, darkVariant?: 'pure' | 'cool'): void => {
    currentTheme = theme;
    const dark =
      theme === 'dark' ||
      (theme === 'follow_system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-follow-system', theme === 'follow_system');
    if (darkVariant !== undefined) {
      document.body.classList.toggle('theme-cool', darkVariant === 'cool');
      localStorage.setItem('mdviewer.darkVariant', darkVariant);
    }
    localStorage.setItem('mdviewer.theme', dark ? 'dark' : 'light');
  };
  applyTheme(currentTheme, settings.appearance.dark_variant);

  // Re-apply the dark variant whenever Settings dispatches its post-save
  // event so flipping Pure ↔ Cool in the Settings panel takes effect
  // without a reload.
  document.addEventListener('mdviewer:settings-changed', (ev: Event) => {
    const next = (ev as CustomEvent<Settings>).detail;
    if (next?.appearance) {
      applyTheme(next.appearance.theme, next.appearance.dark_variant);
    }
  });

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

  // Bug fix (2025-05-01): Workspace.ts dispatches this when the
  // session-restore boot path opens the previously-active tab. Without
  // this listener, users who quit the app while viewing a Drive document
  // never saw the "Connect to Drive?" toast on the next start because
  // session restore bypassed the runOpenFileFlow path that fires the gate.
  document.addEventListener('mdviewer:session-tab-restored', (ev) => {
    const path = (ev as CustomEvent<{ path: string }>).detail?.path;
    if (!path) return;
    void (async () => {
      try {
        const settings = await tauriIpc.getSettings();
        await maybeShowDriveDetectToast(document.body, path, settings);
      } catch (err) {
        console.warn('drive-detect toast gate (session-restore) failed:', err);
      }
    })();
  });

  // Open-from-Drive entry point. The native menu bridge translates the
  // `open-from-drive` menu id into this CustomEvent (see menuBridge.ts).
  // The view is loaded dynamically so unit tests that don't exercise the
  // modal don't pay its parse cost. Same lazy-mount pattern as the
  // Settings overlay above.
  document.addEventListener('mdviewer:open-from-drive', () => {
    void (async () => {
      try {
        const { mountOpenFromDrive } = await import('./views/OpenFromDrive');
        mountOpenFromDrive();
      } catch (err) {
        console.warn('open-from-drive flow failed:', err);
      }
    })();
  });

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
    // C2: after the document is mounted, evaluate the four-predicate gate
    // and (if all four pass) prompt the user to connect to Drive. Fire-
    // and-forget so a failure in the gate IPCs (`is_drive_desktop_path` or
    // `get_doc_pref`) doesn't break the open flow itself — the toast is a
    // suggestion, not a requirement.
    void maybeShowDriveDetectToast(document.body, picked, await tauriIpc.getSettings()).catch(
      (err) => console.warn('drive-detect toast gate failed:', err),
    );
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

  // Rust emits `workspace-changed` when a path enters the workspace from
  // outside the WebView's own IPC flow — macOS RunEvent::Opened (Phase 2)
  // and tauri-plugin-single-instance second invocations (Phase 3). Both
  // already mutated Workspace state on the Rust side; the frontend just
  // needs to re-fetch and repaint. Fire-and-forget; if the runtime is
  // missing (jsdom unit tests), the import fails silently.
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      await listen('workspace-changed', () => {
        if (workspace) void workspace.refresh();
      });
    } catch {
      // No Tauri runtime — skip (unit tests stub the bridge anyway).
    }
  })();

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
        // Mirror the production runOpenFileFlow path (C2): evaluate the
        // Drive-detect toast gate after the e2e harness opens a document
        // so specs that exercise the toast surface see the same trigger
        // logic as a real `+`-button open.
        void maybeShowDriveDetectToast(
          document.body,
          absPath,
          await tauriIpc.getSettings(),
        ).catch((err) => console.warn('drive-detect toast gate failed:', err));
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
      async emitMenuAction(action: string): Promise<void> {
        // The OS menu can't be driven by tauri-webdriver-automation, so
        // tests fire the bus event directly. The bundled event module
        // resolves via Vite's specifier handling; an inline `import()`
        // from the WebDriver execute_async sandbox would NOT resolve
        // because that script isn't part of the bundle.
        const { emit } = await import('@tauri-apps/api/event');
        await emit('menu-action', action);
      },
      fireKeymapAction(action: 'font_increase' | 'font_decrease' | 'font_reset'): void {
        // tauri-webdriver-automation does not deliver the W3C Meta key
        // through `browser.keys(['Meta', '='])` (the actions JSON sent
        // has `keyDown value: ""` — the harness drops the modifier).
        // Hook bypasses the keyboard pipeline by calling dispatchAction
        // directly with the same action the keymap canonicalization
        // would have produced for `Mod+=` / `Mod+-` / `Mod+0`. Keymap
        // unit tests cover the key→action mapping (including the
        // shifted-symbol fold); this hook lets the e2e suite cover the
        // listener → applyFontDelta → IPC chain on the real WebView.
        dispatchAction(action);
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
      case 'font_increase':
        // Three distinct event names (no payload) instead of one + delta —
        // the menuBridge contract is `{ actionString -> eventName }` with
        // no detail; widening it to carry a payload was rejected in the
        // design doc, so the keymap and the menu bridge converge on the
        // same three CustomEvents.
        document.dispatchEvent(new CustomEvent('mdviewer:font-increase'));
        break;
      case 'font_decrease':
        document.dispatchEvent(new CustomEvent('mdviewer:font-decrease'));
        break;
      case 'font_reset':
        document.dispatchEvent(new CustomEvent('mdviewer:font-reset'));
        break;
    }
  };
  installKeymap(settings, dispatchAction);

  // Native menu bridge — fires the same mdviewer:* CustomEvents the keymap
  // does, so File → Open / Settings… reach the existing handlers without
  // any per-view wiring. Fire and forget; the bridge resolves to a no-op
  // when no Tauri runtime is present (unit tests, dev preview).
  void installMenuBridge();
}

// Auto-run only when loaded as the production entry point. Tests import
// `main` directly and provide their own settings stubs.
if ((import.meta as unknown as { env?: Record<string, string> }).env?.MODE !== 'test') {
  main().catch((err) => {
    document.body.append(`Bootstrap error: ${err}`);
  });
}
