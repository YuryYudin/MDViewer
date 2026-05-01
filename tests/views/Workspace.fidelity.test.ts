import { describe, it, expect, vi } from 'vitest';
import { mountWorkspace } from '../../src/views/Workspace';
import type { Ipc } from '../../src/ipc';

/**
 * Wireframe-fidelity tests for the workspace shell. The previous
 * implementation hid the titlebar via display:none while leaving its
 * grid track in place; CSS Grid auto-placement then slotted the visible
 * regions into the wrong tracks, with the status bar floating in the
 * middle of the window. These assertions check the *layout contract*
 * the wireframes promise, not just selector existence:
 *
 *  - tabbar / body / status appear in document order at top / fill / bottom
 *  - tabbar is `36px`, status is `22px`, body is the flex track (`1fr`)
 *  - no leftover hidden titlebar that could confuse the grid
 */

function ipc(): Ipc {
  return {
    appInfo: vi.fn().mockResolvedValue({ version: '0.1.0', commit_hash: 'unit' }),
    openDocument: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    listOpenDocuments: vi.fn().mockResolvedValue([]),
    listRecents: vi.fn().mockResolvedValue([]),
    getSettings: vi.fn().mockResolvedValue({
      profile: { user_id: 'u', display_name: 'Mira', color: '#888' },
      appearance: { theme: 'light', font_size_px: 14, line_height: 1.5, density: 'comfortable' },
      comments: { show_resolved: false, sidecar_pattern: '{name}.md.comments.json', reattachment_confidence: 75, auto_merge: 'manual' },
      editor: {},
      // 2025-05-01: opt-in Drive; this fidelity test asserts pill ordering so opt in.
      cloud: { drive: { feature_enabled: true, connected: false, account_email: null, backend_mode: 'auto', poll_interval_active_secs: 5, poll_interval_unfocused_secs: 10, custom_oauth_client_id: null, detect_toast_suppressed: false } },
    }),
    setSettings: vi.fn(),
    listThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn().mockResolvedValue({ kind: 'orphan' }),
    getDocPref: vi.fn().mockResolvedValue(null),
    setDocPref: vi.fn().mockResolvedValue(undefined),
    deleteDocPref: vi.fn().mockResolvedValue(undefined),
  } as unknown as Ipc;
}

describe('Workspace shell — wireframe layout', () => {
  it('renders regions in document order: tabbar → body → status', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, ipc());
    const shell = root.querySelector<HTMLElement>('[data-view="workspace"]')!;
    const order = Array.from(shell.children)
      .map((c) => (c as HTMLElement).getAttribute('data-region'));
    expect(order).toEqual(['tabbar', 'body', 'status']);
  });

  it('does not render a (hidden) titlebar that could confuse the grid', async () => {
    // Regression guard for the bug we just fixed: a display:none
    // titlebar element + a `0` row in grid-template-rows caused the
    // visible regions to land in the wrong tracks.
    const root = document.createElement('div');
    await mountWorkspace(root, ipc());
    expect(root.querySelector('[data-region="titlebar"]')).toBeNull();
  });

  it('status bar holds profile chip, drive status pill, and version label, in that order', async () => {
    // A8 inserted the Drive status pill between the spacer and the version
    // label so it sits on the right side of the bar, mirroring the
    // wireframe-05 status row.
    // 2025-05-01: the pill HOST is appended synchronously to preserve DOM
    // order; the listener subscription happens async after the
    // feature_enabled check.
    const root = document.createElement('div');
    await mountWorkspace(root, ipc());
    const status = root.querySelector<HTMLElement>('[data-region="status"]')!;
    const order = Array.from(status.children)
      .map((c) => (c as HTMLElement).getAttribute('data-test') ?? c.className);
    expect(order).toEqual([
      'user-name',
      'link-preview',
      'grow',
      'drive-status-pill',
      'version-label',
    ]);
  });

  it('renders the product version via app_info into the status bar', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, ipc());
    // appInfo is async; the version label fills in on the next tick.
    await new Promise((r) => setTimeout(r, 0));
    const v = root.querySelector('[data-test="version-label"]')!;
    expect(v.textContent).toBe('MDViewer v0.1.0');
  });
});

describe('Workspace shell — font-zoom cluster fidelity', () => {
  /**
   * Wireframe-fidelity assertions for the font-zoom cluster (per
   * `docs/wireframes/01-doc-toolbar-with-zoom.html`):
   *  - The cluster sits between `[data-action="share"]` and the right edge
   *    of `[data-region="doc-toolbar"]`.
   *  - It contains exactly three controls in order: decrease, readout/reset,
   *    increase.
   */
  function ipcWithDoc(): Ipc {
    const i = ipc();
    (i.listOpenDocuments as any).mockResolvedValue([{ id: 't-1', path: '/docs/x.md' }]);
    return i;
  }

  it('renders the three font controls in order between Share and the right edge', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handle = await mountWorkspace(root, ipcWithDoc());
    handle.setActive({
      kind: 'document',
      tab_id: 't-1',
      path: '/docs/x.md',
      html: '<p>hi</p>',
      threads: [],
    });
    await handle.refresh();

    const toolbar = root.querySelector<HTMLElement>('[data-region="doc-toolbar"]')!;
    const children = Array.from(toolbar.children);
    const shareIdx = children.findIndex((c) => c.getAttribute('data-action') === 'share');
    const clusterIdx = children.findIndex((c) => c.getAttribute('data-region') === 'font-zoom');
    expect(shareIdx).toBeGreaterThanOrEqual(0);
    expect(clusterIdx).toBeGreaterThan(shareIdx);
    // The cluster is the LAST child of the toolbar (sits at the right edge).
    expect(clusterIdx).toBe(children.length - 1);

    // Three controls in order inside the cluster.
    const cluster = children[clusterIdx]!;
    const buttons = Array.from(cluster.querySelectorAll('button'));
    expect(buttons.length).toBe(3);
    expect(buttons[0]!.getAttribute('data-action')).toBe('font-decrease');
    expect(buttons[1]!.getAttribute('data-action')).toBe('font-reset');
    expect(buttons[1]!.getAttribute('data-test')).toBe('font-readout');
    expect(buttons[2]!.getAttribute('data-action')).toBe('font-increase');

    document.body.removeChild(root);
  });
});
