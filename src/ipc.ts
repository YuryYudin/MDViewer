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
} from './types-generated';

import type {
  BuildInfo,
  Settings,
  Anchor,
  ResolveOutcome,
  Thread,
  OpenOutcome,
  RenderResult,
  Hunk,
  ExportResult,
} from './types-generated';

// `Anchor` is the canonical name across the wire. Older planning notes used
// `AnchorPayload`; alias here for clarity.
export type AnchorPayload = Anchor;

export interface Ipc {
  appInfo(): Promise<BuildInfo>;
  openDocument(path: string): Promise<OpenOutcome>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  listOpenDocuments(): Promise<string[]>;
  listRecents(): Promise<string[]>;
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
}

export const tauriIpc: Ipc = {
  appInfo: () => invoke('app_info'),
  openDocument: (path) => invoke('open_document', { path }),
  closeTab: (id) => invoke('close_tab', { id }),
  activateTab: (id) => invoke('activate_tab', { id }),
  listOpenDocuments: () => invoke('list_open_documents'),
  listRecents: () => invoke('list_recents'),
  getSettings: () => invoke('get_settings'),
  setSettings: (s) => invoke('set_settings', { settings: s }),
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
};
