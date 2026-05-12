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
