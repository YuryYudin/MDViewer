import { describe, it, expect, vi, afterEach } from 'vitest';
import { mountDocument } from '../../src/views/Document';
import type { Ipc, Settings } from '../../src/ipc';

const html =
  '<p><span data-src-offset="0" data-src-end="5">Hello</span> <span data-src-offset="6" data-src-end="11">world</span>.</p>';

function ipc(): Ipc {
  return {
    resolveAnchor: vi.fn().mockResolvedValue({ kind: 'resolved', start: 0, end: 5 }),
    createThread: vi.fn().mockResolvedValue({
      id: 't-new',
      anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
      comments: [
        {
          id: 'c-1',
          author: 'Mira',
          color: '#c98a2b',
          body: 'First note',
          created_at: '2026-04-28T00:00:00Z',
        },
      ],
      resolved: false,
    }),
    listThreads: vi.fn().mockResolvedValue([]),
    saveDocument: vi.fn().mockResolvedValue({ kind: 'ok', etag: null }),
    setDirty: vi.fn().mockResolvedValue(undefined),
    renderMarkdown: vi.fn().mockResolvedValue({
      html: '<p><span data-src-offset="0" data-src-end="5">Hello</span></p>',
      text_spans: [],
    }),
  } as unknown as Ipc;
}

function settings(): Settings {
  return {
    profile: { user_id: 'u', display_name: 'U', color: '#000' },
    appearance: {
      theme: 'light',
      font_size_px: 14,
      line_height: 1.5,
      density: 'comfortable',
      startup_mode: 'clean',
      dark_variant: 'pure',
    } as Settings['appearance'],
    editor: {
      default_open_mode: 'render',
      auto_save: true,
      auto_save_debounce_ms: 100,
      external_change_behavior: 'ask',
      syntax_highlighting: true,
      mermaid_enabled: true,
      show_whitespace: false,
      word_wrap: true,
      render_readonly: false,
    },
    comments: {
      auto_merge: 'ask',
      reattachment_confidence: 70,
      sidecar_pattern: '{name}.comments.json',
      show_resolved: true,
    },
    advanced: { sync_provider: null, verbose_logs: false },
    shortcuts: {},
    cloud: {} as Settings['cloud'],
    onboarding: { cli_install_prompt_seen_for: '' },
  } as Settings;
}

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

