import { describe, it, expect, vi, afterEach } from 'vitest';
import { StateEffect, type Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';

import { mountLiveEditor } from '../../src/views/LiveEditor';
import type { Settings, Thread, ResolveOutcome } from '../../src/types-generated';
// B.6 integration smoke imports the Phase-2 extensions and asserts
// they compose cleanly with the Phase-1 LiveEditor host. The factories
// themselves are unit-tested in tests/views/decorations/*.test.ts;
// here we only verify the wire-up invariants spec'd in plan task B.6.
import { inlineMarks, inlineMarksKeymap } from '../../src/views/decorations/inlineMarks';
import { blockWidgets } from '../../src/views/decorations/blocks';
import { tables } from '../../src/views/decorations/tables';
import { commentHighlights } from '../../src/views/decorations/commentHighlights';
import { pasteHandler } from '../../src/views/decorations/paste';

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

  describe('idle re-anchor', () => {
    it('fires resolve_anchor for each thread once after editor.idle_reanchor_ms of quiescence', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [
        makeThread('th-1', 0, 4, 'hell'),
        makeThread('th-2', 4, 5, 'o'),
      ];
      const onAnchorsResolved = vi.fn();
      const view = mountLiveEditor(root, ipc as never, {
        // Auto-save debounce is much higher than idle so the idle pump
        // is the only thing that can fire resolveAnchor in this window.
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 60_000 }),
        threads,
        onAnchorsResolved,
      });
      typeInto(view, '!');
      // Idle defaults to 1500ms — advance to just before and assert nothing fired.
      vi.advanceTimersByTime(1499);
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
      // Cross the idle boundary; the pump drains a thread-count of microtasks.
      vi.advanceTimersByTime(1);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(2);
      expect(ipc.resolveAnchor).toHaveBeenNthCalledWith(1, 't', threads[0].anchor);
      expect(ipc.resolveAnchor).toHaveBeenNthCalledWith(2, 't', threads[1].anchor);
      // onAnchorsResolved fed each outcome back so commentHighlights can repaint.
      expect(onAnchorsResolved).toHaveBeenCalledTimes(2);
      view.destroy();
    });

    it('resets the idle timer on every user-input transaction (typing keeps it pending)', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [makeThread('th-1', 0, 4, 'hell')];
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 60_000 }),
        threads,
      });
      typeInto(view, 'a');
      vi.advanceTimersByTime(1000);
      // Another keystroke before the idle window expires resets the timer.
      typeInto(view, 'b');
      vi.advanceTimersByTime(1000);
      typeInto(view, 'c');
      vi.advanceTimersByTime(1499);
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('does not fire idle re-anchor when the editor is not dirty', () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [makeThread('th-1', 0, 4, 'hell')];
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 60_000 }),
        threads,
      });
      // No user input — the idle timer never starts.
      vi.advanceTimersByTime(10_000);
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
      view.destroy();
    });

    it('does not fire idle re-anchor while a save is in flight', async () => {
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
        // Auto-save debounce is shorter than idle so the save lands first
        // and stays in-flight while we cross the idle boundary.
        settings: makeSettings({ auto_save_debounce_ms: 100 }),
        threads,
      });
      typeInto(view, '!');
      // The autosave debounce fires; saveDocument is invoked but the
      // returned promise never resolves -> save stays in flight.
      vi.advanceTimersByTime(100);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
      // Cross the idle boundary while the save is in-flight.
      vi.advanceTimersByTime(2_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      // Save has not resolved, so the post-save re-anchor pump has not
      // run AND the idle pump must NOT have run either.
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
      // Now let the save resolve; the post-save pump fires its own
      // resolveAnchor pass (already covered by other tests) — but the
      // idle pump did not double-fire while the save was in flight.
      resolveSave!({ kind: 'ok', etag: null });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      // Exactly the post-save resolveAnchor pass — once per thread.
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('saving cancels the pending idle timer (idle pump does not double-fire after save)', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [makeThread('th-1', 0, 4, 'hell')];
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        // Autosave fires WELL before the idle window expires.
        settings: makeSettings({ auto_save_debounce_ms: 50 }),
        threads,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(50);
      // Drain the save chain: saveDocument -> resolveAnchor -> setDirty(false).
      for (let i = 0; i < 12; i++) await Promise.resolve();
      // Post-save re-anchor fired exactly once.
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(1);
      // Now cross the would-have-been idle boundary. Since the save
      // cancelled the pending idle timer, no second resolveAnchor pass.
      vi.advanceTimersByTime(2_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('picks up settings.editor.idle_reanchor_ms override (800ms)', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [makeThread('th-1', 0, 4, 'hell')];
      // The corresponding types-generated.ts field lands in B.4; cast to
      // `any` so this test compiles in the meantime (intentional cross-
      // phase ordering — see plan.json B.2 done_when).
      const settings = makeSettings({ auto_save_debounce_ms: 60_000 });
      (settings.editor as unknown as { idle_reanchor_ms: number }).idle_reanchor_ms = 800;
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: settings,
        threads,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(799);
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('idle pump does not fire after destroy()', () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc();
      const threads = [makeThread('th-1', 0, 4, 'hell')];
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source: 'hello',
        settings: makeSettings({ auto_save_debounce_ms: 60_000 }),
        threads,
      });
      typeInto(view, '!');
      view.destroy();
      vi.advanceTimersByTime(10_000);
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();
    });

    it('idle pump swallows resolveAnchor rejection per thread without aborting', async () => {
      vi.useFakeTimers();
      const root = makeRoot();
      const ipc = makeIpc({
        resolveAnchor: vi
          .fn()
          .mockRejectedValueOnce(new Error('boom'))
          .mockResolvedValueOnce({ kind: 'resolved', start: 0, end: 1 } as ResolveOutcome),
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
        settings: makeSettings({ auto_save_debounce_ms: 60_000 }),
        threads,
        onAnchorsResolved,
      });
      typeInto(view, '!');
      vi.advanceTimersByTime(1500);
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(2);
      // Only the surviving thread fed through the callback.
      expect(onAnchorsResolved).toHaveBeenCalledTimes(1);
      expect(onAnchorsResolved).toHaveBeenCalledWith('th-2', { kind: 'resolved', start: 0, end: 1 });
      view.destroy();
    });
  });

  /**
   * B.6 — Phase-2 integration smoke.
   *
   * This block mounts a single LiveEditor instance with the full
   * Phase-1 wiring already in the host PLUS the four Phase-2
   * extensions appended via `StateEffect.appendConfig` (the exact
   * pattern Document.ts uses post-mount):
   *
   *   - tables()              — B.1 GFM table widget (per-cell
   *                             contentEditable + +row/+col/raw
   *                             toolbar).
   *   - blockWidgets({...})   — B.1 atomic widgets for code / mermaid
   *                             / html / image; tables are NOT emitted
   *                             from this set anymore (see blocks.ts
   *                             "tables.ts owns the surface").
   *   - inlineMarks() +       — B.3 caret-aware sigil hide/reveal and
   *     inlineMarksKeymap()     Cmd+B / Cmd+I / Cmd+E / Cmd+K toggles.
   *   - pasteHandler({...})   — B.4 turndown HTML→md when the user
   *                             setting `paste_html_behavior` is
   *                             `"markdown"`.
   *
   * Plus the B.2 idle-reanchor timer that lives inside `LiveEditor.ts`
   * itself (no extension to append — the timer is wired in via the
   * update listener).
   *
   * The block asserts three invariants:
   *   1) The Phase-1 byte-identical Render → Raw → Render toggle still
   *      holds (mode flips are StateEffects, NOT doc edits, even with
   *      tables/blocks/inlineMarks/paste all live).
   *   2) A user-event-tagged cell edit followed by `idle_reanchor_ms`
   *      of quiescence (with `auto_save_debounce_ms` configured WAY
   *      higher than idle) triggers EXACTLY ONE `resolve_anchor` pass
   *      per thread — the idle pump fires once and does not re-arm
   *      after the saveInFlight gate releases.
   *   3) Cmd+B dispatched on a table cell's DOM is a no-op for the
   *      table's source slice — the cell's text bytes between the
   *      surrounding pipes are unchanged. This is the "table widget
   *      owns focus" contract from the design doc: the keymap may
   *      still toggle `**` around the editor's main selection (which
   *      lives outside the atomic widget range), but it MUST NOT
   *      mutate the cell's source.
   */
  describe('B.6 — Phase-2 integration smoke (tables + paste + inlineMarks + idle re-anchor)', () => {
    /**
     * Builds the four Phase-2 extension factories with a no-op IPC
     * stub for renderMarkdown (blockWidgets needs one to satisfy its
     * options type; with no code / mermaid / html / image blocks in
     * the docs we use, the IPC is never called). The returned
     * Extension[] is dispatched on the editor via
     * `StateEffect.appendConfig` — the exact pattern Document.ts uses.
     */
    function phase2Extensions(getPasteHtmlBehavior: () => string): Extension[] {
      return [
        // Markdown language (with GFM extensions so the lezer tree
        // includes Table / Strikethrough nodes) — the decoration
        // extensions parse the tree, so this MUST come first.
        markdown({ base: markdownLanguage, extensions: [GFM] }),
        inlineMarks(),
        inlineMarksKeymap(),
        // Block widgets renderer; not exercised by the docs in this
        // suite (no fenced code / mermaid / html / image) but loaded
        // to prove it composes with tables + inlineMarks without a
        // RangeSet collision on table blocks.
        blockWidgets({
          renderMarkdown: () =>
            Promise.resolve({ html: '', anchors: [] } as unknown as never),
        }),
        tables(),
        commentHighlights(),
        pasteHandler({
          getPasteHtmlBehavior,
          // No-op loader — none of the integration-smoke tests
          // exercise the paste path; we only need the extension
          // present in the config so it can fight for the paste DOM
          // event in the same composed extension stack.
          loadTurndown: async () => ({ turndown: (s: string) => s }),
        }),
      ];
    }

    /**
     * Mount a LiveEditor and immediately dispatch the Phase-2
     * extensions via `StateEffect.appendConfig`. Returns both the
     * LiveEditor handle and the underlying EditorView for tests that
     * need to reach into the DOM (e.g. the table-cell keymap probe).
     */
    function mountWithPhase2(
      source: string,
      ipc: IpcStub,
      args: {
        threads?: Thread[];
        autoSaveMs?: number;
        idleMs?: number;
        renderReadonly?: boolean;
        pasteBehavior?: string;
        onAnchorsResolved?: (id: string, outcome: ResolveOutcome) => void;
      } = {},
    ): { view: ReturnType<typeof mountLiveEditor>; root: HTMLElement } {
      const root = makeRoot();
      const settings = makeSettings({
        auto_save_debounce_ms: args.autoSaveMs ?? 60_000,
        render_readonly: args.renderReadonly ?? false,
      });
      // B.2 — `idle_reanchor_ms` is read off the editor settings via
      // a one-line cast in LiveEditor.ts (cross-phase ordering: B.4
      // wires the field into types-generated.ts).
      (settings.editor as unknown as { idle_reanchor_ms: number }).idle_reanchor_ms =
        args.idleMs ?? 1500;
      const view = mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/tmp/a.md',
        source,
        settings,
        threads: args.threads ?? [],
        onAnchorsResolved: args.onAnchorsResolved,
      });
      view.editorView.dispatch({
        effects: StateEffect.appendConfig.of(
          phase2Extensions(() => args.pasteBehavior ?? 'plain'),
        ),
      });
      return { view, root };
    }

    /**
     * Invariant #1 — Phase-1 byte-identical Render → Raw → Render
     * toggle still holds with all Phase-2 extensions loaded.
     *
     * Mode flips are StateEffects (NOT doc changes), so even with
     * decoration extensions that render widgets / hide sigils, the
     * underlying `state.doc.toString()` MUST be byte-identical
     * before/after each flip. This is the contract that lets the
     * "open in raw to copy bytes" workflow round-trip without
     * introducing whitespace drift from the Render-side rendering.
     */
    it('Render → Raw → Render keeps the document bytes identical with all Phase-2 extensions loaded', () => {
      const ipc = makeIpc();
      // A document that exercises tables, inline marks, AND would
      // exercise blockWidgets if there were a fenced code block (we
      // skip that here to avoid the async renderMarkdown round-trip).
      // The trailing newline keeps the table well-formed under GFM.
      const source = [
        '# Title',
        '',
        'A paragraph with **bold** and *italic* and `code`.',
        '',
        '| Col A | Col B |',
        '|-------|-------|',
        '| 1     | 2     |',
        '| 3     | 4     |',
        '',
      ].join('\n');
      const { view } = mountWithPhase2(source, ipc);

      const initialBytes = view.editorView.state.doc.toString();
      expect(initialBytes).toBe(source);

      view.setMode('raw');
      const afterRaw = view.editorView.state.doc.toString();
      expect(afterRaw).toBe(initialBytes);

      view.setMode('render');
      const afterRenderAgain = view.editorView.state.doc.toString();
      expect(afterRenderAgain).toBe(initialBytes);

      // Belt and suspenders — `view.currentSource()` is the public
      // surface Document.ts reads via `LiveEditorView.currentSource`,
      // and must agree with `state.doc.toString()`.
      expect(view.currentSource()).toBe(source);

      // No autosave fired during the mode toggles — autosave was
      // already proven inert for mode toggles by the Phase-1 mode
      // test above; this assertion locks the same invariant in the
      // Phase-2 composed stack.
      expect(ipc.saveDocument).not.toHaveBeenCalled();

      view.destroy();
    });

    /**
     * Invariant #2 — A table cell edit followed by an idle pause
     * fires `resolve_anchor` exactly ONCE per thread. The idle pump
     * MUST be the only thing that calls `resolve_anchor` in this
     * test window — autosave is configured well past the idle
     * window, so it cannot beat the idle pump to the IPC.
     *
     * This locks the `saveInFlight` gate / idle-cancel-on-save
     * contract from B.2 in the composed Phase-2 stack: if the gate
     * were broken, a second pass (post-save) would land after the
     * idle pass, and the resolveAnchor call count would be 2 per
     * thread.
     */
    it('a table cell edit followed by an idle pause fires resolve_anchor exactly once per thread', async () => {
      vi.useFakeTimers();
      const ipc = makeIpc();
      const threads = [
        makeThread('th-1', 0, 4, 'hell'),
        makeThread('th-2', 4, 5, 'o'),
      ];
      const onAnchorsResolved = vi.fn();
      const source = '| h1 | h2 |\n|----|----|\n| body | x |\n';
      const { view } = mountWithPhase2(source, ipc, {
        threads,
        // Autosave debounce is much higher than the idle window, so
        // the idle pump fires first (and would-be autosave never
        // arrives within this test's timer advances).
        autoSaveMs: 60_000,
        idleMs: 1500,
        onAnchorsResolved,
      });

      // Drive a table-cell edit through the same path the cell-input
      // DOM listener uses: a user-event-tagged transaction. This
      // mirrors what tables.ts dispatches when the user types into a
      // contentEditable cell.
      view.editorView.dispatch({
        // Replace " body " with " hello " inside the cell — offsets
        // inside the source, NOT around the pipes.
        changes: { from: 25, to: 30, insert: 'hello' },
        userEvent: 'input.cell-edit',
      });
      // The doc has mutated; dirty is set; autosave debounce is
      // armed (60s) but the idle timer (1.5s) is armed too.
      expect(ipc.saveDocument).not.toHaveBeenCalled();
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();

      // Cross the idle boundary. Drain microtasks so the per-thread
      // resolveAnchor await chain settles.
      vi.advanceTimersByTime(1500);
      for (let i = 0; i < 12; i++) await Promise.resolve();

      // Exactly one resolveAnchor pass per thread.
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(threads.length);
      expect(ipc.resolveAnchor).toHaveBeenNthCalledWith(1, 't', threads[0].anchor);
      expect(ipc.resolveAnchor).toHaveBeenNthCalledWith(2, 't', threads[1].anchor);
      // onAnchorsResolved was fed for each thread.
      expect(onAnchorsResolved).toHaveBeenCalledTimes(threads.length);
      // And — critically — saveDocument has NOT fired (autosave is
      // 60s; we only advanced 1.5s), so the post-save pump cannot be
      // the source of these calls.
      expect(ipc.saveDocument).not.toHaveBeenCalled();

      // Advance past where a second idle pump WOULD have fired if
      // the timer re-armed itself after the first run. The pump must
      // NOT double-fire: it consumes its `idleTimer` slot inside
      // `runIdleReanchor` and only re-arms on a fresh user input.
      vi.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(threads.length);

      view.destroy();
    });

    /**
     * Invariant #2b — the `saveInFlight` gate in particular. Setup
     * is the inverse cadence of the test above: autosave is shorter
     * than idle, so the save lands first and is in flight while the
     * would-be idle boundary passes. The idle pump MUST NOT fire
     * while `saveInFlight` is true, and the post-save pump fires
     * exactly once per thread. Final tally: one resolveAnchor pass
     * per thread, sourced from the post-save pump alone.
     */
    it('idle re-anchor does not double-fire after a save (saveInFlight gate)', async () => {
      vi.useFakeTimers();
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
      const source = '| h1 | h2 |\n|----|----|\n| body | x |\n';
      const { view } = mountWithPhase2(source, ipc, {
        threads,
        // Autosave shorter than idle so the save lands first.
        autoSaveMs: 100,
        idleMs: 1500,
      });

      view.editorView.dispatch({
        changes: { from: 25, to: 30, insert: 'hello' },
        userEvent: 'input.cell-edit',
      });
      // Autosave fires; saveDocument is invoked but the promise stays
      // unresolved -> save is in-flight.
      vi.advanceTimersByTime(100);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      expect(ipc.saveDocument).toHaveBeenCalledTimes(1);

      // Cross the idle boundary while the save is in flight. The
      // idle pump must NOT fire because `saveInFlight === true`.
      // (Even if some future change forgot to cancel the idle
      // timer on `flushSave`, the `runIdleReanchor` `saveInFlight`
      // guard short-circuits before the IPC.)
      vi.advanceTimersByTime(5_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).not.toHaveBeenCalled();

      // Let the save resolve. The post-save pump fires resolveAnchor
      // once per thread.
      resolveSave!({ kind: 'ok', etag: null });
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(threads.length);

      // Advance further — no second idle pass after the save's
      // re-anchor pump returns. `flushSave` cancels the pending
      // idle timer; with no fresh user input the timer stays
      // disarmed.
      vi.advanceTimersByTime(10_000);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(ipc.resolveAnchor).toHaveBeenCalledTimes(threads.length);

      view.destroy();
    });

    /**
     * Invariant #3 — Cmd+B dispatched on a table cell DOM does NOT
     * mutate the cell's source slice. The table widget is atomic
     * (atomicRanges facet) — the CodeMirror main selection cannot
     * land inside the widget range via ordinary cursor motion, so
     * if the keymap fires while the user's focus is on a cell
     * (browser-level focus), the keymap acts on the clamped main
     * selection which lives OUTSIDE the table. The cell's source
     * bytes therefore stay byte-identical.
     *
     * The test dispatches a bubbling Cmd+B `keydown` on the cell
     * element — the same DOM-level event the browser would emit
     * if the user pressed Cmd+B while typing into the cell — and
     * checks that the table source slice round-trips unchanged.
     */
    it('Cmd+B on a table cell does not insert ** around the cell source slice', () => {
      const ipc = makeIpc();
      // Pad the doc with a paragraph BEFORE the table so the main
      // editor selection at offset 0 lives outside the widget range.
      // If the keymap ends up dispatching an empty-selection wrap,
      // the `****` lands in the paragraph — NOT in the table cell.
      const paragraph = 'A paragraph.\n\n';
      const tableSource = '| h1 | h2 |\n|----|----|\n| body | x |\n';
      const source = paragraph + tableSource;
      const { view, root } = mountWithPhase2(source, ipc);

      // Sanity — the table widget materialised in the DOM. Without
      // this query the test couldn't dispatch a realistic keydown
      // on the cell, so the assertion is load-bearing.
      const cell = root.querySelector<HTMLElement>(
        '[data-testid="table-widget"] [data-row="0"][data-col="0"]',
      );
      expect(cell).not.toBeNull();
      expect(cell!.textContent).toBe('body');

      // Dispatch a bubbling Cmd+B keydown on the cell. Ctrl is the
      // platform-correct modifier in jsdom (CM's `Mod-` resolves to
      // Ctrl when `navigator.platform` is not a Mac, which jsdom's
      // default is not).
      const event = new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      cell!.dispatchEvent(event);

      // The TABLE'S source slice — between the surrounding pipes —
      // is byte-identical. Specifically: the cell text "body" was
      // NOT wrapped in `**`, and the column-separator pipes /
      // alignment row / header are all intact.
      const docAfter = view.editorView.state.doc.toString();
      expect(docAfter.includes(tableSource.trimEnd())).toBe(true);
      // The cell's source slice — the four-byte substring "body" —
      // appears exactly once, NOT as "**body**" or with any other
      // sigil injection inside the table region.
      const tableStart = docAfter.indexOf('| h1');
      expect(tableStart).toBeGreaterThanOrEqual(0);
      const tableSlice = docAfter.slice(tableStart);
      expect(tableSlice.startsWith(tableSource.trimEnd())).toBe(true);
      // Defense-in-depth: no `**` injected anywhere inside the
      // table source slice. If a future change made the keymap
      // mutate the cell, this assertion would flip first.
      const tableExtent = tableSource.trimEnd().length;
      expect(tableSlice.slice(0, tableExtent).includes('**')).toBe(false);

      view.destroy();
    });

    /**
     * Invariant #3 follow-up — the same Cmd+B dispatch, but checking
     * that the keymap's "act on main selection" semantics still hold
     * for selections outside the widget. We aren't asserting the
     * exact placement of any inserted `**` (that's the inlineMarks
     * keymap's contract, covered in its own test file) — only that
     * dispatching Cmd+B on a cell does NOT throw, does NOT destroy
     * the editor, and does NOT remove the table widget from the DOM.
     */
    it('Cmd+B on a table cell does not destroy the editor host or remove the table widget', () => {
      const ipc = makeIpc();
      const source = 'A paragraph.\n\n| h1 | h2 |\n|----|----|\n| body | x |\n';
      const { view, root } = mountWithPhase2(source, ipc);

      const cell = root.querySelector<HTMLElement>(
        '[data-testid="table-widget"] [data-row="0"][data-col="0"]',
      )!;
      const event = new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      expect(() => cell.dispatchEvent(event)).not.toThrow();
      // Editor DOM and the table widget both survive the dispatch.
      expect(root.querySelector('.cm-editor')).not.toBeNull();
      expect(root.querySelector('[data-testid="table-widget"]')).not.toBeNull();

      view.destroy();
    });
  });

  describe('word_wrap (2026-05-14 regression: horizontal scrollbar)', () => {
    // Regression: before this fix the LiveEditor's CodeMirror surface
    // did not wire EditorView.lineWrapping, so long lines overflowed
    // horizontally and the user got a scrollbar over the whole doc.
    // Pre-wysiwyg, the Document view used a plain HTML render region
    // that wrapped via CSS; the A.9 swap to a single CodeMirror surface
    // dropped the implicit wrapping. settings.editor.word_wrap exists
    // and has a Settings UI checkbox but was never consumed — this
    // test pins the consumer.
    function lineWrappingClassPresent(root: HTMLElement): boolean {
      // CodeMirror's EditorView.lineWrapping extension is implemented
      // as contentAttributes.of({class: 'cm-lineWrapping'}). When the
      // extension is in the config the cm-content element carries
      // that class. We assert the class because the alternative
      // (jsdom computedStyle white-space) doesn't behave in tests.
      return root.querySelector('.cm-content.cm-lineWrapping') !== null;
    }

    it('cm-content carries the cm-lineWrapping class when editor.word_wrap is true', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/p.md',
        source: 'a very long line '.repeat(80),
        settings: makeSettings({ word_wrap: true }),
        threads: [],
      });
      expect(lineWrappingClassPresent(root)).toBe(true);
    });

    it('cm-content does NOT carry cm-lineWrapping when editor.word_wrap is false', () => {
      const root = makeRoot();
      const ipc = makeIpc();
      mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/p.md',
        source: 'a very long line '.repeat(80),
        settings: makeSettings({ word_wrap: false }),
        threads: [],
      });
      expect(lineWrappingClassPresent(root)).toBe(false);
    });

    it('defaults to wrapping when settings.editor.word_wrap is missing (matches pre-A.9 behavior)', () => {
      // Defensive: the legacy code path always wrapped (HTML render
      // region wrapped via CSS). If a settings shape lands without the
      // word_wrap field (older sidecar, hand-crafted test fixture),
      // the editor must NOT suddenly turn off wrapping. Default = true.
      const root = makeRoot();
      const ipc = makeIpc();
      // Cast to delete the field — simulates a settings snapshot from
      // before the word_wrap key was added to EditorSettings.
      const settings = makeSettings();
      delete (settings.editor as unknown as { word_wrap?: boolean }).word_wrap;
      mountLiveEditor(root, ipc as never, {
        tabId: 't',
        path: '/p.md',
        source: 'short',
        settings,
        threads: [],
      });
      expect(lineWrappingClassPresent(root)).toBe(true);
    });
  });
});
