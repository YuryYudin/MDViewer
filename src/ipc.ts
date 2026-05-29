import { invoke } from '@tauri-apps/api/core';

// Re-export every IPC type from the generated file. Hand-writing them here
// would re-introduce the Rust↔TS drift that broke earlier plan iterations.
export type {
  BuildInfo,
  ProfileSettings,
  AppearanceSettings,
  EditorSettings,
  CommentsSettings,
  AdvancedSettings,
  Settings,
  Theme,
  DarkVariant,
  ExternalChangeBehavior,
  AutoMergeMode,
  RenderOptions,
  RenderResult,
  Anchor,
  ResolveOutcome,
  Comment,
  Thread,
  NewComment,
  NewThread,
  OpenResult,
  OpenOutcome,
  Hunk,
  HunkKind,
  ExportResult,
  RecentEntry,
  TabSummary,
  DocPref,
  // D1: per-window summary returned by list_windows (label + active_doc_name +
  // tab_count + focused).
  WindowSummary,
  // B2: typed save_document outcome — Ok{etag} | Conflict{local,remote,drive_source}.
  SaveOutcome,
  // A8: Drive integration types — re-exported here so callers don't need
  // to know whether a type lives in ./types-generated or in a Drive view.
  TabBackend,
  DriveStatus,
  DriveCollaborator,
  BackendMode,
  DriveSettings,
  CloudSettings,
} from './types-generated';

import type {
  BuildInfo,
  Settings,
  Anchor,
  ResolveOutcome,
  Thread,
  OpenOutcome,
  OpenResult,
  RenderResult,
  Hunk,
  ExportResult,
  RecentEntry,
  TabSummary,
  DocPref,
  DriveStatus,
  DriveCollaborator,
  SaveOutcome,
  WindowSummary,
} from './types-generated';

// `Anchor` is the canonical name across the wire. Older planning notes used
// `AnchorPayload`; alias here for clarity.
export type AnchorPayload = Anchor;

