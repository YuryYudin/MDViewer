import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook, tripleClick } from './helpers/app';

/**
 * Bug regression: the comments sidebar was always visible (no close button),
 * the View → Toggle Comments Sidebar menu item had no effect (the dispatched
 * `mdviewer:toggle-sidebar` event was never listened for), and a newly added
 * comment did not re-show the sidebar after it was hidden.
 *
 * The fix wires a `mdviewer:toggle-sidebar` listener inside Workspace.ts that
 * flips a `data-sidebar="hidden"` attribute on the `[data-region="body"]`
 * element. CSS hides the sidebar via that attribute. Three input surfaces
 * converge on the same event:
 *
 *   1. The new × close button inside the sidebar header
 *   2. The View → Toggle Comments Sidebar menu item (via menuBridge)
 *   3. The Cmd+Shift+S keymap action (via main.ts dispatchAction)
 *
 * `thread-created` (fired when a new comment is posted) ALSO un-hides the
 * sidebar so the user immediately sees the new thread.
 *
 * This spec exercises every input surface end-to-end and the auto-show
 * behavior, plus the floating "Show comments" pill that appears while the
 * sidebar is hidden.
 */
async function emitMenuAction(action: string): Promise<void> {
  await browser.executeAsync(
    function (a: string, done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { emitMenuAction(action: string): Promise<void> };
      };
      if (!w.__mdviewerE2E?.emitMenuAction) {
        done({ error: 'emitMenuAction hook missing' });
        return;
      }
      w.__mdviewerE2E.emitMenuAction(a).then(
        () => done(null),
        (e: unknown) => done({ error: String(e) }),
      );
    },
    action,
  );
}

/**
 * Read whether the body region has `data-sidebar="hidden"`. Returning a
 * primitive lets WebDriver round-trip cleanly.
 */
async function bodySidebarHidden(): Promise<boolean> {
  return browser.execute(() => {
    const body = document.querySelector('[data-region="body"]');
    return body?.getAttribute('data-sidebar') === 'hidden';
  });
}

/**
 * Whether the .with-document layout currently shows the sidebar pixel-wise.
 * Reads computed style — display:none means the rule fired correctly. We
 * also verify offsetWidth is 0 so a regression where the rule is dropped
 * but the attribute still flips will fail.
 */
async function sidebarRendered(): Promise<{ display: string; width: number }> {
  return browser.execute(() => {
    const sb = document.querySelector(
      '[data-region="body"].with-document > [data-region="sidebar"]',
    ) as HTMLElement | null;
    if (!sb) return { display: 'absent', width: 0 };
    const cs = getComputedStyle(sb);
    return { display: cs.display, width: sb.offsetWidth };
  });
}