// `await Promise.resolve()` a few times to drain the chained microtasks
// inside mountDocument's post-mount initial refreshAnchors + per-thread
// resolveAnchor pump.
async function drainMicrotasks(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe('Document', () => {
  it('mounts the document view container', async () => {
    const root = makeRoot();
    await mountDocument(root, ipc(), {
      tabId: 't',
      html,
      threads: [],
      source: 'Hello',
      path: '/x.md',
      settings: settings(),
    });
    expect(root.querySelector('[data-view="document"]')).toBeTruthy();
  });

  it('exposes refreshHighlights() that resolves without throwing', async () => {
    const root = makeRoot();
    const view = await mountDocument(root, ipc(), {
      tabId: 't',
      html,
      threads: [],
      source: 'Hello',
      path: '/x.md',
      settings: settings(),
    });
    await expect(view.refreshHighlights()).resolves.toBeUndefined();
  });

  it('routes orphan threads into orphanThreads() and onOrphansChanged', async () => {
    const root = makeRoot();
    const ipcStub = ipc();
    (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: 'orphan' });
    const onOrphansChanged = vi.fn();
    const orphanThread = {
      id: 't-orph',
      anchor: { start: 0, end: 5, exact: 'gone', prefix: '', suffix: '' },
      comments: [],
      resolved: false,
    } as unknown as never;
    const view = await mountDocument(root, ipcStub, {
      tabId: 't',
      html,
      threads: [orphanThread],
      source: 'Hello world',
      path: '/x.md',
      settings: settings(),
      onOrphansChanged,
    });
    await drainMicrotasks();
    expect(view.orphanThreads().map((t) => t.id)).toEqual(['t-orph']);
    expect(onOrphansChanged).toHaveBeenCalled();
    const lastCall =
      onOrphansChanged.mock.calls[onOrphansChanged.mock.calls.length - 1]![0];
    expect((lastCall as Array<{ id: string }>).map((t) => t.id)).toEqual(['t-orph']);
  });

  describe('share button', () => {
    it('hides the share button when no path is supplied', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        settings: settings(),
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="share"]')!;
      expect(btn.hidden).toBe(true);
    });

    it('dispatches share-requested with tabId+path on click', async () => {
      const root = makeRoot();
      document.body.appendChild(root);
      const listener = vi.fn();
      root.addEventListener('share-requested', listener as EventListener);
      await mountDocument(root, ipc(), {
        tabId: 't-7',
        path: '/tmp/x.md',
        source: 'hi',
        settings: settings(),
        html,
        threads: [],
      });
      (root.querySelector('[data-action="share"]') as HTMLButtonElement).click();
      expect(listener).toHaveBeenCalled();
      const ev = listener.mock.calls[0]![0] as CustomEvent;
      expect(ev.detail).toEqual({ tabId: 't-7', path: '/tmp/x.md' });
    });
  });

  describe('Render/Raw toggle', () => {
    it('hides the toggle button when source/path/settings are not provided', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-render-raw"]')!;
      expect(btn).toBeTruthy();
      expect(btn.hidden).toBe(true);
    });

    it('default mode is render and the button label reads "Raw" (the action it triggers)', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-render-raw"]')!;
      expect(btn.hidden).toBe(false);
      // The button shows the destination mode — clicking "Raw" switches
      // FROM render TO raw, matching the wireframe label convention.
      expect(btn.textContent).toBe('Raw');
    });

    it('clicking flips render → raw → render, and the label tracks the destination', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-render-raw"]')!;
      expect(btn.textContent).toBe('Raw');
      btn.click();
      // After clicking once we're in raw mode — label flips to "Render".
      expect(btn.textContent).toBe('Render');
      btn.click();
      // And back to render — label returns to "Raw".
      expect(btn.textContent).toBe('Raw');
    });

    it('clicking the toggle does NOT trigger a saveDocument IPC', async () => {
      // Mode toggles ride a StateEffect, not a doc change — the
      // autosave/dirty pipeline must stay inert. This guard is the
      // canonical test for "mode toggle alone doesn't autosave".
      const root = makeRoot();
      const ipcStub = ipc();
      await mountDocument(root, ipcStub, {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-render-raw"]')!;
      btn.click();
      btn.click();
      btn.click();
      // Drain any pending microtasks so an erroneously-queued save
      // would surface.
      await drainMicrotasks();
      expect(ipcStub.saveDocument).not.toHaveBeenCalled();
    });
  });

  describe('render_readonly', () => {
    it('renders the editor as non-editable when render_readonly=true and mode=render', async () => {
      const root = makeRoot();
      const s = settings();
      s.editor.render_readonly = true;
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: s,
      });
      // CodeMirror sets `contenteditable` on `.cm-content`. In jsdom
      // we read it via getAttribute because the DOM .contentEditable
      // reflected property isn't supported on non-known-content-editable
      // elements (the jsdom Element type returns undefined for arbitrary
      // div.contentEditable, but the attribute itself round-trips).
      const content = root.querySelector<HTMLElement>('.cm-content')!;
      expect(content).toBeTruthy();
      expect(content.getAttribute('contenteditable')).toBe('false');
    });

    it('renders editable when render_readonly=false (the new default)', async () => {
      const root = makeRoot();
      const s = settings();
      s.editor.render_readonly = false;
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: s,
      });
      const content = root.querySelector<HTMLElement>('.cm-content')!;
      expect(content).toBeTruthy();
      expect(content.getAttribute('contenteditable')).toBe('true');
    });

    it('switching to raw makes the editor editable even when render_readonly=true', async () => {
      const root = makeRoot();
      const s = settings();
      s.editor.render_readonly = true;
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: s,
      });
      // Render → contenteditable=false (read-only).
      let content = root.querySelector<HTMLElement>('.cm-content')!;
      expect(content.getAttribute('contenteditable')).toBe('false');
      // Flip to raw.
      const btn = root.querySelector<HTMLButtonElement>('[data-action="toggle-render-raw"]')!;
      btn.click();
      content = root.querySelector<HTMLElement>('.cm-content')!;
      // Raw mode is ALWAYS editable — the user explicitly switched to
      // the byte-level surface.
      expect(content.getAttribute('contenteditable')).toBe('true');
    });
  });

  describe('font-zoom cluster', () => {
    it('renders a span[data-region="font-zoom"].zoom with the three controls in order', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
      });
      const cluster = root.querySelector<HTMLSpanElement>(
        '[data-region="doc-toolbar"] span[data-region="font-zoom"]',
      );
      expect(cluster).toBeTruthy();
      expect(cluster!.tagName.toLowerCase()).toBe('span');
      expect(cluster!.classList.contains('zoom')).toBe(true);
      const buttons = Array.from(cluster!.querySelectorAll('button'));
      expect(buttons.length).toBe(3);
      expect(buttons[0]!.getAttribute('data-action')).toBe('font-decrease');
      expect(buttons[1]!.getAttribute('data-action')).toBe('font-reset');
      expect(buttons[1]!.getAttribute('data-test')).toBe('font-readout');
      expect(buttons[2]!.getAttribute('data-action')).toBe('font-increase');
    });

    it('cluster sits after the Share button in the toolbar', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
      });
      const toolbar = root.querySelector<HTMLDivElement>('[data-region="doc-toolbar"]')!;
      const shareIdx = Array.from(toolbar.children).findIndex(
        (c) => c.getAttribute('data-action') === 'share',
      );
      const clusterIdx = Array.from(toolbar.children).findIndex(
        (c) => c.getAttribute('data-region') === 'font-zoom',
      );
      expect(shareIdx).toBeGreaterThanOrEqual(0);
      expect(clusterIdx).toBeGreaterThan(shareIdx);
    });

    it('readout reflects the configured value (default 14)', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
      });
      const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
      expect(readout.textContent).toBe('14');
    });

    it('readout reflects an explicit fontSizePx prop', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
        fontSizePx: 18,
      });
      const readout = root.querySelector<HTMLButtonElement>('[data-test="font-readout"]')!;
      expect(readout.textContent).toBe('18');
    });

    it('clicking decrease dispatches mdviewer:font-decrease on document', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
      });
      const listener = vi.fn();
      document.addEventListener('mdviewer:font-decrease', listener as EventListener);
      try {
        const btn = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
        btn.click();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('mdviewer:font-decrease', listener as EventListener);
      }
    });

    it('clicking the readout (reset) dispatches mdviewer:font-reset', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
      });
      const listener = vi.fn();
      document.addEventListener('mdviewer:font-reset', listener as EventListener);
      try {
        const btn = root.querySelector<HTMLButtonElement>('[data-action="font-reset"]')!;
        btn.click();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('mdviewer:font-reset', listener as EventListener);
      }
    });

    it('clicking increase dispatches mdviewer:font-increase', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
      });
      const listener = vi.fn();
      document.addEventListener('mdviewer:font-increase', listener as EventListener);
      try {
        const btn = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
        btn.click();
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('mdviewer:font-increase', listener as EventListener);
      }
    });

    it('at the minimum (10 px) the decrease button is disabled and titled', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
        fontSizePx: 10,
      });
      const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
      const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
      expect(dec.disabled).toBe(true);
      expect(dec.getAttribute('title')).toBe('Already at minimum (10 px)');
      expect(inc.disabled).toBe(false);
    });

    it('at the maximum (24 px) the increase button is disabled and titled', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
        fontSizePx: 24,
      });
      const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
      const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
      expect(inc.disabled).toBe(true);
      expect(inc.getAttribute('title')).toBe('Already at maximum (24 px)');
      expect(dec.disabled).toBe(false);
    });

    it('at a mid value (14 px) neither bound button is disabled', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'hi',
        path: '/x.md',
        settings: settings(),
        fontSizePx: 14,
      });
      const dec = root.querySelector<HTMLButtonElement>('[data-action="font-decrease"]')!;
      const inc = root.querySelector<HTMLButtonElement>('[data-action="font-increase"]')!;
      expect(dec.disabled).toBe(false);
      expect(inc.disabled).toBe(false);
    });

    it('the readout reset button is never disabled', async () => {
      for (const px of [10, 14, 24]) {
        const root = makeRoot();
        await mountDocument(root, ipc(), {
          tabId: 't',
          html,
          threads: [],
          source: 'hi',
          path: '/x.md',
          settings: settings(),
          fontSizePx: px,
        });
        const readout = root.querySelector<HTMLButtonElement>('[data-action="font-reset"]')!;
        expect(readout.disabled).toBe(false);
      }
    });
  });

  describe('commentHighlights wiring', () => {
    it('repaints highlights for resolved threads via the mark[data-anchor] decoration', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      (ipcStub.resolveAnchor as ReturnType<typeof vi.fn>).mockResolvedValue({
        kind: 'resolved',
        start: 0,
        end: 5,
      });
      await mountDocument(root, ipcStub, {
        tabId: 't',
        html,
        threads: [
          {
            id: 't-1',
            anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
            comments: [],
            resolved: false,
          },
        ] as unknown as never,
        source: 'Hello world',
        path: '/x.md',
        settings: settings(),
      });
      await drainMicrotasks();
      const mark = root.querySelector('mark[data-anchor="t-1"]');
      expect(mark).toBeTruthy();
    });
  });
});