export interface Ipc {
  appInfo(): Promise<BuildInfo>;
  openDocument(path: string): Promise<OpenOutcome>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  /**
   * Returns one entry per open tab with both the opaque id (for activate /
   * close) and the on-disk path (for the tab label). Returning bare ids
   * was the regression where tab titles rendered the UUID.
   */
  listOpenDocuments(): Promise<TabSummary[]>;
  /**
   * Returns the id of the currently-active tab on the Rust side, or null
   * when no tab is active (StartPage). The WebView's Workspace uses this
   * on boot — without it, the session-restore path defaults state.activeId
   * to the first tab even when Rust restored a different active tab from
   * session.json.
   */
  getActiveTabId(): Promise<string | null>;
  listRecents(): Promise<RecentEntry[]>;
  getSettings(): Promise<Settings>;
  setSettings(s: Settings): Promise<void>;
  listThreads(tabId: string): Promise<Thread[]>;
  createThread(tabId: string, anchor: Anchor, body: string): Promise<Thread>;
  postReply(tabId: string, threadId: string, body: string): Promise<void>;
  resolveThread(tabId: string, threadId: string): Promise<void>;
  /** Drop a thread (and its comments) from the sidecar. Used by the
   *  orphan-list "Delete" affordance; the on-disk sidecar is rewritten
   *  before the promise resolves. */
  deleteThread(tabId: string, threadId: string): Promise<void>;
  renderMarkdown(source: string): Promise<RenderResult>;
  resolveAnchor(tabId: string, anchor: Anchor): Promise<ResolveOutcome>;
  /**
   * Save the contents of an open tab. The Rust handler dispatches on the
   * tab's `backend`:
   *
   *   * `Local`        — atomic write to the on-disk path (the original
   *                      Phase-2 `save_document(path, contents)` semantics
   *                      under a new envelope shape).
   *   * `DriveApi`     — uploads to Drive with `If-Match: <etag>`. A 412
   *                      precondition failure surfaces as
   *                      `SaveOutcome.Conflict` (routed to Conflict.ts).
   *   * `DriveDesktop` — wired by B5 to the watcher's `compare_for_save`;
   *                      mismatch likewise surfaces as `Conflict`.
   *
   * The handler also primes the watcher's self-write suppression and
   * refreshes the matching tab's cached render so callers don't need a
   * follow-up `openDocument` refresh.
   *
   * **Wire shape change (B2):** the previous `(path, contents)` signature
   * is gone — pass the opaque `tabId` instead so the dispatch can pick the
   * right backend without re-deriving it from the path.
   */
  saveDocument(tabId: string, contents: string): Promise<SaveOutcome>;
  /**
   * Tell the watcher whether the open .md has unsaved edits. While dirty,
   * external-change events are upgraded to `Ask` regardless of the user's
   * configured external_change_behavior — this is the unsaved-edits override
   * the design calls out. `Edit.ts` flips this on first input and clears it
   * after `forceSave` succeeds.
   */
  setDirty(path: string, dirty: boolean): Promise<void>;
  /**
   * C2: line-anchored diff between `local` (last-saved bytes) and
   * `incoming` (current disk bytes). Returns a list of hunks for
   * Conflict.ts to render Accept Left / Accept Right / Hand-edit per
   * hunk, then `saveDocument` the resolved bytes on Finish merge.
   */
  diffMd(local: string, incoming: string): Promise<Hunk[]>;
  /**
   * C3: copy the open document and its current sidecar into `folder` so
   * the user can hand the folder off to a reviewer. The Rust handler
   * refuses non-empty destinations to avoid stomping unrelated files.
   */
  exportDocument(args: { tabId: string; folder: string }): Promise<ExportResult>;
  /**
   * C2 follow-up: re-read `path` from disk, refresh the open tab's cached
   * source/render, and return the freshened OpenResult so the frontend
   * can swap its activeTab cache. Called from the external-change reload
   * listener — without this round-trip the frontend would re-mount stale
   * HTML.
   */
  reloadDocument(path: string): Promise<OpenResult>;
  /**
   * Spec 06 / share-receive flow: read a sidecar at `incomingPath`, CRDT-
   * merge it into the active tab's comments, save the union, and replace
   * the in-memory store. The watcher is primed so the resulting write
   * doesn't surface as an external-change event.
   */
  importComments(args: { tabId: string; incomingPath: string }): Promise<void>;
  /**
   * Font-size feature: read the per-document font-size override for `path`.
   * Returns `null` when no entry exists (the toolbar then falls back to the
   * global default from `Settings.appearance.font_size_px`).
   */
  getDocPref(path: string): Promise<DocPref | null>;
  /**
   * Font-size feature: persist a per-document override for `path`. The Rust
   * handler clamps `font_size_px` into `10..=24` before writing — frontend
   * code can pass user input through unchanged.
   */
  setDocPref(path: string, pref: DocPref): Promise<void>;
  /**
   * Font-size feature: clear the per-document override for `path` (the
   * "reset to global default" path). A missing entry is a no-op.
   */
  deleteDocPref(path: string): Promise<void>;
  /**
   * Open an external `http(s)` URL in the user's default system browser.
   * Used by the rendered-document link interceptor — the WebView's default
   * link click would otherwise navigate the entire app away to the URL.
   * Rejects non-http(s) schemes (file://, javascript:, custom schemes).
   */
  openExternalUrl(url: string): Promise<void>;
  /**
   * Open a markdown document over SSH. The Rust handler parses the URL
   * (canonical parser: `mdviewer_core::ssh_url::parse`), opens an SSH
   * channel via `russh`, and returns a `TabSummary` for the resulting
   * tab. Authentication that requires interactive input fires
   * `ssh:askpass-request` events the AskpassModal subscribes to.
   */
  sshOpenUrl(url: string): Promise<TabSummary>;
  /**
   * Reply to a pending `ssh:askpass-request` with either the user-typed
   * value or `null` (cancel). Passing `null` lets the Rust side
   * distinguish "user aborted" from "user entered no characters" — the
   * latter is sometimes a legitimate empty passphrase.
   */
  sshPasswordResponse(reqId: string, value: string | null): Promise<void>;
  /**
   * Subscribe to `ssh:askpass-request` events. Returns an unsubscribe
   * function. The handler receives the payload directly; the Tauri
   * `Event<T>` wrapper is unwrapped by the implementation so view code
   * never has to know about it.
   */
  onSshAskpassRequest(handler: (req: SshAskpassRequest) => void): () => void;
  /**
   * B1: list one remote directory for the OpenRemoteDialog's file
   * picker. The Rust handler parses the URL via the canonical
   * `mdviewer_core::ssh_url::parse`, then forwards to the transport's
   * `list_dir`. Each row is flattened into the camelCase wire DTO
   * `DirEntry` below.
   *
   * Errors surface as the verbatim `TransportError::Display` string
   * (e.g. "ssh exited Some(255)\nPermission denied (publickey)") so
   * the dialog's state-C surface (wireframe 02) can render them
   * verbatim. The adapter does NOT wrap or normalize the error string.
   */
  sshListDir(url: string): Promise<DirEntry[]>;
  /**
   * D1 (multi-window): spawn a fresh StartPage window. The new window's label
   * is derived Rust-side (`win-{nanos}`) — there is no client-supplied label.
   * Registered by C1; the typed wrapper lives here so the frontend reaches the
   * full window surface through one seam. Supersedes C2's interim raw
   * `invoke('new_window')`.
   */
  newWindow(): Promise<void>;
  /**
   * D1: close the calling window — Rust drops every tab the window owns from
   * the workspace registry and closes the native window. Identity is derived
   * from the injected `tauri::Window`, so there is no label argument.
   */
  closeWindow(): Promise<void>;
  /**
   * D1: enumerate every open window as a `WindowSummary` (label,
   * active_doc_name, tab_count, and the live `focused` flag). Drives the
   * multi-window UI surfaces.
   */
  listWindows(): Promise<WindowSummary[]>;
  /**
   * D1: open `path` in a new window, honoring the one-owner invariant. If the
   * path is already open in any window, that window+tab is focused (no
   * duplicate); otherwise a fresh window is spawned with the document.
   */
  openInNewWindow(path: string): Promise<void>;
  /**
   * D1: move tab `tabId` into the window `toWindow`. `toWindow` is the one
   * explicit client-supplied window label in the surface (per
   * contracts/02-ipc-window-commands.md); the source window is derived from
   * the tab's current owner.
   */
  moveTab(tabId: string, toWindow: string): Promise<void>;
  /**
   * G1: detach tab `tabId` into a brand-new window. The backend derives the
   * new window's label (`win-{nanos}`, never client-supplied), spawns it,
   * relocates the tab into it under the one-owner invariant, and refreshes
   * BOTH the source window (which the tab left) and the new window. Invoked by
   * the TabBar drag handler when a `dragend` drops clear of the strip.
   */
  detachTab(tabId: string): Promise<void>;
}

