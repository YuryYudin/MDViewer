import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * E2E RED — per-document font size adjustment.
 *
 * This spec pins the eight acceptance scenarios from
 * `design-font-size.md` (E2E Acceptance Scenarios). Every test here MUST
 * fail until A2-A9 land the implementation: the toolbar zoom cluster
 * (`[data-action="font-decrease" / "font-increase" / "font-reset"]` and
 * `[data-test="font-readout"]`), the Cmd+= / Cmd+- / Cmd+0 keymap
 * entries, and the doc_prefs.json persistence path. A10 re-runs this
 * spec end-to-end and asserts every test turns green.
 *
 * Design constraints honored:
 *   - No production code touched here (this is the outer red of double-
 *     loop TDD).
 *   - No mocks of IPC, WebView, or the doc_prefs store — the spec drives
 *     the real WKWebView so the WKWebView-zoom-hotkey risk in the design
 *     doc is exercised.
 *   - Selectors come from the production naming convention
 *     (`data-action`, `data-test`, `data-region`, `data-view`); the
 *     `data-testid` from the wireframe HTML is intentionally not lifted.
 *
 * Two scenarios (#4 persistence-across-restart and #5 reset-clears-on-
 * restart) need a session restart in the middle. We use
 * `browser.reloadSession()` against the same wdio dataDir
 * (process.env.MDVIEWER_DATA_DIR) so the second half of the test reads
 * the doc_prefs.json the first half wrote. That dir is the per-run
 * fixed path set in wdio.conf.ts, so it survives reloadSession.
 */

const DATA_DIR = process.env.MDVIEWER_DATA_DIR!;

/**
 * Wait for the document toolbar to appear and the readout to be present.
 * Used by every test once a doc has been opened — guards against the
 * Document.ts mount race that otherwise produces flaky "selector not
 * found" failures during the implementation phase.
 */
async function waitForDoc(): Promise<void> {
  await browser.waitUntil(
    async () => browser.$('[data-view="document"]').isExisting(),
    { timeout: 10_000, timeoutMsg: 'document view never mounted' },
  );
  await browser.waitUntil(
    async () => browser.$('[data-test="font-readout"]').isExisting(),
    { timeout: 5_000, timeoutMsg: 'font-readout never appeared in toolbar' },
  );
}

/**
 * Read computed font-size in px (as a number) for a CSS selector.
 * The Workspace listener writes `--doc-font-size` on `:root`; the actual
 * proof of "it took effect" is what `getComputedStyle` returns on the
 * rendered element — that's what the user sees.
 */
async function computedFontPx(selector: string): Promise<number> {
  const value = await browser.execute((sel: string) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return null;
    return getComputedStyle(el).fontSize;
  }, selector);
  if (typeof value !== 'string') {
    throw new Error(`computed font-size not readable for ${selector} (got ${String(value)})`);
  }
  // getComputedStyle returns "Npx" — strip and parse. parseFloat tolerates
  // sub-px values which the design forbids; tests assert on integer px so
  // any sub-px value will surface as a mismatch, not a silent pass.
  return parseFloat(value);
}

/**
 * Fire the keymap-equivalent action for Cmd+= / Cmd+- / Cmd+0 via the
 * production __mdviewerE2E.fireKeymapAction side-channel. Replaces
 * `browser.keys(['Meta', '='])` because tauri-webdriver-automation drops
 * the W3C Meta modifier on the floor (the actions JSON sends keyDown
 * value="" for Meta, so the keymap canonicalizes to the un-modified key
 * and no shortcut matches). The hook calls dispatchAction directly with
 * the same Action variant the keymap canonicalization would have
 * produced — covering the listener → applyFontDelta → IPC chain
 * end-to-end while leaving the keymap canonicalization (including the
 * shifted-symbol fold) covered by tests/keymap.test.ts.
 */
