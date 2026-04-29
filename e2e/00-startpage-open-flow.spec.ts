import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from './helpers/app';

/**
 * Cover the production "click to open" plumbing that
 * `openDocByE2eHook` (used by the other specs) bypasses. StartPage has
 * three paths into `ipc.openDocument`:
 *   - the OS dialog (Open… button outside e2e mode)
 *   - the hidden <input type=file> change handler (e2e mode)
 *   - the recents list click
 *
 * All three discarded the OpenOutcome until the onOpened callback was
 * wired through Workspace → StartPage. Recents is the simplest of the
 * three to exercise: pre-populate recents.json before the session
 * starts, click the entry, assert the document mounts. If any of the
 * three paths regresses the same way again, this catches it.
 */
describe('StartPage → click a recent → document mounts', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Strip the pre-seeded sidecar so the doc starts empty (matches
    // wireframe-03's empty-comments path).
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });

    // Pre-populate recents.json in MDVIEWER_DATA_DIR with the fixture path
    // so StartPage renders a recent-item the test can click.
    const dataDir = process.env.MDVIEWER_DATA_DIR;
    if (!dataDir) throw new Error('MDVIEWER_DATA_DIR env not set; check wdio.conf.ts');
    const target = path.join(fixture.tmpDir, 'sample.md');
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [target] }, null, 2),
    );
    // Force a fresh session so the running app re-reads recents.json.
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('clicking a recent path opens the document and renders it', async () => {
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);

    // Wireframe-01 fidelity: the StartPage greets by display_name, the
    // action row holds Open · New · Settings in that order, and each
    // recent shows filename + ~tilde-path + relative when.
    const heading = await browser.$('[data-test="welcome-heading"]').getText();
    expect(heading).toMatch(/Welcome (back, .+|to MDViewer)/);

    const actionAttrs = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          '[data-test="startpage-actions"] > button',
        ),
      ).map((b) => b.getAttribute('data-action')),
    );
    expect(actionAttrs).toEqual(['open-file', 'new-document', 'open-settings']);

    const recent = browser.$('[data-test="recent-item"]');
    expect(await recent.isExisting()).toBe(true);
    expect(await recent.$('[data-test="recent-name"]').getText()).toBe('sample.md');
    // mtime may be very recent (we just wrote the file) so accept any
    // of the relative-time forms; just verify the column rendered.
    const when = await recent.$('[data-test="recent-when"]').getText();
    expect(when).not.toBe('');

    // Layout fidelity (wireframe-01): the status bar must sit at the
    // bottom of the workspace, not float in the middle. This catches
    // the regression where a hidden titlebar's grid track shoved the
    // status bar into the 1fr middle row. Tolerate a few pixels of
    // anti-aliasing / sub-pixel rounding.
    const layout = await browser.execute(() => {
      const ws = document.querySelector('[data-view="workspace"]') as HTMLElement;
      const status = document.querySelector('[data-region="status"]') as HTMLElement;
      const tabbar = document.querySelector('[data-region="tabbar"]') as HTMLElement;
      const wsRect = ws.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      const tabbarRect = tabbar.getBoundingClientRect();
      return {
        statusBottom: statusRect.bottom,
        wsBottom: wsRect.bottom,
        statusTop: statusRect.top,
        tabbarTop: tabbarRect.top,
        wsTop: wsRect.top,
        tabbarHeight: tabbarRect.height,
        statusHeight: statusRect.height,
      };
    });
    expect(Math.abs(layout.statusBottom - layout.wsBottom)).toBeLessThan(2);
    // Status sits below the body, not above it.
    expect(layout.statusTop).toBeGreaterThan(layout.tabbarTop + 100);
    // Tabbar is the wireframe-spec 36 px (allow ±1 for rounding).
    expect(Math.abs(layout.tabbarHeight - 36)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.statusHeight - 22)).toBeLessThanOrEqual(1);

    await recent.click();

    // After the click, Workspace's onOpened callback runs setActive +
    // refresh, which mounts the document view.
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount after recent click' },
    );

    const doc = browser.$('[data-view="document"]');
    expect(await doc.$('h1').getText()).toBe('Sample Document');

    // Status bar must STAY at the bottom after the document mounts. A
    // tall markdown body with a lot of intrinsic min-content can shove
    // the body row past its grid track and push the 22px status row off
    // the viewport — this assertion would have caught that regression
    // (Screenshot.png: status bar disappeared once a doc was opened).
    const docLayout = await browser.execute(() => {
      const ws = document.querySelector('[data-view="workspace"]') as HTMLElement;
      const status = document.querySelector('[data-region="status"]') as HTMLElement;
      const wsRect = ws.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      return {
        statusBottom: statusRect.bottom,
        wsBottom: wsRect.bottom,
        statusHeight: statusRect.height,
        statusVisible: statusRect.bottom <= window.innerHeight + 1,
      };
    });
    expect(docLayout.statusVisible).toBe(true);
    expect(Math.abs(docLayout.statusBottom - docLayout.wsBottom)).toBeLessThan(2);
    expect(Math.abs(docLayout.statusHeight - 22)).toBeLessThanOrEqual(1);

    // Document content must be scrollable. The render region holds the
    // rendered markdown and uses `flex: 1; overflow: auto` — for that
    // to actually produce a scrollbar the parent height chain has to
    // be bounded, otherwise it collapses to min-content and clips.
    // Catches the regression where adding `overflow: hidden` to the
    // body grid items removed scrolling from the document pane.
    const scroll = await browser.execute(() => {
      const render = document.querySelector('[data-region="render"]') as HTMLElement;
      return {
        clientHeight: render.clientHeight,
        scrollHeight: render.scrollHeight,
      };
    });
    expect(scroll.clientHeight).toBeGreaterThan(0);
    expect(scroll.scrollHeight).toBeGreaterThanOrEqual(scroll.clientHeight);

    // Layout fidelity end-to-end. Walk every region in the height
    // chain and assert each one fills its share. The bug spotted by
    // the user was: body / doc / sidebar all reported the right
    // height, but the *render region inside the document* was half
    // because a hidden Edit region was still claiming flex space.
    // Pure body/doc checks would pass while the user sees half. So
    // this test asserts the FULL chain.
    const layoutChain = await browser.execute(() => {
      const get = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el ? el.getBoundingClientRect().height : -1;
      };
      return {
        ws: get('[data-view="workspace"]'),
        tabbar: get('[data-region="tabbar"]'),
        status: get('[data-region="status"]'),
        body: get('[data-region="body"]'),
        doc: get('[data-view="document"]'),
        toolbar: get('[data-region="doc-toolbar"]'),
        render: get('[data-region="render"]'),
        sidebar: get('[data-region="body"] > [data-region="sidebar"]'),
      };
    });
    // (a) Body fills its workspace track.
    const expectedBody = layoutChain.ws - layoutChain.tabbar - layoutChain.status;
    expect(layoutChain.body / expectedBody).toBeGreaterThanOrEqual(0.95);
    // (b) Doc and sidebar fill the body's full height.
    expect(layoutChain.doc / layoutChain.body).toBeGreaterThanOrEqual(0.95);
    expect(layoutChain.sidebar / layoutChain.body).toBeGreaterThanOrEqual(0.95);
    // (c) Render fills the doc minus the toolbar — catches the
    //     "hidden edit region steals flex space" regression directly.
    const expectedRender = layoutChain.doc - layoutChain.toolbar;
    expect(layoutChain.render / expectedRender).toBeGreaterThanOrEqual(0.95);
  });
});