/**
 * Payload returned by `ssh_list_dir`. Flat camelCase shape — the Rust
 * boundary converts the snake_case `mdviewer_lib::ssh::transport::DirEntry`
 * into this so the OpenRemoteDialog can render rows without re-keying.
 */
export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/**
 * Payload of the `ssh:askpass-request` Tauri event. The Rust side fires
 * one of these whenever an SSH auth method needs interactive input. The
 * frontend AskpassModal renders variant A (passphrase) or variant B
 * (password) based on `isPassword` — it does NOT pattern-match the
 * `prompt` string to pick a variant.
 */
export interface SshAskpassRequest {
  reqId: string;
  prompt: string;
  isPassword: boolean;
}

/**
 * Client-side validator for the OpenRemoteDialog host-entry field. This
 * is purely an input affordance — the authoritative parser lives in
 * `mdviewer_core::ssh_url::parse` on the Rust side and runs inside
 * `ssh_open_url`. Matches `[user@]host[:port]` with conservative host
 * char classes.
 *
 * Note: this regex is intentionally permissive (any alnum-with-dots-and-
 * dashes host); rejecting URLs the Rust side could actually parse would
 * surface as a dead Open button. The Rust side is the source of truth.
 */
export function looksLikeSshHost(input: string): boolean {
  return /^([\w.-]+@)?[\w.-]+(:\d+)?$/.test(input.trim());
}