describe('Comments sidebar — toggle visibility from every input surface', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  beforeEach(async () => {
    // Each test starts with a freshly-opened doc so we always begin with
    // the sidebar visible. reloadSession is too slow to use per-test, but
    // the underlying Rust state is tab-scoped so reopening the same path
    // doesn't pile up tabs (open_document re-activates the existing one).
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document never mounted' },
    );
    // Force the sidebar back to visible by toggling if hidden — keeps tests
    // independent without a full session reload.
    if (await bodySidebarHidden()) {
      await browser.$('[data-test="sidebar-show"]').click();
      await browser.waitUntil(async () => !(await bodySidebarHidden()), { timeout: 2_000 });
    }
  });

  it('renders a sidebar header with × close button when a doc is open', async () => {
    expect(await browser.$('[data-view="sidebar-comments"]').isExisting()).toBe(true);
    expect(await browser.$('[data-region="sidebar-header"]').isExisting()).toBe(true);
    const closeBtn = await browser.$('[data-test="sidebar-close"]');
    expect(await closeBtn.isExisting()).toBe(true);
    expect(await closeBtn.getAttribute('aria-label')).toBe('Hide comments sidebar');
    expect(await bodySidebarHidden()).toBe(false);
  });

  it('clicking the × close button hides the sidebar', async () => {
    await browser.$('[data-test="sidebar-close"]').click();
    await browser.waitUntil(bodySidebarHidden, {
      timeout: 2_000,
      timeoutMsg: 'sidebar did not enter hidden state after close click',
    });
    const { display, width } = await sidebarRendered();
    expect(display).toBe('none');
    expect(width).toBe(0);
  });

  it('the floating "Show comments" pill appears while sidebar is hidden and reopens it', async () => {
    await browser.$('[data-test="sidebar-close"]').click();
    await browser.waitUntil(bodySidebarHidden, { timeout: 2_000 });
    // Pill exists in DOM regardless but only display:inline-flex while hidden.
    const pillVisible = await browser.execute(() => {
      const el = document.querySelector('[data-test="sidebar-show"]') as HTMLElement | null;
      return el ? getComputedStyle(el).display !== 'none' : false;
    });
    expect(pillVisible).toBe(true);

    await browser.$('[data-test="sidebar-show"]').click();
    await browser.waitUntil(async () => !(await bodySidebarHidden()), {
      timeout: 2_000,
      timeoutMsg: 'sidebar did not reopen via the show pill',
    });
    const { display } = await sidebarRendered();
    expect(display).not.toBe('none');
  });

  it('the View → Toggle Comments Sidebar menu action toggles the sidebar', async () => {
    // Hide via the menu action.
    await emitMenuAction('toggle-sidebar');
    await browser.waitUntil(bodySidebarHidden, {
      timeout: 2_000,
      timeoutMsg: 'sidebar did not hide via menu action',
    });
    expect((await sidebarRendered()).display).toBe('none');

    // Toggling again brings it back.
    await emitMenuAction('toggle-sidebar');
    await browser.waitUntil(async () => !(await bodySidebarHidden()), {
      timeout: 2_000,
      timeoutMsg: 'sidebar did not reopen via menu action',
    });
    expect((await sidebarRendered()).display).not.toBe('none');
  });

  it('the Cmd+Shift+S keyboard shortcut toggles the sidebar', async () => {
    // tauri-webdriver-automation's `browser.keys(['Meta', 'Shift', 's'])`
    // doesn't reliably deliver the modifier through the WebDriver bridge,
    // so dispatch a synthetic keydown directly. The keymap binding routes
    // through `dispatchAction('toggle_sidebar')` → CustomEvent on document
    // — exactly the same path the OS keypress would hit.
    await browser.execute(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true }),
      );
    });
    await browser.waitUntil(bodySidebarHidden, {
      timeout: 2_000,
      timeoutMsg: 'sidebar did not hide via keyboard shortcut',
    });

    await browser.execute(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true }),
      );
    });
    await browser.waitUntil(async () => !(await bodySidebarHidden()), {
      timeout: 2_000,
      timeoutMsg: 'sidebar did not reopen via keyboard shortcut',
    });
  });

  it('adding a new comment auto-shows the sidebar even after it was hidden', async () => {
    // 1) Hide the sidebar.
    await browser.$('[data-test="sidebar-close"]').click();
    await browser.waitUntil(bodySidebarHidden, { timeout: 2_000 });
    expect((await sidebarRendered()).display).toBe('none');

    // 2) Make a selection in the document and post a comment via the
    //    SelectionPopover composer — same flow as spec 03.
    const carrier = await browser.$('[data-view="document"] [data-src-offset]');
    expect(await carrier.isExisting()).toBe(true);
    await tripleClick('[data-view="document"] [data-src-offset]:first-of-type');
    await browser.waitUntil(
      async () => browser.$('[data-view="selection-popover"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'selection popover did not surface' },
    );
    await browser.$('[data-action="comment"]').click();
    await browser.$('[data-test="comment-body"]').setValue('Auto-show check');
    await browser.$('[data-action="post-comment"]').click();

    // 3) The sidebar should auto-show and the new thread should be visible.
    await browser.waitUntil(async () => !(await bodySidebarHidden()), {
      timeout: 5_000,
      timeoutMsg: 'sidebar did not auto-show after thread-created',
    });
    await browser.waitUntil(
      async () =>
        browser.$('[data-view="sidebar-comments"] [data-test="thread"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'new thread not visible in re-shown sidebar' },
    );
    const body = await browser.$(
      '[data-view="sidebar-comments"] [data-test="thread"] [data-test="comment-body-rendered"]',
    ).getText();
    expect(body).toBe('Auto-show check');
  });

  it('hidden state survives switching tabs', async () => {
    // Open a second doc so we have two tabs to ping-pong between.
    const second = path.join(fixture.tmpDir, 'second-toggle.md');
    await fs.writeFile(second, '# Second\n\nFor sidebar persistence.\n');
    await openDocByE2eHook(second);
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Second';
      },
      { timeout: 10_000, timeoutMsg: 'second doc did not render' },
    );

    // Hide via menu action.
    await emitMenuAction('toggle-sidebar');
    await browser.waitUntil(bodySidebarHidden, { timeout: 2_000 });

    // Click the first tab.
    await browser.execute(() => {
      const tab = Array.from(document.querySelectorAll<HTMLElement>('[data-test="tab"]'))[0];
      if (!tab) throw new Error('no tabs');
      tab.click();
    });
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Sample Document';
      },
      { timeout: 5_000, timeoutMsg: 'first tab did not activate' },
    );
    // Sidebar must STILL be hidden after the tab swap — visibility flag is
    // session-scoped, not per-tab.
    expect(await bodySidebarHidden()).toBe(true);
  });

  it('toggling the sidebar lets the document fill the freed horizontal space', async () => {
    const beforeWidth = await browser.execute(() => {
      const doc = document.querySelector(
        '[data-region="body"].with-document > div:not([data-region="sidebar"])',
      ) as HTMLElement | null;
      return doc?.offsetWidth ?? 0;
    });

    await browser.$('[data-test="sidebar-close"]').click();
    await browser.waitUntil(bodySidebarHidden, { timeout: 2_000 });

    const afterWidth = await browser.execute(() => {
      const doc = document.querySelector(
        '[data-region="body"].with-document > div:not([data-region="sidebar"])',
      ) as HTMLElement | null;
      return doc?.offsetWidth ?? 0;
    });
    // Sidebar is 320px wide; the doc should claim it (give or take a couple
    // of pixels for borders/scrollbars).
    expect(afterWidth - beforeWidth).toBeGreaterThan(280);
  });

  it('close button stays visible (and clickable) in dark mode', async () => {
    // Flip into dark mode via the keymap helper available on body.
    await browser.execute(() => {
      document.body.classList.add('theme-dark');
    });
    const contrast = await browser.execute(() => {
      const btn = document.querySelector(
        '[data-test="sidebar-close"]',
      ) as HTMLElement | null;
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      const parse = (s: string) => {
        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? +m[1] + +m[2] + +m[3] : 0;
      };
      return {
        bg: parse(cs.backgroundColor),
        fg: parse(cs.color),
      };
    });
    expect(contrast).toBeTruthy();
    // Foreground / background must differ enough that the × is readable.
    expect(Math.abs(contrast!.fg - contrast!.bg)).toBeGreaterThan(150);

    // Confirm the click still works in dark mode.
    await browser.$('[data-test="sidebar-close"]').click();
    await browser.waitUntil(bodySidebarHidden, {
      timeout: 2_000,
      timeoutMsg: 'sidebar close click did not register in dark mode',
    });

    // Restore light mode for subsequent tests.
    await browser.execute(() => document.body.classList.remove('theme-dark'));
  });
});
