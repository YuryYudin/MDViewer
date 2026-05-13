import { describe, it, expect, vi, afterEach } from 'vitest';
import { mountLiveEditor } from '../../src/views/LiveEditor';
import type { Settings, Thread, ResolveOutcome } from '../../src/types-generated';

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

function makeSettings(overrides: Partial<Settings['editor']> = {}): Settings {
  // Minimal Settings shape — the LiveEditor only reads
  // editor.auto_save_debounce_ms and editor.render_readonly. The rest
  // are present so the type-check passes in callers that pass a real
  // Settings snapshot down.
  return {
    profile: { display_name: '', email: null, color: '#000', avatar: null } as unknown as Settings['profile'],
    appearance: {} as unknown as Settings['appearance'],
    editor: {
      default_open_mode: 'render',
      auto_save: true,
      auto_save_debounce_ms: 500,
      external_change_behavior: 'reload' as unknown as Settings['editor']['external_change_behavior'],
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
      render_readonly: false,
      ...overrides,
    } as unknown as Settings['editor'],
    comments: {} as unknown as Settings['comments'],
    advanced: {} as unknown as Settings['advanced'],
    shortcuts: {},
    cloud: {} as unknown as Settings['cloud'],
    onboarding: {} as unknown as Settings['onboarding'],
  };
}

interface IpcStub {
  saveDocument: ReturnType<typeof vi.fn>;
  setDirty: ReturnType<typeof vi.fn>;
  resolveAnchor: ReturnType<typeof vi.fn>;
}

function makeIpc(overrides: Partial<IpcStub> = {}): IpcStub {
  return {
    saveDocument: vi.fn().mockResolvedValue({ kind: 'ok', etag: null }),
    setDirty: vi.fn().mockResolvedValue(undefined),
    resolveAnchor: vi
      .fn()
      .mockResolvedValue({ kind: 'resolved', start: 0, end: 1 } as ResolveOutcome),
    ...overrides,
  };
}

function makeThread(id: string, start: number, end: number, exact: string): Thread {
  return {
    id,
    anchor: { start, end, exact, prefix: '', suffix: '' },
    comments: [],
    resolved: false,
    resolved_at: null,
    resolved_by: null,
  };
}

function typeInto(view: ReturnType<typeof mountLiveEditor>, text: string): void {
  // Simulate a user-input transaction by calling the editor's
  // dispatch with a userEvent annotation, which mirrors what
  // CodeMirror does on real keystrokes.
  view.editorView.dispatch({
    changes: { from: view.editorView.state.doc.length, insert: text },
    userEvent: 'input.type',
  });
}

afterEach(() => {
  document.body.replaceChildren();
  delete (window as unknown as Record<string, unknown>).__WEBDRIVER__;
  delete (window as unknown as Record<string, unknown>).__mdviewerE2E;
  vi.useRealTimers();
});