/**
 * CustomEvent name fired on `document` after a successful `set_settings`
 * round-trip. Workspace.ts (A9) subscribes to this so the toolbar
 * font-size readout doesn't go stale when the global default is changed
 * from the Settings UI.
 */
const SETTINGS_CHANGED_EVENT = 'mdviewer:settings-changed';

export const tauriIpc: Ipc = {
  appInfo: () => invoke('app_info'),
  openDocument: (path) => invoke('open_document', { path }),
  closeTab: (id) => invoke('close_tab', { id }),
  activateTab: (id) => invoke('activate_tab', { id }),
  listOpenDocuments: () => invoke('list_open_documents'),
  getActiveTabId: () => invoke('get_active_tab_id'),
  listRecents: () => invoke('list_recents'),
  getSettings: () => invoke('get_settings'),
  // Wraps the bare `invoke('set_settings', ...)` so a successful save also
  // broadcasts `mdviewer:settings-changed` on `document`. The dispatch is
  // intentionally AFTER `await invoke` — listeners only fire when the Rust
  // handler accepted the write. A rejection re-throws untouched (no event).
  setSettings: async (s) => {
    await invoke('set_settings', { settings: s });
    document.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: s }));
  },
  listThreads: (tabId) => invoke('list_threads', { tabId }),
  createThread: (tabId, anchor, body) => invoke('create_thread', { tabId, anchor, body }),
  // post_reply / resolve_thread take tab_id explicitly (the Rust handler uses
  // it to look up the per-tab CommentsStore). Earlier drafts dropped tab_id
  // here — keep it.
  postReply: (tabId, threadId, body) => invoke('post_reply', { tabId, threadId, body }),
  resolveThread: (tabId, threadId) => invoke('resolve_thread', { tabId, threadId }),
  deleteThread: (tabId, threadId) => invoke('delete_thread', { tabId, threadId }),
  renderMarkdown: (source) => invoke('render_markdown', { source }),
  resolveAnchor: (tabId, anchor) => invoke('resolve_anchor', { tabId, anchor }),
  saveDocument: (tabId, contents) =>
    invoke<SaveOutcome>('save_document', { tabId, body: contents }),
  setDirty: (path, dirty) => invoke<void>('set_dirty', { path, dirty }),
  diffMd: (local, incoming) => invoke<Hunk[]>('diff_md', { local, incoming }),
  exportDocument: (args) =>
    invoke<ExportResult>('export_document', { tabId: args.tabId, folder: args.folder }),
  reloadDocument: (path) => invoke<OpenResult>('reload_document', { path }),
  importComments: (args) =>
    invoke<void>('import_comments', { tabId: args.tabId, incomingPath: args.incomingPath }),
  // Doc-pref wrappers (A4). Argument shapes match the Rust handlers in
  // src-tauri/src/main.rs (`get_doc_pref` / `set_doc_pref` / `delete_doc_pref`).
  getDocPref: (path) => invoke<DocPref | null>('get_doc_pref', { path }),
  setDocPref: (path, pref) => invoke<void>('set_doc_pref', { path, pref }),
  deleteDocPref: (path) => invoke<void>('delete_doc_pref', { path }),
  openExternalUrl: (url) => invoke<void>('open_external_url', { url }),
  sshOpenUrl: (url) => invoke<TabSummary>('ssh_open_url', { url }),
  sshPasswordResponse: (reqId, value) =>
    invoke<void>('ssh_password_response', { reqId, value }),
  sshListDir: (url) => invoke<DirEntry[]>('ssh_list_dir', { url }),
  // D1 (multi-window) window surface. `new_window` is registered by C1 — the
  // typed binding lives here alongside the four D1-registered commands so the
  // frontend reaches the full surface through one seam. `moveTab`'s `toWindow`
  // is the only client-supplied window label; every other command derives its
  // window identity Rust-side from the injected `tauri::Window`.
  newWindow: () => invoke<void>('new_window'),
  closeWindow: () => invoke<void>('close_window'),
  listWindows: () => invoke<WindowSummary[]>('list_windows'),
  openInNewWindow: (path) => invoke<void>('open_in_new_window', { path }),
  moveTab: (tabId, toWindow) => invoke<void>('move_tab', { tabId, toWindow }),
  // G1: detach a tab into a fresh window. No client label — the backend mints
  // the `win-{nanos}` label and spawns the window in the same handler.
  detachTab: (tabId) => invoke<void>('detach_tab', { tabId }),
  // Subscribe to `ssh:askpass-request`. `listen` is async (it round-trips
  // through Tauri's event API) so the unlisten handle isn't available
  // synchronously — capture it asynchronously and have the returned
  // disposer fire it when ready. If the caller disposes before listen
  // resolves, set a flag and fire the unlisten as soon as we have it.
  onSshAskpassRequest: (handler) => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (disposed) return;
        const u = await listen<SshAskpassRequest>('ssh:askpass-request', (evt) =>
          handler(evt.payload),
        );
        if (disposed) {
          u();
          return;
        }
        unlisten = u;
      } catch {
        // jsdom / unit tests without the Tauri runtime — fall through.
      }
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  },
};