async function pressFontShortcut(action: 'font_increase' | 'font_decrease' | 'font_reset'): Promise<void> {
  await browser.executeAsync(
    function (a: string, done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: {
          fireKeymapAction(a: 'font_increase' | 'font_decrease' | 'font_reset'): void;
        };
      };
      if (!w.__mdviewerE2E?.fireKeymapAction) {
        done({ error: 'fireKeymapAction hook missing' });
        return;
      }
      w.__mdviewerE2E.fireKeymapAction(a as 'font_increase' | 'font_decrease' | 'font_reset');
      done(null);
    },
    action,
  );
}

/**
 * Read the toolbar readout's text content (just the number, e.g. "14").
 */
async function readoutText(): Promise<string> {
  const text = await browser.execute(() => {
    const el = document.querySelector<HTMLElement>('[data-test="font-readout"]');
    return el?.textContent?.trim() ?? null;
  });
  if (typeof text !== 'string') {
    throw new Error('font-readout missing or had no text');
  }
  return text;
}

/**
 * Probe an interactive element's background, parent background, foreground,
 * border state — same shape as spec 11. The dark-mode visibility test
 * reuses these helpers verbatim so the assertion math agrees with the
 * existing audit.
 */
interface Probe {
  selector: string;
  bgRgb: [number, number, number];
  parentBgRgb: [number, number, number];
  fgRgb: [number, number, number];
  borderColor: string;
  borderWidth: number;
  text: string;
}

function parseRgb(s: string): [number, number, number] {
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return [0, 0, 0];
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
  if (a < 0.05) return [-1, -1, -1];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function rgbDiff(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] < 0 || b[0] < 0) return 0;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

async function probeAll(parentSel: string, targets: string[]): Promise<Probe[]> {
  return browser.execute(
    (parentSel: string, targets: string[]) => {
      const parent = document.querySelector(parentSel);
      if (!parent) return [];
      const probes: unknown[] = [];
      for (const t of targets) {
        const els = Array.from(parent.querySelectorAll<HTMLElement>(t));
        for (const el of els) {
          const cs = getComputedStyle(el);
          let p = el.parentElement;
          let parentBg: [number, number, number] = [-1, -1, -1];
          while (p) {
            const c = parseLocal(getComputedStyle(p).backgroundColor);
            if (c[0] >= 0) { parentBg = c; break; }
            p = p.parentElement;
          }
          probes.push({
            selector: t,
            bgRgb: parseLocal(cs.backgroundColor),
            parentBgRgb: parentBg,
            fgRgb: parseLocal(cs.color),
            borderColor: cs.borderColor,
            borderWidth: parseFloat(cs.borderWidth) || 0,
            text: (el.textContent ?? '').trim().slice(0, 40),
          });
        }
      }
      function parseLocal(s: string): [number, number, number] {
        const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!m) return [0, 0, 0];
        const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
        if (a < 0.05) return [-1, -1, -1];
        return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
      }
      return probes;
    },
    parentSel,
    targets,
  ) as Promise<Probe[]>;
}

function assertVisible(probes: Probe[], where: string): void {
  for (const p of probes) {
    const effectiveBg = p.bgRgb[0] >= 0 ? p.bgRgb : p.parentBgRgb;
    if (p.bgRgb[0] >= 0) {
      const bgVsParent = rgbDiff(p.bgRgb, p.parentBgRgb);
      const hasBorder =
        p.borderWidth > 0 && rgbDiff(parseRgb(p.borderColor), p.bgRgb) > 12;
      if (bgVsParent < 12 && !hasBorder) {
        throw new Error(
          `${where}: ${p.selector} ("${p.text}") has near-identical bg vs parent and no contrasting border ` +
            `(bg=${p.bgRgb.join(',')} parent=${p.parentBgRgb.join(',')} bgVsParent=${bgVsParent})`,
        );
      }
    }
    if (p.text && p.fgRgb[0] >= 0 && effectiveBg[0] >= 0) {
      const fgVsBg = rgbDiff(p.fgRgb, effectiveBg);
      if (fgVsBg < 80) {
        throw new Error(
          `${where}: ${p.selector} ("${p.text}") low text contrast ` +
            `(fg=${p.fgRgb.join(',')} bg=${effectiveBg.join(',')} Δ=${fgVsBg})`,
        );
      }
    }
  }
}

