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
} from './types-generated';

import type {
  BuildInfo,
  Settings,
  Anchor,
  ResolveOutcome,
  Thread,
  OpenOutcome,
  RenderResult,
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
};
