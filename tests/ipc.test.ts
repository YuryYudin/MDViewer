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
import type { Anchor, DocPref, Settings } from '../src/ipc';

const dummyAnchor: Anchor = { start: 0, end: 4, exact: 'abcd', prefix: '', suffix: '' };
const dummyDocPref: DocPref = { font_size_px: 16 };
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
  onboarding: { cli_install_prompt_seen_for: '' },
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

  it('setSettings dispatches mdviewer:settings-changed on document with detail = settings', async () => {
    // The wrapper dispatches a CustomEvent on `document` after a successful
    // set_settings invoke. Workspace.ts (A9) subscribes to this so the
    // toolbar font-size readout stays in sync when the global default
    // changes from the Settings UI.
    const handler = vi.fn();
    document.addEventListener('mdviewer:settings-changed', handler as EventListener, {
      once: true,
    });
    await tauriIpc.setSettings(dummySettings);
    expect(handler).toHaveBeenCalledTimes(1);
    const ev = handler.mock.calls[0][0] as CustomEvent<Settings>;
    expect(ev.detail).toEqual(dummySettings);
  });

  it('setSettings does NOT dispatch the event when the invoke rejects', async () => {
    // Listeners only fire on a successful save; a rejection from the Rust
    // handler must surface as a thrown promise without a stale event.
    invoke.mockRejectedValueOnce(new Error('boom'));
    const handler = vi.fn();
    document.addEventListener('mdviewer:settings-changed', handler as EventListener, {
      once: true,
    });
    await expect(tauriIpc.setSettings(dummySettings)).rejects.toThrow('boom');
    expect(handler).not.toHaveBeenCalled();
    document.removeEventListener('mdviewer:settings-changed', handler as EventListener);
  });

  it('getDocPref invokes get_doc_pref with { path }', async () => {
    invoke.mockResolvedValueOnce(dummyDocPref);
    const got = await tauriIpc.getDocPref('/x.md');
    expect(invoke).toHaveBeenCalledWith('get_doc_pref', { path: '/x.md' });
    expect(got).toEqual(dummyDocPref);
  });

  it('getDocPref returns null when the Rust handler reports no override', async () => {
    invoke.mockResolvedValueOnce(null);
    const got = await tauriIpc.getDocPref('/missing.md');
    expect(got).toBeNull();
  });

  it('setDocPref invokes set_doc_pref with { path, pref }', async () => {
    await tauriIpc.setDocPref('/x.md', dummyDocPref);
    expect(invoke).toHaveBeenCalledWith('set_doc_pref', { path: '/x.md', pref: dummyDocPref });
  });

  it('deleteDocPref invokes delete_doc_pref with { path }', async () => {
    await tauriIpc.deleteDocPref('/x.md');
    expect(invoke).toHaveBeenCalledWith('delete_doc_pref', { path: '/x.md' });
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

  it('deleteThread invokes delete_thread with { tabId, threadId }', async () => {
    await tauriIpc.deleteThread('tab-1', 'thr-9');
    expect(invoke).toHaveBeenCalledWith('delete_thread', {
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

  it('saveDocument invokes save_document with { tabId, body }', async () => {
    // B2 wire-shape change: pass tabId (not path) so the Rust dispatch can
    // pick the right backend (Local / DriveApi / DriveDesktop) without
    // re-deriving it from the path. The contents arg is serialized as `body`.
    await tauriIpc.saveDocument('tab-1', 'hello');
    expect(invoke).toHaveBeenCalledWith('save_document', {
      tabId: 'tab-1',
      body: 'hello',
    });
  });

  it('setDirty invokes set_dirty with { path, dirty }', async () => {
    await tauriIpc.setDirty('/x.md', true);
    expect(invoke).toHaveBeenCalledWith('set_dirty', { path: '/x.md', dirty: true });
  });

  it('diffMd invokes diff_md with { local, incoming }', async () => {
    await tauriIpc.diffMd('a', 'b');
    expect(invoke).toHaveBeenCalledWith('diff_md', { local: 'a', incoming: 'b' });
  });

  it('exportDocument invokes export_document with { tabId, folder }', async () => {
    await tauriIpc.exportDocument({ tabId: 't', folder: '/out' });
    expect(invoke).toHaveBeenCalledWith('export_document', { tabId: 't', folder: '/out' });
  });

  it('reloadDocument invokes reload_document with { path }', async () => {
    await tauriIpc.reloadDocument('/x.md');
    expect(invoke).toHaveBeenCalledWith('reload_document', { path: '/x.md' });
  });

  it('exposes the six drive command wrappers as functions', async () => {
    // A8: typed wrappers around the Drive IPC commands. `is_drive_desktop_path`
    // is intentionally omitted — C2's DriveDetectToast is its only caller and
    // invokes it raw.
    const ipc = await import('../src/ipc');
    expect(typeof ipc.driveConnect).toBe('function');
    expect(typeof ipc.driveDisconnect).toBe('function');
    expect(typeof ipc.driveStatus).toBe('function');
    expect(typeof ipc.driveOpenUrl).toBe('function');
    expect(typeof ipc.driveResolvePath).toBe('function');
    expect(typeof ipc.driveGetCollaborators).toBe('function');
  });

  it('driveConnect invokes drive_connect with no args', async () => {
    const ipc = await import('../src/ipc');
    await ipc.driveConnect();
    expect(invoke).toHaveBeenCalledWith('drive_connect');
  });

  it('driveDisconnect invokes drive_disconnect with no args', async () => {
    const ipc = await import('../src/ipc');
    await ipc.driveDisconnect();
    expect(invoke).toHaveBeenCalledWith('drive_disconnect');
  });

  it('driveStatus invokes drive_status with no args', async () => {
    const ipc = await import('../src/ipc');
    await ipc.driveStatus();
    expect(invoke).toHaveBeenCalledWith('drive_status');
  });

  it('driveOpenUrl invokes drive_open_url with { url }', async () => {
    const ipc = await import('../src/ipc');
    await ipc.driveOpenUrl('https://docs.google.com/document/d/abc/edit');
    expect(invoke).toHaveBeenCalledWith('drive_open_url', {
      url: 'https://docs.google.com/document/d/abc/edit',
    });
  });

  it('driveResolvePath invokes drive_resolve_path with { localPath }', async () => {
    const ipc = await import('../src/ipc');
    await ipc.driveResolvePath('/Users/me/Google Drive/file.md');
    expect(invoke).toHaveBeenCalledWith('drive_resolve_path', {
      localPath: '/Users/me/Google Drive/file.md',
    });
  });

  it('driveGetCollaborators invokes drive_get_collaborators with { fileId }', async () => {
    const ipc = await import('../src/ipc');
    await ipc.driveGetCollaborators('drive-file-123');
    expect(invoke).toHaveBeenCalledWith('drive_get_collaborators', {
      fileId: 'drive-file-123',
    });
  });

  it('exposes every IPC method as a function', () => {
    // Pinned Ipc shape so a future rename / dropped method fails loudly here
    // before drift propagates to view modules.
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
      'deleteThread',
      'renderMarkdown',
      'resolveAnchor',
      'saveDocument',
      'setDirty',
      'diffMd',
      'exportDocument',
      'reloadDocument',
      'getDocPref',
      'setDocPref',
      'deleteDocPref',
      'importComments',
      'openExternalUrl',
    ];
    for (const m of required) {
      expect(typeof tauriIpc[m]).toBe('function');
    }
    expect(required.length).toBe(25);
  });
});
