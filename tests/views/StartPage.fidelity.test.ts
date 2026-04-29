import { describe, it, expect, vi } from 'vitest';
import { mountStartPage } from '../../src/views/StartPage';
import type { Ipc } from '../../src/ipc';

/**
 * Fidelity tests — these assert the StartPage RENDERS what
 * docs/wireframes/01-startup.html promises, not just that some matching
 * selectors exist somewhere in the DOM.
 *
 * Pre-existing StartPage.test.ts checks behavior (clicks dispatch
 * events, IPC is called with the right args). This file is the
 * "compare to the wireframe" half: heading copy, recents row structure,
 * the action-button order, etc. Things that drifted between wireframe
 * and implementation in the past would show up here as red diffs.
 */

function fixedNowSeconds(): number {
  return Math.floor(Date.UTC(2026, 5, 1, 12, 0, 0) / 1000);
}

function ipcWith(
  recents: { path: string; mtime: number | null }[],
  displayName = 'Mira',
): Ipc {
  return {
    appInfo: vi.fn().mockResolvedValue({ version: '0.1.0', commit_hash: 'abc' }),
    openDocument: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    listOpenDocuments: vi.fn().mockResolvedValue([]),
    listRecents: vi.fn().mockResolvedValue(recents),
    getSettings: vi.fn().mockResolvedValue({
      profile: { user_id: 'u', display_name: displayName, color: '#c98a2b' },
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

describe('StartPage — wireframe-01 fidelity', () => {
  it('greets the user by display_name when one is set', async () => {
    const root = document.createElement('div');
    await mountStartPage(root, ipcWith([], 'Mira'));
    const h = root.querySelector('[data-test="welcome-heading"]')!;
    expect(h.textContent).toBe('Welcome back, Mira');
  });

  it('falls back to a generic greeting when display_name is empty', async () => {
    const root = document.createElement('div');
    await mountStartPage(root, ipcWith([], ''));
    const h = root.querySelector('[data-test="welcome-heading"]')!;
    expect(h.textContent).toBe('Welcome to MDViewer');
  });

  it('renders three actions in wireframe order: Open · New · Settings', async () => {
    const root = document.createElement('div');
    await mountStartPage(root, ipcWith([]));
    const buttons = Array.from(
      root.querySelectorAll<HTMLButtonElement>(
        '[data-test="startpage-actions"] > button',
      ),
    );
    expect(buttons.map((b) => b.getAttribute('data-action'))).toEqual([
      'open-file',
      'new-document',
      'open-settings',
    ]);
    expect(buttons[0].textContent).toBe('Open file…');
    expect(buttons[1].textContent).toBe('New document');
    expect(buttons[2].textContent).toBe('Settings…');
    // Open is the primary action — wireframe-01 styles it as the accent
    // button via the .primary class.
    expect(buttons[0].className).toContain('primary');
  });

  it('renders New Document button that dispatches mdviewer:new-document', async () => {
    const root = document.createElement('div');
    await mountStartPage(root, ipcWith([]));
    const handler = vi.fn();
    document.addEventListener('mdviewer:new-document', handler, { once: true });
    (root.querySelector('[data-action="new-document"]') as HTMLButtonElement).click();
    expect(handler).toHaveBeenCalled();
  });

  it('each recent row has filename + ~tilde-path + relative when', async () => {
    // Use a stable "now" so the rendered relative time is deterministic.
    vi.spyOn(Date, 'now').mockReturnValue(fixedNowSeconds() * 1000);
    const root = document.createElement('div');
    await mountStartPage(
      root,
      ipcWith([
        { path: '/Users/mira/Documents/Q3-design-review.md', mtime: fixedNowSeconds() - 7200 },
        { path: '/Users/mira/Work/rfcs/RFC-031-rate-limiting.md', mtime: fixedNowSeconds() - 86_400 - 100 },
        { path: '/Users/mira/Documents/team/onboarding-handbook.md', mtime: fixedNowSeconds() - 86_400 * 90 },
      ]),
    );
    const items = root.querySelectorAll('[data-test="recent-item"]');
    expect(items.length).toBe(3);

    const row0 = items[0];
    expect(row0.querySelector('[data-test="recent-name"]')?.textContent).toBe(
      'Q3-design-review.md',
    );
    expect(row0.querySelector('[data-test="recent-path"]')?.textContent).toBe(
      '~/Documents/Q3-design-review.md',
    );
    expect(row0.querySelector('[data-test="recent-when"]')?.textContent).toBe('2 hours ago');

    expect(items[1].querySelector('[data-test="recent-when"]')?.textContent).toBe(
      'Yesterday',
    );
    // 90 days ago → absolute date format ("Mar 14"-style); just assert it's
    // not one of the relative forms so we don't pin to a specific locale.
    const oldWhen =
      items[2].querySelector('[data-test="recent-when"]')?.textContent ?? '';
    expect(oldWhen).not.toMatch(/(ago|Yesterday|just now)/);
    vi.restoreAllMocks();
  });

  it('omits the recents block entirely when there are no recents', async () => {
    const root = document.createElement('div');
    await mountStartPage(root, ipcWith([]));
    expect(root.querySelector('[data-test="recents"]')).toBeNull();
  });

  it('shows "—" in the when column when mtime is missing', async () => {
    const root = document.createElement('div');
    await mountStartPage(
      root,
      ipcWith([{ path: '/Users/mira/x.md', mtime: null }]),
    );
    expect(
      root.querySelector('[data-test="recent-when"]')?.textContent,
    ).toBe('—');
  });
});