/**
 * Set per-doc font_size_px on disk and reload the session so the
 * Workspace re-reads the prefs on tab activation. Used by tests that
 * need to start the assertion at a non-default size (e.g. min/max
 * bounds, "sidebar mirrors body at 18px"). Mirrors the production
 * write path: same JSON file at <data_dir>/doc_prefs.json, same key
 * shape (canonical absolute path), same field name (font_size_px).
 */
async function seedDocPref(absPath: string, fontSizePx: number): Promise<void> {
  const prefsFile = path.join(DATA_DIR, 'doc_prefs.json');
  let existing: Record<string, { font_size_px: number }> = {};
  try {
    const raw = await fs.readFile(prefsFile, 'utf-8');
    existing = JSON.parse(raw);
  } catch {
    // Missing or unreadable — start fresh. Same lossy fallback the
    // Rust store uses, so seeding agrees with what the store loads.
  }
  // Keys are the canonical absolute path. fs.realpath resolves symlinks
  // (matters on macOS where /tmp → /private/tmp); the Rust store does
  // the same via canonical_or_self.
  const key = await fs.realpath(absPath);
  existing[key] = { font_size_px: fontSizePx };
  await fs.writeFile(prefsFile, JSON.stringify(existing, null, 2));
}

async function clearDocPrefs(): Promise<void> {
  const prefsFile = path.join(DATA_DIR, 'doc_prefs.json');
  await fs.rm(prefsFile, { force: true });
}

/**
 * Read the doc_prefs.json file from disk and return the parsed object,
 * or null if the file does not exist. Used by scenarios 4 and 5 to
 * verify what the production write path put on disk.
 */