/**
 * Canonical singleton view of the IPC adapter. The mounted AskpassModal
 * imports this directly (it's mounted once at app boot rather than threaded
 * through every view), and new view modules can choose to consume the
 * singleton rather than wire the `Ipc` prop down through their callers.
 *
 * Old views still take `Ipc` as a prop — both styles are intentional and
 * coexist.
 */
export const ipc: Ipc = tauriIpc;

/**
 * A8: typed wrappers around the Drive IPC commands registered in A7.
 *
 * Note: A7 registers seven IPC commands but only six get a typed wrapper here.
 * `is_drive_desktop_path` is intentionally invoked raw from C2's
 * DriveDetectToast (i.e. `invoke('is_drive_desktop_path', { path })`) because
 * it's a pure path-classification helper with no auth or workspace state and
 * no shared call-site outside the toast — adding a wrapper for a single
 * caller would just be type-tax with no payoff.
 *
 * `drive_connect` and `drive_disconnect` round-trip a fresh `DriveStatus`
 * snapshot so the caller can update its UI without a follow-up
 * `drive_status` IPC. The Rust side ALSO emits `drive-status-changed` so
 * status-pill subscribers see the update without polling.
 */
export const driveConnect = (): Promise<DriveStatus> => invoke<DriveStatus>('drive_connect');
export const driveDisconnect = (): Promise<DriveStatus> =>
  invoke<DriveStatus>('drive_disconnect');
export const driveStatus = (): Promise<DriveStatus> => invoke<DriveStatus>('drive_status');
export const driveOpenUrl = (url: string): Promise<TabSummary> =>
  invoke<TabSummary>('drive_open_url', { url });
export const driveResolvePath = (localPath: string): Promise<string> =>
  invoke<string>('drive_resolve_path', { localPath });
export const driveGetCollaborators = (fileId: string): Promise<DriveCollaborator[]> =>
  invoke<DriveCollaborator[]>('drive_get_collaborators', { fileId });
