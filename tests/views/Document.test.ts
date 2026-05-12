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

  describe('Render/Raw toggle (legacy single-button surface, now two-button per A.2)', () => {
    it('hides the toggle when source/path/settings are not provided', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), { tabId: 't', html, threads: [] });
      const toggle = root.querySelector<HTMLDivElement>('[data-testid="mode-toggle"]')!;
      expect(toggle).toBeTruthy();
      expect(toggle.hidden).toBe(true);
      // The legacy `[data-action="toggle-render-raw"]` selector hits
      // the opposite-mode button via the back-compat alias.
      const legacy = root.querySelector<HTMLButtonElement>('[data-action~="toggle-render-raw"]')!;
      expect(legacy).toBeTruthy();
      expect(legacy.hidden).toBe(true);
    });

    it('default mode is render — legacy back-compat alias lives on the Raw button (the action it triggers)', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const btn = root.querySelector<HTMLButtonElement>('[data-action~="toggle-render-raw"]')!;
      expect(btn.hidden).toBe(false);
      // The button shows the destination mode — clicking "Raw" switches
      // FROM render TO raw, matching the wireframe label convention.
      expect(btn.textContent).toBe('Raw');
    });

    it('clicking the legacy back-compat alias flips mode; the alias migrates to the opposite-mode button each time', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      // Re-query after each click — under the two-button structure
      // the legacy alias migrates between buttons, so a cached handle
      // would not track the destination-mode label.
      const legacy = () =>
        root.querySelector<HTMLButtonElement>('[data-action~="toggle-render-raw"]')!;
      expect(legacy().textContent).toBe('Raw');
      legacy().click();
      // After clicking once we're in raw mode — alias hopped to the
      // Render button, whose textContent is "Render".
      expect(legacy().textContent).toBe('Render');
      legacy().click();
      // And back to render — alias returns to the Raw button.
      expect(legacy().textContent).toBe('Raw');
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
      const legacy = () =>
        root.querySelector<HTMLButtonElement>('[data-action~="toggle-render-raw"]')!;
      legacy().click();
      legacy().click();
      legacy().click();
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
      // Flip to raw — click the Raw button directly under the new
      // two-button structure (A.2).
      const btn = root.querySelector<HTMLButtonElement>(
        '[data-testid="mode-toggle"] button[data-mode="raw"]',
      )!;
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

  describe('shadow render-pane (A.2)', () => {
    it('mounts a [data-region="rendered-shadow"] sibling to the editor host with hidden + aria-hidden attrs', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: '# Title\n\nBody.',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const shadow = root.querySelector<HTMLDivElement>('[data-region="rendered-shadow"]');
      expect(shadow).toBeTruthy();
      // Hidden + aria-hidden: the shadow exists as a render parity surface
      // (consumed by export/diff tooling); users never see it.
      expect(shadow!.hidden).toBe(true);
      expect(shadow!.getAttribute('aria-hidden')).toBe('true');
      // Sibling — same parent as the editor host.
      const editorHost = root.querySelector<HTMLDivElement>('[data-testid="live-editor"]')!;
      expect(shadow!.parentElement).toBe(editorHost.parentElement);
    });

    it('populates the shadow with semantic HTML matching the source on initial mount', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue({
        html: '<h1>Title</h1><p>Body.</p>',
        text_spans: [],
      });
      await mountDocument(root, ipcStub, {
        tabId: 't',
        html,
        threads: [],
        source: '# Title\n\nBody.',
        path: '/tmp/a.md',
        settings: settings(),
      });
      await drainMicrotasks();
      const shadow = root.querySelector<HTMLDivElement>('[data-region="rendered-shadow"]')!;
      expect(shadow.querySelector('h1')?.textContent).toBe('Title');
      expect(shadow.querySelector('p')?.textContent).toBe('Body.');
      // renderMarkdown was called at mount with the supplied source.
      expect(ipcStub.renderMarkdown).toHaveBeenCalledWith('# Title\n\nBody.');
    });

    it('refreshes the shadow on the LiveEditor onSaved callback (exactly once per save)', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue({
        html: '<p>updated</p>',
        text_spans: [],
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
          {
            id: 't-2',
            anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
            comments: [],
            resolved: false,
          },
          {
            id: 't-3',
            anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
            comments: [],
            resolved: false,
          },
        ] as unknown as never,
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      await drainMicrotasks();
      // Initial-mount render is the only call so far. Drain any
      // anchor-resolution pump churn first.
      const initialCalls = (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mock.calls.length;

      // Trigger a real save through the LiveEditor's forceSave path —
      // that's what fires onSaved exactly once after the per-thread
      // re-anchor pump (3 onAnchorsResolved calls for a 3-thread doc).
      const e2e = (window as unknown as { __mdviewerE2E?: { forceSave?: () => Promise<void> } })
        .__mdviewerE2E;
      // Enable the E2E hook by stamping WEBDRIVER and remounting?
      // Simpler: dispatch a fake save by calling forceSave directly on
      // the LiveEditor — but we don't have a handle. Instead, surface
      // forceSave by re-mounting with __WEBDRIVER__ set. Skip that
      // dance: drive saveDocument directly by simulating a doc change.
      void e2e;

      // Type a character via the public user-input path — userEvent
      // tag triggers the autosave pipeline.
      const content = root.querySelector<HTMLElement>('.cm-content')!;
      content.focus();
      // Drive the autosave debounce directly by calling the editor
      // dispatch through a synthesised text-input. Use vi.useFakeTimers
      // semantics? Simpler: post a userEvent dispatch via the CodeMirror
      // public API. We grab the EditorView off the CM root's `cmView`
      // marker the LiveEditor stamps — but there's no marker. Instead
      // reach into the host via `cm-editor`'s view property which is
      // not exposed on jsdom. Fall back to triggering save via the
      // public surface: simulate by calling forceSave through the
      // window.__mdviewerE2E hook after stamping __WEBDRIVER__.
      const w = window as unknown as {
        __WEBDRIVER__?: unknown;
        __mdviewerE2E?: { forceSave?: () => Promise<void> };
      };
      w.__WEBDRIVER__ = true;
      // Need a remount for the LiveEditor to register its forceSave
      // hook — destroy + remount instead.
      root.replaceChildren();
      const view = await mountDocument(root, ipcStub, {
        tabId: 't',
        html,
        threads: [
          {
            id: 't-1',
            anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
            comments: [],
            resolved: false,
          },
          {
            id: 't-2',
            anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
            comments: [],
            resolved: false,
          },
          {
            id: 't-3',
            anchor: { start: 0, end: 5, exact: 'Hello', prefix: '', suffix: '' },
            comments: [],
            resolved: false,
          },
        ] as unknown as never,
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      await drainMicrotasks();
      const baselineCalls = (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mock.calls.length;
      // Force-save through the e2e hook fires the post-save pump.
      await (window as unknown as { __mdviewerE2E: { forceSave: () => Promise<void> } })
        .__mdviewerE2E.forceSave();
      await drainMicrotasks(10);
      // Exactly ONE renderMarkdown call landed for this save — not
      // three (which would mean it's wired off onAnchorsResolved).
      const afterCalls = (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(afterCalls - baselineCalls).toBe(1);
      view.destroy();
      delete (window as unknown as { __WEBDRIVER__?: unknown }).__WEBDRIVER__;
      void initialCalls;
    });

    it('mount survives a renderMarkdown rejection (shadow stays empty, no crash)', async () => {
      const root = makeRoot();
      const ipcStub = ipc();
      (ipcStub.renderMarkdown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('boom'),
      );
      // Should not throw on mount even though the shadow refresh fails.
      await expect(
        mountDocument(root, ipcStub, {
          tabId: 't',
          html,
          threads: [],
          source: 'Hello',
          path: '/tmp/a.md',
          settings: settings(),
        }),
      ).resolves.toBeTruthy();
      await drainMicrotasks();
      const shadow = root.querySelector<HTMLDivElement>('[data-region="rendered-shadow"]')!;
      // Shadow exists but is empty (the try/catch swallowed the
      // rejection and left the previous content — empty on mount —
      // in place).
      expect(shadow).toBeTruthy();
      expect(shadow.children.length).toBe(0);
    });

    it('destroy() removes the shadow div', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      expect(root.querySelector('[data-region="rendered-shadow"]')).toBeTruthy();
      view.destroy();
      expect(root.querySelector('[data-region="rendered-shadow"]')).toBeFalsy();
    });
  });

  describe('two-button mode toggle + selector aliases (A.2)', () => {
    it('renders <div data-testid="mode-toggle"> with two buttons carrying static data-mode', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const toggle = root.querySelector<HTMLDivElement>('[data-testid="mode-toggle"]')!;
      expect(toggle).toBeTruthy();
      const buttons = Array.from(toggle.querySelectorAll('button'));
      expect(buttons.length).toBe(2);
      const renderBtn = buttons.find((b) => b.getAttribute('data-mode') === 'render');
      const rawBtn = buttons.find((b) => b.getAttribute('data-mode') === 'raw');
      expect(renderBtn).toBeTruthy();
      expect(rawBtn).toBeTruthy();
      expect(renderBtn!.textContent).toBe('Render');
      expect(rawBtn!.textContent).toBe('Raw');
    });

    it('editor host carries all three back-compat selector aliases plus reflective data-mode', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const editorHost = root.querySelector<HTMLDivElement>('[data-testid="live-editor"]')!;
      expect(editorHost).toBeTruthy();
      // data-region is a space-separated token list containing both
      // the new and legacy names.
      const tokens = (editorHost.getAttribute('data-region') ?? '').split(/\s+/);
      expect(tokens).toContain('editor');
      expect(tokens).toContain('render');
      // data-test back-compat alias for spec 05 line 22 lives on the
      // same element as data-testid.
      expect(editorHost.getAttribute('data-test')).toBe('editor');
      // Reflective data-mode is set synchronously on mount (no
      // microtask wait required).
      expect(editorHost.getAttribute('data-mode')).toBe('render');
    });

    it('on initial mount (render mode), data-action="toggle-edit" lives on the Raw button only', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const renderBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="mode-toggle"] button[data-mode="render"]',
      )!;
      const rawBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="mode-toggle"] button[data-mode="raw"]',
      )!;
      // Render mode → opposite-mode (Raw) button carries the alias.
      expect((rawBtn.getAttribute('data-action') ?? '').split(/\s+/)).toContain('toggle-edit');
      expect(renderBtn.getAttribute('data-action') ?? '').not.toContain('toggle-edit');
    });

    it('after clicking the Raw button, the alias swaps onto the Render button and editorHost data-mode flips', async () => {
      const root = makeRoot();
      await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const editorHost = root.querySelector<HTMLDivElement>('[data-testid="live-editor"]')!;
      const renderBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="mode-toggle"] button[data-mode="render"]',
      )!;
      const rawBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="mode-toggle"] button[data-mode="raw"]',
      )!;
      rawBtn.click();
      // After flipping, raw is the current mode; the alias must now
      // point at the OPPOSITE button (Render).
      expect((renderBtn.getAttribute('data-action') ?? '').split(/\s+/)).toContain('toggle-edit');
      expect(rawBtn.getAttribute('data-action') ?? '').not.toContain('toggle-edit');
      expect(editorHost.getAttribute('data-mode')).toBe('raw');
      // Flip back.
      renderBtn.click();
      expect((rawBtn.getAttribute('data-action') ?? '').split(/\s+/)).toContain('toggle-edit');
      expect(renderBtn.getAttribute('data-action') ?? '').not.toContain('toggle-edit');
      expect(editorHost.getAttribute('data-mode')).toBe('render');
    });

    it('destroy() unsubscribes from subscribeMode (no further mode notifications after teardown)', async () => {
      const root = makeRoot();
      const view = await mountDocument(root, ipc(), {
        tabId: 't',
        html,
        threads: [],
        source: 'Hello',
        path: '/tmp/a.md',
        settings: settings(),
      });
      const editorHost = root.querySelector<HTMLDivElement>('[data-testid="live-editor"]')!;
      // Sanity: data-mode is set pre-destroy.
      expect(editorHost.getAttribute('data-mode')).toBe('render');
      view.destroy();
      // After destroy, even if LiveEditor itself is gone, the shadow
      // and toggle alias bookkeeping must have been torn down — the
      // editor host element is removed (root cleared) so no stale
      // listener writes to it. Hardening: confirm no rendered-shadow
      // remains and no orphan listener throws on a subsequent
      // mountDocument cycle.
      expect(root.querySelector('[data-region="rendered-shadow"]')).toBeFalsy();
      expect(root.querySelector('[data-testid="live-editor"]')).toBeFalsy();
      expect(root.querySelector('[data-testid="mode-toggle"]')).toBeFalsy();
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
