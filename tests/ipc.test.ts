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

// onSshAskpassRequest dynamically imports '@tauri-apps/api/event'. Under
// vitest 4 a per-test vi.doMock can't override that import once an earlier
// test has cached the real module — and the already-imported adapter is bound
// to the original module graph, so vi.resetModules doesn't help either. Hoist
// a single mock whose `listen` delegates to a per-test-swappable impl.
const eventMock = vi.hoisted(() => ({
  listen: undefined as undefined | ((...args: any[]) => unknown),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => eventMock.listen!(...args),
}));

// Default: simulate "no Tauri runtime" — listen rejects. The bare-adapter
// test (no mocked listen) relies on this; the mocked-listen tests override it.
beforeEach(() => {
  eventMock.listen = () => Promise.reject(new Error('no tauri runtime'));
});

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
      // A11: SSH IPC surface.
      'sshOpenUrl',
      'sshPasswordResponse',
      'onSshAskpassRequest',
      // B1: directory listing for the OpenRemoteDialog file-picker.
      'sshListDir',
    ];
    for (const m of required) {
      expect(typeof tauriIpc[m]).toBe('function');
    }
    expect(required.length).toBe(29);
  });

  // ---------------------------------------------------------------------
  // A11: SSH IPC surface.
  // ---------------------------------------------------------------------

  it('sshOpenUrl invokes ssh_open_url with { url }', async () => {
    await tauriIpc.sshOpenUrl('ssh://user@host/path/file.md');
    expect(invoke).toHaveBeenCalledWith('ssh_open_url', {
      url: 'ssh://user@host/path/file.md',
    });
  });

  it('sshPasswordResponse invokes ssh_password_response with { reqId, value }', async () => {
    await tauriIpc.sshPasswordResponse('req-1', 'hunter2');
    expect(invoke).toHaveBeenCalledWith('ssh_password_response', {
      reqId: 'req-1',
      value: 'hunter2',
    });
  });

  it('sshPasswordResponse forwards null as a cancel signal', async () => {
    // The Rust side distinguishes `null` (user aborted) from empty string
    // (user entered no chars but pressed Submit) — verify both wire cleanly.
    await tauriIpc.sshPasswordResponse('req-2', null);
    expect(invoke).toHaveBeenCalledWith('ssh_password_response', {
      reqId: 'req-2',
      value: null,
    });
  });

  // -------------------------------------------------------------------
  // B1: ssh_list_dir wire shape. The OpenRemoteDialog calls this once
  // per host the user picks; the Rust side flattens the transport's
  // `DirEntry` enum into a camelCase `{ name, isDir, size }` DTO before
  // returning so the dialog can render rows without re-keying.
  // -------------------------------------------------------------------

  it('sshListDir invokes ssh_list_dir with { url } and returns the flat entries', async () => {
    const stub = [
      { name: 'README.md', isDir: false, size: 1234 },
      { name: 'notes', isDir: true, size: 0 },
    ];
    invoke.mockResolvedValueOnce(stub);
    const got = await tauriIpc.sshListDir('ssh://alice@host/notes');
    expect(invoke).toHaveBeenCalledWith('ssh_list_dir', {
      url: 'ssh://alice@host/notes',
    });
    expect(got).toEqual(stub);
  });

  it('sshListDir propagates the verbatim Rust error string for state-C rendering', async () => {
    // The wireframe-02 state C requires the dialog to show the verbatim ssh
    // stderr (Permission denied, host key changed, etc.). The Rust handler
    // surfaces `TransportError::Display` as a plain string — the adapter
    // must not wrap it ("An unknown error occurred." would be the
    // regression).
    invoke.mockRejectedValueOnce('ssh exited Some(255)\nPermission denied (publickey)');
    await expect(tauriIpc.sshListDir('ssh://host/x')).rejects.toBe(
      'ssh exited Some(255)\nPermission denied (publickey)',
    );
  });

  it('onSshAskpassRequest returns a synchronous disposer even before listen resolves', async () => {
    // The Tauri `listen` import is dynamic; the disposer must work
    // regardless of whether the async resolve has happened yet. In jsdom
    // (no Tauri runtime) the dynamic import rejects and the listener
    // never installs — the disposer must still be a no-op-safe callable.
    const dispose = tauriIpc.onSshAskpassRequest(() => {});
    expect(typeof dispose).toBe('function');
    // Calling it before resolution must not throw.
    expect(() => dispose()).not.toThrow();
    // Allow the rejected dynamic import to flush so unhandled-rejection
    // tracking sees the catch block.
    await Promise.resolve();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// A11: `onSshAskpassRequest` happy-path branch coverage.
//
// The bare adapter test above only exercises the dynamic-import-rejects
// branch (jsdom has no Tauri runtime). Mocking `@tauri-apps/api/event`
// at module-resolution time lets us exercise:
//   - the success path (listen resolves before dispose)
//   - the dispose-before-listen-resolves path (must fire u() when it lands)
//   - the unwrap that forwards `evt.payload` to the handler (not the full
//     Event<T> wrapper)
// ---------------------------------------------------------------------------
/**
 * Polls until `predicate()` returns true or the timeout elapses. Used to
 * synchronize with the adapter's dynamic-import → listen() chain across
 * an unknown number of microtask ticks. v8 coverage instrumentation
 * lengthens the microtask chain unpredictably, so a fixed two-tick flush
 * is brittle — polling is the robust alternative.
 */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForCondition timed out');
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('onSshAskpassRequest (mocked listen)', () => {
  it('forwards evt.payload to the handler and fires unlisten on dispose', async () => {
    // Build a deferred so we can capture the listener Tauri's `listen`
    // would install and emit a synthetic event into it.
    const unlistenMock = vi.fn();
    let captured: ((evt: { payload: unknown }) => void) | null = null;
    const listenMock = vi.fn(async (_name: string, cb: (evt: { payload: unknown }) => void) => {
      captured = cb;
      return unlistenMock;
    });
    eventMock.listen = listenMock;

    try {
      const handler = vi.fn();
      const dispose = tauriIpc.onSshAskpassRequest(handler);
      // Wait for the adapter's dynamic-import chain to land. The number
      // of microtasks varies (esp. under v8 coverage instrumentation), so
      // poll instead of flushing a fixed count.
      await waitForCondition(() => listenMock.mock.calls.length > 0);
      expect(listenMock).toHaveBeenCalledWith('ssh:askpass-request', expect.any(Function));
      await waitForCondition(() => captured !== null);

      // Emit a synthetic event — handler must receive the unwrapped payload
      // (NOT the full Event<T> shape).
      const payload = { reqId: 'r', prompt: 'P:', isPassword: true };
      captured!({ payload });
      expect(handler).toHaveBeenCalledWith(payload);

      // Dispose after resolution → fires the captured unlisten exactly once.
      dispose();
      expect(unlistenMock).toHaveBeenCalledTimes(1);
    } finally {
      eventMock.listen = undefined;
    }
  });

  it('disposing after listen is issued but before it resolves still fires the unlisten exactly once', async () => {
    // Race condition: caller disposes after listen() is in-flight but
    // before its promise resolves. The implementation's post-await
    // `if (disposed) { u(); return; }` arm must call u() so the
    // subscription never leaks.
    const unlistenMock = vi.fn();
    let resolveListen: ((u: () => void) => void) = () => undefined;
    const listenMock = vi.fn(
      () =>
        new Promise<() => void>((res) => {
          resolveListen = res;
        }),
    );
    eventMock.listen = listenMock;

    try {
      const dispose = tauriIpc.onSshAskpassRequest(() => {});
      // Wait until listen() has been called (and the adapter is suspended
      // on the await). Polling beats a fixed flush for the reason
      // explained on waitForCondition.
      await waitForCondition(() => listenMock.mock.calls.length > 0);
      // Dispose BEFORE letting listen resolve. The dispose has nothing
      // to call yet (unlisten still null), but flags disposed=true.
      dispose();
      // Resolve listen — the post-await `if (disposed)` arm must fire u().
      resolveListen(unlistenMock);
      await waitForCondition(() => unlistenMock.mock.calls.length > 0);
      expect(unlistenMock).toHaveBeenCalledTimes(1);
    } finally {
      eventMock.listen = undefined;
    }
  });

  it('swallows a listen() rejection without throwing out of the dispatch', async () => {
    // The Tauri event API can reject (e.g. no listener registered yet on
    // Rust side, or a transient ipc-not-ready window during boot). The
    // adapter MUST swallow this — throwing would surface as an unhandled
    // rejection that kills the WebView in production. The catch block in
    // src/ipc.ts is the safety net.
    const listenMock = vi.fn(() => Promise.reject(new Error('listen failed')));
    eventMock.listen = listenMock;
    try {
      const handler = vi.fn();
      const dispose = tauriIpc.onSshAskpassRequest(handler);
      // Wait until the rejected listen() has been issued and the catch
      // block has had a chance to run.
      await waitForCondition(() => listenMock.mock.calls.length > 0);
      // Give the catch arm an extra tick to settle.
      await new Promise((r) => setTimeout(r, 0));
      // No throw, dispose still callable.
      expect(() => dispose()).not.toThrow();
      // Handler was never called because listen never resolved.
      expect(handler).not.toHaveBeenCalled();
    } finally {
      eventMock.listen = undefined;
    }
  });

  it('disposing before listen is even issued never invokes listen', async () => {
    // Earlier-race variant: dispose runs while the dynamic
    // `import('@tauri-apps/api/event')` itself is still pending. The
    // implementation's first `if (disposed) return` arm guards this —
    // listen() should NEVER be called because we know it'll just leak.
    const listenMock = vi.fn(async () => () => undefined);
    eventMock.listen = listenMock;

    try {
      const dispose = tauriIpc.onSshAskpassRequest(() => {});
      // Dispose synchronously, before any microtask runs.
      dispose();
      // Now let the dynamic import resolve. Give it generous time so
      // the test does the equivalent of "wait until any reasonable
      // dispatcher would have called listen()". listen() must still
      // have been skipped because disposed was true when the import
      // resolved.
      await new Promise((r) => setTimeout(r, 50));
      expect(listenMock).not.toHaveBeenCalled();
    } finally {
      eventMock.listen = undefined;
    }
  });
});

// ---------------------------------------------------------------------------
// A11: looksLikeSshHost — client-side input-affordance regex. NOT the
// authoritative parser (that lives in Rust); this is what the
// OpenRemoteDialog uses to enable/disable the Open button.
// ---------------------------------------------------------------------------
describe('looksLikeSshHost', () => {
  it('accepts a bare hostname', async () => {
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('server.example.com')).toBe(true);
  });

  it('accepts user@host', async () => {
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('alice@server.example.com')).toBe(true);
  });

  it('accepts host:port', async () => {
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('server.example.com:2222')).toBe(true);
  });

  it('accepts user@host:port', async () => {
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('alice@server.example.com:2222')).toBe(true);
  });

  it('trims surrounding whitespace before validating', async () => {
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('  alice@server  ')).toBe(true);
  });

  it('rejects an empty string', async () => {
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('')).toBe(false);
    expect(looksLikeSshHost('   ')).toBe(false);
  });

  it('rejects an entry that contains a path or scheme', async () => {
    // The OpenRemoteDialog has separate fields for host vs path; the host
    // field's validator must reject anything that contains a slash or a
    // scheme prefix so the user can't paste a full URL into the wrong field.
    const { looksLikeSshHost } = await import('../src/ipc');
    expect(looksLikeSshHost('ssh://server')).toBe(false);
    expect(looksLikeSshHost('server/path')).toBe(false);
    expect(looksLikeSshHost('a b')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A11: `ipc` singleton alias — kept identical to `tauriIpc` so views that
// import the singleton get the same wire-shape verified above.
// ---------------------------------------------------------------------------
describe('ipc singleton alias', () => {
  it('is the same instance as tauriIpc', async () => {
    const mod = await import('../src/ipc');
    expect(mod.ipc).toBe(mod.tauriIpc);
  });
});