describe('LiveEditor', () => {
  describe('mode StateField', () => {
    it('starts in render mode by default and setMode flips it back and forth', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings(),
        threads: [],
      });
      expect(view.mode()).toBe('render');
      view.setMode('raw');
      expect(view.mode()).toBe('raw');
      view.setMode('render');
      expect(view.mode()).toBe('render');
      view.destroy();
    });

    it('mode toggle alone does NOT trigger an autosave', () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 200 }),
        threads: [],
      });
      view.setMode('raw');
      view.setMode('render');
      vi.advanceTimersByTime(10_000);
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      view.destroy();
    });
  });

  describe('autosave debounce', () => {
    it('schedules one save after auto_save_debounce_ms on user input', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 750 }),
        threads: [],
      });
      typeInto(view, 'abc');
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      vi.advanceTimersByTime(749);
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'abc');
      view.destroy();
    });

    it('coalesces multiple inputs inside the debounce window into one save', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 500 }),
        threads: [],
      });
      typeInto(view, 'a');
      vi.advanceTimersByTime(400);
      typeInto(view, 'b');
      vi.advanceTimersByTime(400);
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'ab');
      view.destroy();
    });
  });

  describe('dirty flag', () => {
    it('calls setDirty(path, true) on first user input and setDirty(path, false) after successful save', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 100 }),
        threads: [],
      });
      typeInto(view, 'x');
      // First user-input transaction flips dirty=true.
      expect(ipc.setDirty).toHaveBeenCalledWith('/tmp/a.md', true);
      expect(ipc.setDirty).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      // Drain microtasks so the awaited save settles.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.setDirty).toHaveBeenCalledWith('/tmp/a.md', false);
      view.destroy();
    });

    it('does NOT flip dirty on programmatic (non-user-event) transactions like mode toggle', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings(),
        threads: [],
      });
      view.setMode('raw');
      view.setMode('render');
      expect(ipc.setDirty).not.toHaveBeenCalled();
      view.destroy();
    });
  });

  describe('mdviewer:tab-dirty CustomEvent', () => {
    it('dispatches mdviewer:tab-dirty with dirty:true on first user input', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      document.addEventListener('mdviewer:tab-dirty', handler);
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/x.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 100 }),
        threads: [],
      });
      typeInto(view, 'a');
      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({ path: '/tmp/x.md', dirty: true });
      // Subsequent input while already-dirty must NOT fire another dirty:true.
      typeInto(view, 'b');
      expect(events).toHaveLength(1);
      document.removeEventListener('mdviewer:tab-dirty', handler);
      view.destroy();
    });

    it('dispatches mdviewer:tab-dirty with dirty:false after flushSave', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const events: CustomEvent[] = [];
      const handler = (e: Event) => events.push(e as CustomEvent);
      document.addEventListener('mdviewer:tab-dirty', handler);
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/x.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads: [],
      });
      typeInto(view, 'a');
      vi.advanceTimersByTime(50);
      // Drain the await chain.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      const last = events[events.length - 1];
      expect(last.detail).toEqual({ path: '/tmp/x.md', dirty: false });
      // First event was dirty:true, last is dirty:false.
      expect(events[0].detail).toEqual({ path: '/tmp/x.md', dirty: true });
      document.removeEventListener('mdviewer:tab-dirty', handler);
      view.destroy();
    });
  });

  describe('render_readonly', () => {
    it('mounts with editable=false when render_readonly && mode==="render"', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ render_readonly: true }),
        threads: [],
      });
      const cmContent = root.querySelector<HTMLElement>('.cm-content')!;
      expect(cmContent.getAttribute('contenteditable')).toBe('false');
      view.destroy();
    });

    it('flips editable=true when switching to raw mode even with render_readonly=true', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ render_readonly: true }),
        threads: [],
      });
      const cmContent = root.querySelector<HTMLElement>('.cm-content')!;
      expect(cmContent.getAttribute('contenteditable')).toBe('false');
      view.setMode('raw');
      expect(cmContent.getAttribute('contenteditable')).toBe('true');
      view.setMode('render');
      expect(cmContent.getAttribute('contenteditable')).toBe('false');
      view.destroy();
    });

    it('does not set editable=false when render_readonly is false', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ render_readonly: false }),
        threads: [],
      });
      const cmContent = root.querySelector<HTMLElement>('.cm-content')!;
      expect(cmContent.getAttribute('contenteditable')).toBe('true');
      view.destroy();
    });
  });

  describe('conflict pause/resume', () => {
    it('suspends autosave on mdviewer:conflict-open and resumes on mdviewer:conflict-closed', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 300 }),
        threads: [],
      });
      typeInto(view, 'pending');
      // Open conflict before the debounce window expires.
      document.dispatchEvent(new CustomEvent('mdviewer:conflict-open'));
      vi.advanceTimersByTime(10_000);
      // Save must NOT have fired while conflict was open.
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      // Close conflict — pending edits should re-schedule a save.
      document.dispatchEvent(new CustomEvent('mdviewer:conflict-closed'));
      vi.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'pending');
      view.destroy();
    });

    it('destroy() removes the conflict listeners', () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 100 }),
        threads: [],
      });
      view.destroy();
      // After destroy, dispatching a conflict-closed event must not
      // trigger anything (no exceptions, no save).
      document.dispatchEvent(new CustomEvent('mdviewer:conflict-closed'));
      vi.advanceTimersByTime(10_000);
      expect(ipc.saveDocument).not.toHaveBeenCalled();
    });
  });

  describe('onSaved callback', () => {
    it('fires exactly once per save after the per-thread onAnchorsResolved pump', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const callOrder: string[] = [];
      const threads = [
        makeThread('th-1', 0, 4, 'hell'),
        makeThread('th-2', 4, 5, 'o'),
      ];
      const onAnchorsResolved = vi.fn((threadId: string) => {
        callOrder.push(`anchors:${threadId}`);
      });
      const onSaved = vi.fn((path: string) => {
        callOrder.push(`saved:${path}`);
      });
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads,
        onAnchorsResolved,
        onSaved,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(50);
      // Drain the await chain: saveDocument -> resolveAnchor (per thread) -> onSaved.
      for (let i = 0; i < 12; i++) await Promise.resolve();
      // onAnchorsResolved fires N times (one per thread).
      expect(onAnchorsResolved).toHaveBeenCalledTimes(2);
      // onSaved fires exactly once, with the document path.
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith('/tmp/a.md');
      // Ordering: every onAnchorsResolved call lands BEFORE onSaved.
      expect(callOrder).toEqual(['anchors:th-1', 'anchors:th-2', 'saved:/tmp/a.md']);
      view.destroy();
    });

    it('fires onSaved once per save even when there are zero threads (after empty anchor pump)', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const onSaved = vi.fn();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/empty.md',
        source: 'x',
        settings: makeSettings({ auto_save_debounce_ms: 25 }),
        threads: [],
        onSaved,
      });
      typeInto(view, 'y');
      vi.advanceTimersByTime(25);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onSaved).toHaveBeenCalledWith('/tmp/empty.md');
      view.destroy();
    });

    it('fires onSaved on every successful save (twice for two save cycles)', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const onSaved = vi.fn();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/multi.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 20 }),
        threads: [],
        onSaved,
      });
      typeInto(view, 'a');
      vi.advanceTimersByTime(20);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      typeInto(view, 'b');
      vi.advanceTimersByTime(20);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(onSaved).toHaveBeenCalledTimes(2);
      view.destroy();
    });

    it('does NOT fire onSaved when the view is destroyed mid-save', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      let resolveSave: ((v: unknown) => void) | undefined;
      const ipc = makeIpc({
        saveDocument: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSave = resolve;
            }),
        ),
      });
      const onSaved = vi.fn();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 30 }),
        threads: [],
        onSaved,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(30);
      view.destroy();
      resolveSave!({ kind: 'ok', etag: null });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      // destroy short-circuits the post-save path; onSaved must not fire.
      expect(onSaved).not.toHaveBeenCalled();
    });
  });

  describe('subscribeMode', () => {
    it('fires synchronously with the current mode on subscription', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const calls: Array<'render' | 'raw'> = [];
      // The push must happen INSIDE the call to subscribeMode — i.e.
      // before subscribeMode returns. We assert that by reading calls
      // immediately after the synchronous expression.
      view.subscribeMode((m) => calls.push(m));
      expect(calls).toEqual(['render']);
      view.destroy();
    });

    it('fires synchronously with the current mode when mounted with initialMode="raw"', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
        initialMode: 'raw',
      });
      const calls: Array<'render' | 'raw'> = [];
      view.subscribeMode((m) => calls.push(m));
      expect(calls).toEqual(['raw']);
      view.destroy();
    });

    it('notifies on every mode change via setMode', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const calls: Array<'render' | 'raw'> = [];
      view.subscribeMode((m) => calls.push(m));
      expect(calls).toEqual(['render']);
      view.setMode('raw');
      expect(calls).toEqual(['render', 'raw']);
      view.setMode('render');
      expect(calls).toEqual(['render', 'raw', 'render']);
      view.destroy();
    });

    it('returns an unsubscribe function that stops further notifications', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const calls: Array<'render' | 'raw'> = [];
      const unsub = view.subscribeMode((m) => calls.push(m));
      view.setMode('raw');
      expect(calls).toEqual(['render', 'raw']);
      unsub();
      view.setMode('render');
      view.setMode('raw');
      expect(calls).toEqual(['render', 'raw']);
      view.destroy();
    });

    it('isolates a throwing subscriber from later subscribers AND from the dispatch path', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const good: Array<'render' | 'raw'> = [];
      // First subscriber throws on every invocation, including the
      // synchronous initial fire. Second subscriber must still see
      // the full sequence.
      view.subscribeMode(() => {
        throw new Error('boom');
      });
      view.subscribeMode((m) => good.push(m));
      expect(good).toEqual(['render']);
      // setMode dispatches must not be aborted by the throwing
      // subscriber — the good subscriber receives the change.
      expect(() => view.setMode('raw')).not.toThrow();
      expect(good).toEqual(['render', 'raw']);
      view.destroy();
    });

    it('swallows a throwing onSaved callback without breaking the save promise', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const onSaved = vi.fn(() => {
        throw new Error('onSaved boom');
      });
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 20 }),
        threads: [],
        onSaved,
      });
      typeInto(view, 'x');
      vi.advanceTimersByTime(20);
      // Drain the save chain. The throw inside onSaved must not
      // surface as an unhandled rejection.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(onSaved).toHaveBeenCalledTimes(1);
      // Save still completed normally.
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('supports multiple subscribers — each gets the full sequence independently', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const a: Array<'render' | 'raw'> = [];
      const b: Array<'render' | 'raw'> = [];
      view.subscribeMode((m) => a.push(m));
      view.subscribeMode((m) => b.push(m));
      // Both received the initial synchronous fire.
      expect(a).toEqual(['render']);
      expect(b).toEqual(['render']);
      view.setMode('raw');
      expect(a).toEqual(['render', 'raw']);
      expect(b).toEqual(['render', 'raw']);
      view.destroy();
    });
  });

  describe('post-save re-anchor', () => {
    it('calls ipc.resolveAnchor once per thread after a successful save and invokes onAnchorsResolved', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [
        makeThread('th-1', 0, 4, 'hell'),
        makeThread('th-2', 4, 5, 'o'),
      ];
      const onAnchorsResolved = vi.fn();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads,
        onAnchorsResolved,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(50);
      // Drain the await chain: saveDocument -> resolveAnchor (per thread).
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(2);
      expect(ipc.resolveAnchor).toHaveBeenNthCalledWith(1, 't', threads[0].anchor);
      expect(ipc.resolveAnchor).toHaveBeenNthCalledWith(2, 't', threads[1].anchor);
      expect(onAnchorsResolved).toHaveBeenCalledTimes(2);
      expect(onAnchorsResolved).toHaveBeenCalledWith('th-1', { kind: 'resolved', start: 0, end: 1 });
      expect(onAnchorsResolved).toHaveBeenCalledWith('th-2', { kind: 'resolved', start: 0, end: 1 });
      view.destroy();
    });

    it('does not call resolveAnchor if there are no threads', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads: [],
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(50);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
      view.destroy();
    });
  });

  describe('WEBDRIVER forceSave handle', () => {
    it('attaches window.__mdviewerE2E.forceSave when __WEBDRIVER__ is truthy and clears it on destroy', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings(),
        threads: [],
      });
      const e2e = (window as unknown as { __mdviewerE2E?: { forceSave?: () => Promise<void> } })
        .__mdviewerE2E;
      expect(e2e).toBeDefined();
      expect(typeof e2e!.forceSave).toBe('function');
      view.destroy();
      const after = (window as unknown as { __mdviewerE2E?: { forceSave?: () => Promise<void> } })
        .__mdviewerE2E;
      // The slot is gone; the parent object remains untouched.
      expect(after?.forceSave).toBeUndefined();
    });

    it('preserves other slots on the existing __mdviewerE2E object', () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      (window as unknown as { __mdviewerE2E: Record<string, unknown> }).__mdviewerE2E = {
        nextPick: '/tmp/foo.md',
      };
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const e2e = (window as unknown as {
        __mdviewerE2E: { forceSave?: () => Promise<void>; nextPick?: string };
      }).__mdviewerE2E;
      expect(typeof e2e.forceSave).toBe('function');
      expect(e2e.nextPick).toBe('/tmp/foo.md');
      view.destroy();
      const after = (window as unknown as {
        __mdviewerE2E: { forceSave?: () => Promise<void>; nextPick?: string };
      }).__mdviewerE2E;
      expect(after.forceSave).toBeUndefined();
      // Sibling slot survives.
      expect(after.nextPick).toBe('/tmp/foo.md');
    });

    it('does NOT attach __mdviewerE2E.forceSave when __WEBDRIVER__ is falsy', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const e2e = (window as unknown as { __mdviewerE2E?: { forceSave?: () => Promise<void> } })
        .__mdviewerE2E;
      expect(e2e?.forceSave).toBeUndefined();
      view.destroy();
    });

    it('forceSave() flushes pending autosave immediately', async () => {
      vi.useFakeTimers();
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 10_000 }),
        threads: [],
      });
      typeInto(view, 'now');
      // The debounce is 10s but forceSave must flush immediately.
      const forceSave = (window as unknown as {
        __mdviewerE2E: { forceSave: () => Promise<void> };
      }).__mdviewerE2E.forceSave;
      await forceSave();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'now');
      // The pending timer should have been cancelled — advancing past
      // the debounce window does not trigger a second save.
      vi.advanceTimersByTime(20_000);
      await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      view.destroy();
    });
  });

  describe('WEBDRIVER selection + type hooks', () => {
    it('attaches setLiveEditorSelection and typeIntoLiveEditor when __WEBDRIVER__ is truthy and clears them on destroy', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello world',
        settings: makeSettings(),
        threads: [],
      });
      const e2e = (window as unknown as {
        __mdviewerE2E?: {
          setLiveEditorSelection?: (s: number, e: number) => Promise<void>;
          typeIntoLiveEditor?: (t: string) => Promise<void>;
        };
      }).__mdviewerE2E;
      expect(e2e).toBeDefined();
      expect(typeof e2e!.setLiveEditorSelection).toBe('function');
      expect(typeof e2e!.typeIntoLiveEditor).toBe('function');
      view.destroy();
      const after = (window as unknown as {
        __mdviewerE2E?: {
          setLiveEditorSelection?: (s: number, e: number) => Promise<void>;
          typeIntoLiveEditor?: (t: string) => Promise<void>;
        };
      }).__mdviewerE2E;
      // Both slots are cleared on destroy.
      expect(after?.setLiveEditorSelection).toBeUndefined();
      expect(after?.typeIntoLiveEditor).toBeUndefined();
    });

    it('does NOT attach selection/type hooks when __WEBDRIVER__ is falsy', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const e2e = (window as unknown as {
        __mdviewerE2E?: {
          setLiveEditorSelection?: (s: number, e: number) => Promise<void>;
          typeIntoLiveEditor?: (t: string) => Promise<void>;
        };
      }).__mdviewerE2E;
      // The hook object isn't even created in this branch.
      expect(e2e?.setLiveEditorSelection).toBeUndefined();
      expect(e2e?.typeIntoLiveEditor).toBeUndefined();
      view.destroy();
    });

    it('setLiveEditorSelection moves the caret to the requested source offset', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello world',
        settings: makeSettings(),
        threads: [],
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      await setSel(6, 6);
      const sel = view.editorView.state.selection.main;
      expect(sel.from).toBe(6);
      expect(sel.to).toBe(6);
      view.destroy();
    });

    it('setLiveEditorSelection supports a non-empty range (start < end)', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello world',
        settings: makeSettings(),
        threads: [],
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      await setSel(0, 5);
      const sel = view.editorView.state.selection.main;
      expect(sel.from).toBe(0);
      expect(sel.to).toBe(5);
      view.destroy();
    });

    it('setLiveEditorSelection clamps offsets that fall outside the document length', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'abc',
        settings: makeSettings(),
        threads: [],
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      // Negative start and an end past EOF — both must clamp.
      await setSel(-10, 9999);
      const sel = view.editorView.state.selection.main;
      expect(sel.from).toBe(0);
      expect(sel.to).toBe(3); // doc length
      view.destroy();
    });

    it('typeIntoLiveEditor inserts text at the current caret and flips dirty/autosave like a real keystroke', async () => {
      vi.useFakeTimers();
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello world',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads: [],
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      const typeIn = (window as unknown as {
        __mdviewerE2E: { typeIntoLiveEditor: (t: string) => Promise<void> };
      }).__mdviewerE2E.typeIntoLiveEditor;

      await setSel(5, 5); // between "hello" and " world"
      await typeIn('Z');
      expect(view.currentSource()).toBe('helloZ world');
      // Dirty hint to the watcher fired.
      expect(ipc.setDirty).toHaveBeenCalledWith('/tmp/a.md', true);
      // Debounce fires after 50ms.
      vi.advanceTimersByTime(50);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'helloZ world');
      view.destroy();
    });

    it('typeIntoLiveEditor replaces a non-empty selection with the inserted text', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'abc def',
        settings: makeSettings(),
        threads: [],
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      const typeIn = (window as unknown as {
        __mdviewerE2E: { typeIntoLiveEditor: (t: string) => Promise<void> };
      }).__mdviewerE2E.typeIntoLiveEditor;
      await setSel(0, 3); // select "abc"
      await typeIn('XYZ');
      expect(view.currentSource()).toBe('XYZ def');
      // Caret now sits at the end of the inserted text.
      const sel = view.editorView.state.selection.main;
      expect(sel.from).toBe(3);
      expect(sel.to).toBe(3);
      view.destroy();
    });

    it('setLiveEditorSelection dispatches a bubbling mouseup on contentDOM AFTER applying the selection transaction', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello world',
        settings: makeSettings(),
        threads: [],
      });
      const observed: Array<{ kind: 'mouseup'; bubbles: boolean; from: number; to: number }> = [];
      view.editorView.contentDOM.addEventListener('mouseup', (e) => {
        const sel = view.editorView.state.selection.main;
        observed.push({
          kind: 'mouseup',
          bubbles: e.bubbles,
          from: sel.from,
          to: sel.to,
        });
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      await setSel(2, 5);
      // mouseup fired exactly once, bubbles=true, and at the moment of
      // the listener the selection transaction had already applied.
      expect(observed).toHaveLength(1);
      expect(observed[0]).toEqual({
        kind: 'mouseup',
        bubbles: true,
        from: 2,
        to: 5,
      });
      view.destroy();
    });

    it('setLiveEditorSelection mouseup target is the editor view contentDOM (the .cm-content element)', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'abcdef',
        settings: makeSettings(),
        threads: [],
      });
      const targets: EventTarget[] = [];
      view.editorView.contentDOM.addEventListener('mouseup', (e) => {
        targets.push(e.target as EventTarget);
      });
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      await setSel(1, 1);
      expect(targets).toHaveLength(1);
      // The event was dispatched ON the contentDOM (so target === contentDOM
      // because no inner element was synthesised). The contentDOM carries
      // the cm-content class.
      expect(view.editorView.contentDOM.classList.contains('cm-content')).toBe(true);
      expect(targets[0]).toBe(view.editorView.contentDOM);
      view.destroy();
    });

    it('setLiveEditorSelection and typeIntoLiveEditor are no-ops after destroy()', async () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'abc',
        settings: makeSettings(),
        threads: [],
      });
      // Capture references BEFORE destroy clears them off the global.
      const setSel = (window as unknown as {
        __mdviewerE2E: { setLiveEditorSelection: (s: number, e: number) => Promise<void> };
      }).__mdviewerE2E.setLiveEditorSelection;
      const typeIn = (window as unknown as {
        __mdviewerE2E: { typeIntoLiveEditor: (t: string) => Promise<void> };
      }).__mdviewerE2E.typeIntoLiveEditor;
      view.destroy();
      // Calling either after destroy must not throw and must not
      // observably mutate the (already-destroyed) view.
      await expect(setSel(0, 2)).resolves.toBeUndefined();
      await expect(typeIn('Q')).resolves.toBeUndefined();
      expect(ipc.saveDocument).not.toHaveBeenCalled();
    });
  });

  describe('WEBDRIVER getLiveEditorSource hook', () => {
    it('attaches window.__mdviewerE2E.getLiveEditorSource when __WEBDRIVER__ is truthy and returns the initial doc', () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '# title\n\nbody',
        settings: makeSettings(),
        threads: [],
      });
      const getSrc = (window as unknown as {
        __mdviewerE2E: { getLiveEditorSource: () => string };
      }).__mdviewerE2E.getLiveEditorSource;
      expect(typeof getSrc).toBe('function');
      expect(getSrc()).toBe('# title\n\nbody');
      view.destroy();
    });

    it('getLiveEditorSource reflects edits made after mount', () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'abc',
        settings: makeSettings(),
        threads: [],
      });
      const getSrc = (window as unknown as {
        __mdviewerE2E: { getLiveEditorSource: () => string };
      }).__mdviewerE2E.getLiveEditorSource;
      expect(getSrc()).toBe('abc');
      // Insert at the start.
      view.editorView.dispatch({
        changes: { from: 0, insert: 'XX-' },
      });
      expect(getSrc()).toBe('XX-abc');
      view.destroy();
    });

    it('does NOT attach getLiveEditorSource when __WEBDRIVER__ is falsy', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      const e2e = (window as unknown as {
        __mdviewerE2E?: { getLiveEditorSource?: () => string };
      }).__mdviewerE2E;
      expect(e2e?.getLiveEditorSource).toBeUndefined();
      view.destroy();
    });

    it('destroy() removes the getLiveEditorSource slot', () => {
      (window as unknown as Record<string, unknown>).__WEBDRIVER__ = true;
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'abc',
        settings: makeSettings(),
        threads: [],
      });
      expect(
        (window as unknown as { __mdviewerE2E: { getLiveEditorSource: () => string } })
          .__mdviewerE2E.getLiveEditorSource,
      ).toBeInstanceOf(Function);
      view.destroy();
      const after = (window as unknown as {
        __mdviewerE2E?: { getLiveEditorSource?: () => string };
      }).__mdviewerE2E;
      expect(after?.getLiveEditorSource).toBeUndefined();
    });
  });

  describe('error-path tolerance', () => {
    it('swallows a setDirty rejection on first input without breaking autosave', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc({
        // setDirty rejects on the first call (the dirty=true hint).
        setDirty: vi.fn().mockRejectedValue(new Error('watcher unreachable')),
      });
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads: [],
      });
      typeInto(view, 'q');
      // Flush microtask so the rejection is observed (and swallowed).
      await Promise.resolve();
      await Promise.resolve();
      vi.advanceTimersByTime(50);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // The save still fired despite setDirty failing.
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('swallows resolveAnchor rejection per thread without aborting the loop', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc({
        resolveAnchor: vi
          .fn()
          // First thread rejects, second resolves — the loop must continue.
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce({ kind: 'orphan' } as ResolveOutcome),
      });
      const threads = [
        makeThread('th-1', 0, 4, 'hell'),
        makeThread('th-2', 4, 5, 'o'),
      ];
      const onAnchorsResolved = vi.fn();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads,
        onAnchorsResolved,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(50);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(2);
      // Only the second thread fed back through the callback (first errored).
      expect(onAnchorsResolved).toHaveBeenCalledTimes(1);
      expect(onAnchorsResolved).toHaveBeenCalledWith('th-2', { kind: 'orphan' });
      view.destroy();
    });

    it('does not re-anchor when the view is destroyed mid-save', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      let resolveSave: ((v: unknown) => void) | undefined;
      const ipc = makeIpc({
        saveDocument: vi.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveSave = resolve;
            }),
        ),
      });
      const threads = [makeThread('th-1', 0, 4, 'hell')];
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 30 }),
        threads,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(30);
      // The save is in flight; destroy before it resolves.
      view.destroy();
      resolveSave!({ kind: 'ok', etag: null });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // The post-save re-anchor never runs because destroy short-circuited.
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
    });

    it('forceSave invoked after destroy() is a no-op', async () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      view.destroy();
      // After destroy, forceSave must not invoke saveDocument.
      await view.forceSave();
      expect(ipc.saveDocument).not.toHaveBeenCalled();
    });

    it('setMode after destroy is a no-op', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings(),
        threads: [],
      });
      view.destroy();
      // No throw, no observable side-effect.
      expect(() => view.setMode('raw')).not.toThrow();
    });
  });

  describe('mounting with explicit initialMode', () => {
    it('honours args.initialMode === "raw"', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ render_readonly: true }),
        threads: [],
        initialMode: 'raw',
      });
      expect(view.mode()).toBe('raw');
      // Even with render_readonly=true, raw mode is editable.
      const cmContent = root.querySelector<HTMLElement>('.cm-content')!;
      expect(cmContent.getAttribute('contenteditable')).toBe('true');
      view.destroy();
    });
  });

  describe('view-level forceSave/currentSource/destroy', () => {
    it('view.forceSave flushes pending edits and returns', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 5000 }),
        threads: [],
      });
      typeInto(view, 'force');
      await view.forceSave();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'force');
      view.destroy();
    });

    it('view.currentSource reflects the live editor doc', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'initial',
        settings: makeSettings(),
        threads: [],
      });
      expect(view.currentSource()).toBe('initial');
      typeInto(view, '+more');
      expect(view.currentSource()).toBe('initial+more');
      view.destroy();
    });

    it('view.destroy() removes the editor DOM and prevents pending autosaves from firing', () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: '',
        settings: makeSettings({ auto_save_debounce_ms: 500 }),
        threads: [],
      });
      typeInto(view, 'x');
      view.destroy();
      vi.advanceTimersByTime(2000);
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      expect(root.querySelector('.cm-editor')).toBeNull();
    });
  });
});
