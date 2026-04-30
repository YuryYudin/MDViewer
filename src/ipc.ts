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
  renderMarkdown(source: string): Promise<RenderResult>;
  resolveAnchor(tabId: string, anchor: Anchor): Promise<ResolveOutcome>;
  /**
   * Atomically write `contents` to `path` (B3). The Rust handler also
   * records a self-write suppression entry on the watcher and refreshes
   * the matching tab's cached render — callers don't need to follow up
   * with a separate openDocument refresh.
   */
  saveDocument(path: string, contents: string): Promise<void>;
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
  renderMarkdown: (source) => invoke('render_markdown', { source }),
  resolveAnchor: (tabId, anchor) => invoke('resolve_anchor', { tabId, anchor }),
  saveDocument: (path, contents) => invoke<void>('save_document', { path, contents }),
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
};
