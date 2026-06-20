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
 * C1 (printing): derive the Export-to-PDF save dialog's `defaultPath` from the
 * active document's source path. When the path has a local parent directory we
 * default to `<dir>/<stem>.pdf` (the document's own folder); for an untitled or
 * remote document (no local parent — an `ssh://`/`drive://`-style URL, or a
 * bare name), we fall back to just `<stem>.pdf` so the dialog opens in the
 * platform default save directory with a sensible name.
 *
 * Splits on both `/` and `\` so a Windows path round-trips. `stem` strips a
 * single trailing extension (`notes.md` → `notes`); a name with no extension
 * keeps as-is (`README` → `README`).
 */
export function defaultPdfPath(sourcePath: string): string {
  // A remote/untitled doc has no usable local parent — detect a scheme-style
  // prefix (e.g. `ssh://`, `drive://`, `https://`) and drop the directory.
  const isRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(sourcePath);
  const sep = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\'));
  const dir = sep >= 0 ? sourcePath.slice(0, sep) : '';
  const name = sep >= 0 ? sourcePath.slice(sep + 1) : sourcePath;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const fileName = `${stem || 'document'}.pdf`;
  if (isRemote || dir === '') return fileName;
  return `${dir}/${fileName}`;
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

  // C2: File → New Window. The native menu (B3) emits `menu-action`
  // ("new-window") to the focused window; the menu bridge fans that out as
  // the `mdviewer:new-window` CustomEvent, which we turn into the `new_window`
  // IPC (registered by C1) that spawns a fresh window on the StartPage. We
  // invoke it RAW via `@tauri-apps/api/core`'s `invoke` rather than a typed
  // `ipc.ts` binding because that binding lands in D1; `core:default` permits
  // app commands so the raw call is the correct surface today. Fire-and-
  // forget with a catch so a spawn failure (OS/Tauri) surfaces in the console
  // instead of an unhandled rejection.
  document.addEventListener('mdviewer:new-window', () => {
    void invoke('new_window').catch((err) => {
      console.warn('new-window flow failed:', err);
    });
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
  // D1 (printing): when launched as the headless `mdviewer --export-pdf`
  // one-shot runtime, ALWAYS mount the Workspace (which renders the opened
  // export-input document) — never the profile-setup gate. A headless export
  // has no interactive user to fill the profile form, and the gate would
  // otherwise leave the DOM blank so `mdviewer:render-complete` never fires and
  // the export hangs. Guarded so a missing `headless_export_active` command (or
  // no Tauri runtime in tests) defaults to the normal interactive path.
  let headlessExport = false;
  try {
    headlessExport = await invoke<boolean>('headless_export_active');
  } catch {
    headlessExport = false;
  }
  if (!headlessExport && !settings.profile.display_name) {
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

  // C2: window-addressed event routing (contract 04-window-addressed-events).
  // Under multi-window the backend (B2) addresses each event to the specific
  // window that owns the affected document via `app.emit_to(<label>, …)`
  // rather than broadcasting. So we resolve THIS window's identity once at
  // boot (`getCurrentWindow().label`) and subscribe via the window-scoped
  // `getCurrentWindow().listen(...)` — NOT the broadcast global `listen` —
  // so a sibling window's change never double-refreshes us.
  //
  // Loaded lazily + guarded so jsdom unit tests (no Tauri runtime) skip the
  // subscription; tests that DO exercise routing mock `@tauri-apps/api/window`.
  void (async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const thisWindow = getCurrentWindow();
      // Resolve the boot label (used for diagnostics + to make the
      // window-scoped contract explicit). Reading it here also forces the
      // getCurrentWindow() call that the addressed-event contract hinges on.
      const windowLabel = thisWindow.label;
      void windowLabel;

      // G2 (multi-window e2e): each window's own main.ts runs on boot, so
      // every window self-reports its label here. The e2e `switchToWindow`
      // helper reads `window.__mdviewerE2E.windowLabel` from each WebDriver
      // handle to find the one matching a given label — replacing the old
      // `window.__TAURI__...getCurrentWebviewWindow().label` path, which is
      // unavailable because `withGlobalTauri` is OFF. Guarded on the e2e
      // side-channel's presence so production boot is unaffected. The
      // side-channel object is populated synchronously below (before this
      // async import resolves) on `__WEBDRIVER__` builds.
      const e2e = (window as unknown as { __mdviewerE2E?: Record<string, unknown> }).__mdviewerE2E;
      if (e2e) e2e.windowLabel = windowLabel;

      // `workspace-changed`: this window's tab set changed from outside its
      // own IPC flow (CLI / second-instance open into it, Drive/SSH open,
      // move_tab). Rust already mutated Workspace state; we just re-fetch
      // and repaint our own tabs.
      await thisWindow.listen('workspace-changed', () => {
        if (workspace) void workspace.refresh();
      });

      // `show-conflict` / `external-change`: addressed to the window owning
      // the affected tab. The Workspace view installs its own handlers for
      // routing to the Conflict view / reload banner; we register no-op
      // window-scoped subscriptions here so the boot contract (subscribe to
      // every addressed event on THIS window) is satisfied and the
      // Workspace's listeners only ever see this window's events.
      await thisWindow.listen('show-conflict', () => {
        // Workspace.ts owns the routing; this subscription documents that
        // the event is window-addressed and keeps the boot surface complete.
      });
      await thisWindow.listen('external-change', () => {
        // Likewise owned by Workspace.ts's watcher banner path.
      });

      // `confirm-window-close`: the OS titlebar close was intercepted by the
      // backend (B2 `CloseRequested` guard) because a tab in THIS window is
      // dirty. Run the save-or-discard confirm, then drive the backend close
      // via `close_window` so the prevented close can proceed.
      await thisWindow.listen('confirm-window-close', () => {
        void confirmWindowClose();
      });
    } catch {
      // No Tauri runtime — skip (unit tests stub the bridge anyway).
    }
  })();

  // C2: save-or-discard confirm for a dirty window close. The backend
  // prevented the OS close while a dirty tab exists; we ask the user, flush
  // the active editor's pending bytes when they choose to save, and then call
  // `close_window` (raw invoke; the typed binding lands in D1) so the
  // backend completes the close it had deferred. Cancel leaves the window
  // open and does NOT call close_window.
  async function confirmWindowClose(): Promise<void> {
    const save = window.confirm(
      'This window has unsaved changes. Save and close?\n\n' +
        'OK saves and closes; Cancel keeps the window open.',
    );
    if (!save) return;
    // Flush the active editor via the canonical save event (Document.ts's
    // `mdviewer:save-document` handler force-flushes the dirty buffer). It's
    // a no-op outside Edit mode, which is fine — a clean tab needs no flush.
    document.dispatchEvent(new CustomEvent('mdviewer:save-document'));
    try {
      await invoke('close_window');
    } catch (err) {
      console.warn('close_window failed:', err);
    }
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
      /**
       * B5 / specs 21/23/24: drive an `ssh://` URL open through the same
       * pipeline a real CLI argv would. Mirrors the production sshOpenUrl
       * → openDocument(cache_path) handoff (see Workspace.openPathOrUrl)
       * so the resulting tab is byte-identical to what the user would get
       * via the StartPage "Open from remote…" button. On failure we
       * surface the verbatim transport stderr through the toast region
       * (spec 21 host-key-changed / spec 24 askpass-cancel both poll
       * `[data-region="toast"]`) and re-throw so callers see the
       * rejection too.
       */
      async openSshUrl(url: string): Promise<void> {
        try {
          const summary = await tauriIpc.sshOpenUrl(url);
          const outcome = await tauriIpc.openDocument(summary.path);
          const setActive = (root as unknown as {
            __mdv_setActive?: (o: typeof outcome) => void;
          }).__mdv_setActive;
          if (setActive) setActive(outcome);
          if (workspace) await workspace.refresh();
        } catch (err) {
          // The transport's verbatim stderr (host-key-verification-failed,
          // Permission denied, auth cancelled, etc.) is the user-visible
          // contract. Dispatch a toast event so the global toast region
          // (mounted in Workspace) can render it.
          const message = err instanceof Error ? err.message : String(err);
          document.dispatchEvent(
            new CustomEvent('mdviewer:toast', { detail: { message } }),
          );
          throw err;
        }
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
      async dispatchCli(args: string[]): Promise<void> {
        // E2 (S8): the OS can't shell a second `mdviewer foo.md` invocation
        // under WebDriver, so the spec drives the running-app CLI dispatch by
        // emitting `e2e-dispatch-cli` with the argv. The Rust setup() listener
        // (debug-only) routes it through the real
        // parse_positional_args → dispatch_cli_targets focused-window path.
        const { emit } = await import('@tauri-apps/api/event');
        await emit('e2e-dispatch-cli', JSON.stringify(args));
      },
      /**
       * G2 (multi-window e2e): spawn a native window with the EXACT label
       * via the `e2e_create_window` IPC (registered only under
       * `--features e2e`). We invoke RAW via `@tauri-apps/api/core` — the
       * same path `mdviewer:new-window` uses — rather than reaching for
       * `window.__TAURI__`, which is undefined here because `withGlobalTauri`
       * is OFF (the app bundles `@tauri-apps/api`). The returned promise
       * resolves once the backend has spawned + registered the window; the
       * helper then polls `switchToWindow(label)` until the new window's own
       * boot reports its `windowLabel` (set below).
       */
      createWindow(label: string): Promise<void> {
        return invoke<void>('e2e_create_window', { label });
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
        // B5: spec contract — specs 23/24 dispatch `mdviewer:save-document`
        // to drive the save flow. Renamed from the legacy `save-active`
        // name; the menu bridge converges on the same event name below.
        document.dispatchEvent(new CustomEvent('mdviewer:save-document'));
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
      case 'print':
        // B1 (printing): the menu bridge fans the `menu-print` click out as
        // `mdviewer:print` too; the keymap path converges on the same event
        // so the listener below is the single place window.print() is called.
        document.dispatchEvent(new CustomEvent('mdviewer:print'));
        break;
    }
  };
  installKeymap(settings, dispatchAction);

  // B1 (printing): File → Print… / Cmd-Ctrl+P. Both the native menu bridge
  // and the keymap converge on `mdviewer:print`. Guard on whether a document
  // is actually mounted — the Workspace flips `with-document` on the body
  // region only when a real Document view is shown (not the StartPage). With
  // no document open we no-op and surface a toast rather than printing a
  // blank StartPage. The @media print CSS (Phase A) restricts the printout to
  // the active document content.
  document.addEventListener('mdviewer:print', () => {
    const body = document.querySelector('[data-region="body"]');
    const hasDocument = body?.classList.contains('with-document') ?? false;
    if (hasDocument) {
      window.print();
    } else {
      document.dispatchEvent(
        new CustomEvent('mdviewer:toast', {
          detail: { message: 'No document to print' },
        }),
      );
    }
  });

  // C1 (printing): File → Export to PDF… → `mdviewer:export-pdf`. Resolve the
  // active document, open the native save dialog defaulting to `<stem>.pdf`
  // (in the document's folder when local; platform default dir otherwise),
  // then invoke `export_pdf` and report the outcome via the toast surface.
  // The whole flow is wrapped so a dialog/IPC failure never escalates into an
  // unhandled rejection (the WebView console / unit-test runner would surface
  // it). Cancel (save returns null) returns early with NO invoke and NO toast.
  document.addEventListener('mdviewer:export-pdf', () => {
    runExportPdfFlow().catch((err) => {
      // Defence-in-depth: runExportPdfFlow already maps every expected failure
      // into a toast; this catch guards against an unexpected throw outside the
      // inner try/catch (e.g. the dialog import rejecting).
      console.warn('export-pdf flow failed:', err);
    });
  });

  async function runExportPdfFlow(): Promise<void> {
    // Resolve the active document the same way the rest of main.ts does:
    // the active tab id + the open-document list, matched on id.
    const activeId = await tauriIpc.getActiveTabId();
    const docs = await tauriIpc.listOpenDocuments();
    const active = activeId ? docs.find((d) => d.id === activeId) : undefined;
    if (!active) {
      // No document to export — export-specific wording (the Print path uses
      // its own "No document to print" message; the Rust command-side guard
      // uses "No document is open" — three layers, consistent in intent).
      document.dispatchEvent(
        new CustomEvent('mdviewer:toast', {
          detail: { message: 'No document to export' },
        }),
      );
      return;
    }

    const defaultPath = defaultPdfPath(active.path);

    // Resolve the target path. Under WebDriver the native save dialog can't be
    // driven, so specs set `window.__mdviewerE2E.nextSavePath` (or null to
    // simulate cancel) before emitting; we consume it once. Production opens
    // the real `@tauri-apps/plugin-dialog` save() dialog.
    const w = window as unknown as {
      __WEBDRIVER__?: unknown;
      __mdviewerE2E?: {
        nextSavePath?: string | null;
        lastExportDefaultPath?: string;
      };
    };
    let target: string | null = null;
    if (w.__WEBDRIVER__) {
      // Record the computed default for the spec to assert S6 (the dialog
      // would default to `<stem>.pdf`). The native save dialog itself can't be
      // driven by tauri-webdriver-automation, so this side-channel exposes the
      // exact `defaultPath` the production `save()` call below would receive.
      if (w.__mdviewerE2E) w.__mdviewerE2E.lastExportDefaultPath = defaultPath;
      const next = w.__mdviewerE2E?.nextSavePath;
      target = typeof next === 'string' ? next : null;
      if (w.__mdviewerE2E && 'nextSavePath' in w.__mdviewerE2E) {
        delete w.__mdviewerE2E.nextSavePath;
      }
    } else {
      const { save } = await import('@tauri-apps/plugin-dialog');
      target = await save({
        defaultPath,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
    }

    // Cancel: no invoke, no toast.
    if (!target) return;

    try {
      const written = await tauriIpc.exportPdf(target);
      document.dispatchEvent(
        new CustomEvent('mdviewer:toast', {
          detail: { message: `Exported to ${written}` },
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      document.dispatchEvent(
        new CustomEvent('mdviewer:toast', { detail: { message } }),
      );
    }
  }

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
