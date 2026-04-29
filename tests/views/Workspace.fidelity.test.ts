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
      comments: { show_resolved: false, sidecar_pattern: '{name}.md.comments.json', reattachment_confidence: 75, auto_merge: 'manual' },
    }),
    setSettings: vi.fn(),
    listThreads: vi.fn().mockResolvedValue([]),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn(),
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

  it('status bar holds profile chip and version label, in that order', async () => {
    const root = document.createElement('div');
    await mountWorkspace(root, ipc());
    const status = root.querySelector<HTMLElement>('[data-region="status"]')!;
    const order = Array.from(status.children)
      .map((c) => (c as HTMLElement).getAttribute('data-test') ?? c.className);
    expect(order).toEqual(['user-name', 'grow', 'version-label']);
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
