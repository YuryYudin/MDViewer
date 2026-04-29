/**
 * Tests for the IPC adapter. We mock `@tauri-apps/api/core` so the adapter
 * runs without a real Tauri runtime; what we verify is that each method on
 * `tauriIpc` invokes the matching Rust command name with the matching args.
 *
 * The contract here is load-bearing: arg-name mismatches between the JS
 * adapter and Rust handlers are silent (Tauri sees a serialized `null`) so
 * exercising every method is the only sound test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { tauriIpc, type Ipc } from '../src/ipc';
import type { Anchor, Settings } from '../src/ipc';

const dummyAnchor: Anchor = { start: 0, end: 4, exact: 'abcd', prefix: '', suffix: '' };
const dummySettings: Settings = {
  profile: { user_id: 'u', display_name: 'D', color: '#fff' },
  appearance: { theme: 'light', font_size_px: 14, line_height: 1.5, density: 'normal' },
  editor: {
    default_open_mode: 'view',
    auto_save: false,
    auto_save_debounce_ms: 500,
    external_change_behavior: 'ask',
    syntax_highlighting: true,
    mermaid_enabled: true,
    show_whitespace: false,
    word_wrap: true,
  },
  comments: {
    auto_merge: 'ask',
    reattachment_confidence: 0.85,
    sidecar_pattern: '{name}.comments.json',
    show_resolved: true,
  },
  advanced: { sync_provider: null, verbose_logs: false },
  shortcuts: {},
};

describe('tauriIpc', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  it('appInfo invokes app_info with no args', async () => {
    await tauriIpc.appInfo();
    expect(invoke).toHaveBeenCalledWith('app_info');
  });

  it('openDocument invokes open_document with { path }', async () => {
    await tauriIpc.openDocument('/x.md');
    expect(invoke).toHaveBeenCalledWith('open_document', { path: '/x.md' });
  });

  it('closeTab invokes close_tab with { id }', async () => {
    await tauriIpc.closeTab('tab-1');
    expect(invoke).toHaveBeenCalledWith('close_tab', { id: 'tab-1' });
  });

  it('activateTab invokes activate_tab with { id }', async () => {
    await tauriIpc.activateTab('tab-1');
    expect(invoke).toHaveBeenCalledWith('activate_tab', { id: 'tab-1' });
  });

  it('listOpenDocuments invokes list_open_documents', async () => {
    await tauriIpc.listOpenDocuments();
    expect(invoke).toHaveBeenCalledWith('list_open_documents');
  });

  it('listRecents invokes list_recents', async () => {
    await tauriIpc.listRecents();
    expect(invoke).toHaveBeenCalledWith('list_recents');
  });

  it('getSettings invokes get_settings', async () => {
    await tauriIpc.getSettings();
    expect(invoke).toHaveBeenCalledWith('get_settings');
  });

  it('setSettings invokes set_settings with { settings }', async () => {
    await tauriIpc.setSettings(dummySettings);
    expect(invoke).toHaveBeenCalledWith('set_settings', { settings: dummySettings });
  });

  it('listThreads invokes list_threads with { tabId }', async () => {
    await tauriIpc.listThreads('tab-1');
    expect(invoke).toHaveBeenCalledWith('list_threads', { tabId: 'tab-1' });
  });

  it('createThread invokes create_thread with { tabId, anchor, body }', async () => {
    await tauriIpc.createThread('tab-1', dummyAnchor, 'hi');
    expect(invoke).toHaveBeenCalledWith('create_thread', {
      tabId: 'tab-1',
      anchor: dummyAnchor,
      body: 'hi',
    });
  });

  it('postReply invokes post_reply with { tabId, threadId, body }', async () => {
    await tauriIpc.postReply('tab-1', 'thr-9', 'reply');
    expect(invoke).toHaveBeenCalledWith('post_reply', {
      tabId: 'tab-1',
      threadId: 'thr-9',
      body: 'reply',
    });
  });

  it('resolveThread invokes resolve_thread with { tabId, threadId }', async () => {
    await tauriIpc.resolveThread('tab-1', 'thr-9');
    expect(invoke).toHaveBeenCalledWith('resolve_thread', {
      tabId: 'tab-1',
      threadId: 'thr-9',
    });
  });

  it('renderMarkdown invokes render_markdown with { source }', async () => {
    await tauriIpc.renderMarkdown('# hi');
    expect(invoke).toHaveBeenCalledWith('render_markdown', { source: '# hi' });
  });

  it('resolveAnchor invokes resolve_anchor with { tabId, anchor }', async () => {
    await tauriIpc.resolveAnchor('tab-1', dummyAnchor);
    expect(invoke).toHaveBeenCalledWith('resolve_anchor', {
      tabId: 'tab-1',
      anchor: dummyAnchor,
    });
  });

  it('saveDocument invokes save_document with { path, contents }', async () => {
    await tauriIpc.saveDocument('/x.md', 'hello');
    expect(invoke).toHaveBeenCalledWith('save_document', {
      path: '/x.md',
      contents: 'hello',
    });
  });

  it('exposes every Phase-1+B3 method as a function', () => {
    // Pinned Ipc shape so a future rename / dropped method fails loudly here
    // before drift propagates to view modules. C2 will extend with `diffMd`,
    // C3 with `exportDocument`.
    const required: (keyof Ipc)[] = [
      'appInfo',
      'getSettings',
      'setSettings',
      'listRecents',
      'openDocument',
      'closeTab',
      'activateTab',
      'listOpenDocuments',
      'listThreads',
      'createThread',
      'postReply',
      'resolveThread',
      'renderMarkdown',
      'resolveAnchor',
      'saveDocument',
    ];
    for (const m of required) {
      expect(typeof tauriIpc[m]).toBe('function');
    }
    expect(required.length).toBe(15);
  });
});