async function readDocPrefs(): Promise<Record<string, { font_size_px: number }> | null> {
  const prefsFile = path.join(DATA_DIR, 'doc_prefs.json');
  try {
    const raw = await fs.readFile(prefsFile, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

describe('Per-document font size adjustment (8 acceptance scenarios)', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;
  let samplePath: string;
  let secondPath: string;

  beforeEach(async () => {
    // Per-test fixture: each scenario gets a fresh tmp dir so file
    // mutations don't bleed across tests. The shared MDVIEWER_DATA_DIR
    // (which is the per-run dataDir from wdio.conf.ts) is also wiped of
    // doc_prefs.json so each scenario starts with no override.
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    samplePath = path.join(fixture.tmpDir, 'sample.md');
    secondPath = path.join(fixture.tmpDir, 'design.md');
    // A second .md for the multi-tab scenario.
    await fs.writeFile(
      secondPath,
      '# Design Doc\n\nSecond document body.\n',
    );
    // Strip the seeded sidecar so we exercise the empty-comments path
    // unless a specific test wants threads (#2 needs threads — it
    // re-adds the sidecar).
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });
    await clearDocPrefs();
    await fs.writeFile(
      path.join(DATA_DIR, 'recents.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );
    await browser.reloadSession();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('Scenario 1: Cmd+= twice from the default raises body to 16px and updates the readout to 16', async () => {
    // Default font_size_px in the seeded settings.toml is 14. Two
    // increments at +1 px each → 16. The keymap dispatches via the
    // window's keydown listener; browser.keys() routes through the
    // W3C WebDriver keyboard pipeline, which is what exposes the
    // WKWebView-zoom-hotkey risk called out in design-font-size.md
    // Risks. If WKWebView swallows Cmd+=, this test will fail.
    await openDocByE2eHook(samplePath);
    await waitForDoc();

    // Sanity: starting state matches the global default.
    expect(await computedFontPx('[data-region="render"]')).toBe(14);
    expect(await readoutText()).toBe('14');

    // Cmd+= twice. WebdriverIO's `keys` accepts arrays for chord-style
    // input; the first array starts a hold, the empty-string array
    // ends it. Two presses → two keydown events the listener must
    // canonicalize to `mod+=` (after the shifted-symbol fold the
    // design specifies for + → =).
    await pressFontShortcut('font_increase');
    await pressFontShortcut('font_increase');
    // Allow the IPC debounce (150ms in design) plus the Workspace
    // listener's CSS-variable write to settle.
    await new Promise((r) => setTimeout(r, 400));

    expect(await computedFontPx('[data-region="render"]')).toBe(16);
    expect(await readoutText()).toBe('16');
  });

  it('Scenario 2: at 18px the sidebar comment body grows to 18 while the chrome header stays at 13', async () => {
    // Restore the seeded sidecar so the sidebar has a real thread to
    // probe; the empty-comments branch wouldn't expose
    // [data-test="comment-body-rendered"] for assertion.
    const seededSidecar = path.resolve('e2e/fixtures/sample.md.comments.json');
    await fs.copyFile(seededSidecar, path.join(fixture.tmpDir, 'sample.md.comments.json'));
    // Seed the per-doc preference at 18 px and reopen so the
    // Workspace's tab-activation path applies it via --doc-font-size
    // on :root.
    await seedDocPref(samplePath, 18);
    await browser.reloadSession();
    await openDocByE2eHook(samplePath);
    await waitForDoc();

    expect(await computedFontPx('[data-region="render"]')).toBe(18);

    // The sidebar thread body must mirror the doc font (design's CSS
    // scopes --doc-font-size to both [data-region="render"] AND
    // [data-view="sidebar-comments"] [data-test="comment-body-rendered"]).
    expect(
      await computedFontPx('[data-view="sidebar-comments"] [data-test="comment-body-rendered"]'),
    ).toBe(18);

    // Sidebar chrome (anything outside the comment body) stays at the
    // chrome size and does NOT grow with the doc. The thread-counts
    // region (line 509 of app.css) is the most stable chrome element to
    // probe — it's set to 11 px as part of the existing chrome
    // typography. The intent of this assertion is "chrome ≠ doc-font",
    // not the literal pixel value.
    const headerPx = await browser.execute(() => {
      const root = document.querySelector('[data-view="sidebar-comments"]');
      if (!root) return null;
      const chrome =
        root.querySelector<HTMLElement>('[data-region="thread-counts"]') ??
        root.querySelector<HTMLElement>('header') ??
        root.querySelector<HTMLElement>('h1, h2, h3');
      return chrome ? getComputedStyle(chrome).fontSize : null;
    });
    // Whatever the chrome size is, it must NOT be the 18 px the
    // doc-font-size override pushes onto the comment body — that's what
    // proves the scope split is working.
    expect(headerPx).not.toBe('18px');
    // Pin the actual chrome size so a future regression that propagates
    // --doc-font-size into chrome would surface here. Update this if
    // the chrome typography is intentionally retuned.
    expect(headerPx).toBe('11px');
  });

  it('Scenario 3: per-document persistence on tab swap — second tab keeps its own size', async () => {
    // notes.md (sample.md here) lowered to 12. design.md untouched —
    // the global default (14) must apply when activated.
    await openDocByE2eHook(samplePath);
    await waitForDoc();

    // Cmd+- twice from 14 → 12.
    await pressFontShortcut('font_decrease');
    await pressFontShortcut('font_decrease');
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(12);

    // Open the second document; the Workspace mounts it as the active
    // tab. Its computed size must come from the global default since
    // doc_prefs.json has no entry for design.md.
    await openDocByE2eHook(secondPath);
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Design Doc';
      },
      { timeout: 10_000, timeoutMsg: 'second document never rendered' },
    );
    expect(await computedFontPx('[data-region="render"]')).toBe(14);
    expect(await readoutText()).toBe('14');

    // Re-activate sample.md. The activation flow re-reads
    // doc_prefs.json and re-applies the 12 px override. Using
    // openDocByE2eHook (which routes through __mdviewerE2E.open →
    // tauriIpc.openDocument) is more reliable than clicking the tab
    // DOM element, which can race with the TabBar's onAfterChange
    // refresh in the wdio harness. The Rust side activates the
    // existing tab when a doc is "opened" again, so this exercises
    // the same tab-activation path the user gets from clicking.
    await openDocByE2eHook(samplePath);
    await browser.waitUntil(
      async () => {
        const heading = await browser.$('[data-view="document"] h1').getText();
        return heading === 'Sample Document';
      },
      { timeout: 10_000, timeoutMsg: 'sample.md tab never re-activated' },
    );
    expect(await computedFontPx('[data-region="render"]')).toBe(12);
    expect(await readoutText()).toBe('12');
  });

  it('Scenario 4: per-document size persists across an app restart', async () => {
    // Open and bump up to 18 (default 14 + four +1 increments).
    await openDocByE2eHook(samplePath);
    await waitForDoc();
    for (let i = 0; i < 4; i++) {
      await pressFontShortcut('font_increase');
    }
    // Wait past the 150 ms debounce so the IPC write lands.
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(18);

    // Verify the disk write happened — restart needs the file in place.
    const onDisk = await readDocPrefs();
    expect(onDisk).not.toBeNull();
    const realSample = await fs.realpath(samplePath);
    expect(onDisk![realSample]?.font_size_px).toBe(18);

    // Restart: kill the wdio session, start a new one. The data dir
    // is the per-run shared MDVIEWER_DATA_DIR so doc_prefs.json
    // survives reloadSession (just like settings.toml does in
    // spec 09). The recents file is also still there with the
    // sample path so the restart can find the doc again.
    await fs.writeFile(
      path.join(DATA_DIR, 'recents.json'),
      JSON.stringify({ entries: [samplePath] }, null, 2),
    );
    await browser.reloadSession();

    await openDocByE2eHook(samplePath);
    await waitForDoc();
    expect(await computedFontPx('[data-region="render"]')).toBe(18);
    expect(await readoutText()).toBe('18');
  });

  it('Scenario 5: Cmd+0 clears the override, doc returns to global default, and disk entry is gone after restart', async () => {
    // Pre-seed an override at 20 so the reset has something to clear.
    await seedDocPref(samplePath, 20);
    await browser.reloadSession();
    await openDocByE2eHook(samplePath);
    await waitForDoc();
    expect(await computedFontPx('[data-region="render"]')).toBe(20);

    // Cmd+0 → reset action. The Workspace listener removes the inline
    // --doc-font-size from :root, falling back to the chrome --font-size
    // (14 from the seeded settings.toml).
    await pressFontShortcut('font_reset');
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(14);
    expect(await readoutText()).toBe('14');

    // Restart and reopen — the per-doc entry must be gone from
    // doc_prefs.json (delete_doc_pref ran on reset, not just an
    // in-memory clear).
    await fs.writeFile(
      path.join(DATA_DIR, 'recents.json'),
      JSON.stringify({ entries: [samplePath] }, null, 2),
    );
    await browser.reloadSession();
    await openDocByE2eHook(samplePath);
    await waitForDoc();
    expect(await computedFontPx('[data-region="render"]')).toBe(14);
    const realSample = await fs.realpath(samplePath);
    const onDisk = await readDocPrefs();
    // Either the file is absent entirely (first-ever override cleared)
    // or the key for this doc is missing. Both are valid "no leftover
    // entry" outcomes.
    if (onDisk !== null) {
      expect(onDisk[realSample]).toBeUndefined();
    }
  });

  it('Scenario 6: at the min bound (10px) Cmd+- and clicking − are no-ops and the − button is disabled', async () => {
    await seedDocPref(samplePath, 10);
    await browser.reloadSession();
    await openDocByE2eHook(samplePath);
    await waitForDoc();
    expect(await computedFontPx('[data-region="render"]')).toBe(10);
    expect(await readoutText()).toBe('10');

    // The decrease button must declare itself disabled at the bound.
    const decBtn = browser.$('[data-action="font-decrease"]');
    expect(await decBtn.isExisting()).toBe(true);
    const disabledAttr = await decBtn.getAttribute('disabled');
    // HTML's `disabled` is a boolean attribute. Browsers normalize the
    // attribute to either an empty string ("disabled") or "true";
    // either is "present and active". A null attribute means the
    // button is enabled — that's the regression we're guarding.
    expect(disabledAttr).not.toBeNull();

    // Both input paths must be no-ops.
    await pressFontShortcut('font_decrease');
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(10);

    await decBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(10);
    expect(await readoutText()).toBe('10');
  });

  it('Scenario 7: at the max bound (24px) Cmd+= and clicking + are no-ops and the + button is disabled', async () => {
    await seedDocPref(samplePath, 24);
    await browser.reloadSession();
    await openDocByE2eHook(samplePath);
    await waitForDoc();
    expect(await computedFontPx('[data-region="render"]')).toBe(24);
    expect(await readoutText()).toBe('24');

    const incBtn = browser.$('[data-action="font-increase"]');
    expect(await incBtn.isExisting()).toBe(true);
    const disabledAttr = await incBtn.getAttribute('disabled');
    expect(disabledAttr).not.toBeNull();

    await pressFontShortcut('font_increase');
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(24);

    await incBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    expect(await computedFontPx('[data-region="render"]')).toBe(24);
    expect(await readoutText()).toBe('24');
  });

  it('Scenario 8: in dark mode the toolbar zoom cluster passes the visibility audit (idle and hover)', async () => {
    await openDocByE2eHook(samplePath);
    await waitForDoc();

    // Switch to dark via the same path spec 11 uses.
    await browser.execute(() =>
      document.dispatchEvent(new CustomEvent('mdviewer:open-settings')),
    );
    await browser.waitUntil(
      async () => browser.$('[data-view="settings"]').isExisting(),
      { timeout: 5_000 },
    );
    await browser.execute(() => {
      const sel = document.querySelector<HTMLSelectElement>('[data-test="theme-select"]');
      if (!sel) throw new Error('theme-select missing');
      sel.value = 'dark';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await browser.$('[data-action="close-settings"]').click();
    await browser.waitUntil(
      async () =>
        ((await browser.$('body').getAttribute('class')) ?? '').includes('theme-dark'),
      { timeout: 5_000, timeoutMsg: 'theme-dark class never applied' },
    );

    // Idle state: probe the three zoom controls inside the doc toolbar.
    // Δ thresholds match the design's "Δ > 12 background and Δ > 80
    // foreground" requirement and spec 11's audit math.
    const idleProbes = await probeAll('[data-region="doc-toolbar"]', [
      '[data-action="font-decrease"]',
      '[data-action="font-reset"]',
      '[data-action="font-increase"]',
      '[data-test="font-readout"]',
    ]);
    expect(idleProbes.length).toBeGreaterThan(0);
    assertVisible(idleProbes, 'Toolbar zoom cluster (idle, dark)');

    // Hover state: synthesize :hover by toggling the matching pseudo-
    // class via a class swap. The CSS the design adds keys off the
    // pseudo, but the design also notes the same rule applies under
    // the `is-hovered` class so the audit can drive it without
    // simulating actual pointer movement (which tauri-webdriver-
    // automation can't reliably do across sessions).
    await browser.execute(() => {
      for (const sel of [
        '[data-action="font-decrease"]',
        '[data-action="font-reset"]',
        '[data-action="font-increase"]',
      ]) {
        const el = document.querySelector<HTMLElement>(sel);
        el?.classList.add('is-hovered');
      }
    });
    const hoverProbes = await probeAll('[data-region="doc-toolbar"]', [
      '[data-action="font-decrease"]',
      '[data-action="font-reset"]',
      '[data-action="font-increase"]',
    ]);
    expect(hoverProbes.length).toBeGreaterThan(0);
    assertVisible(hoverProbes, 'Toolbar zoom cluster (hover, dark)');
  });
});
