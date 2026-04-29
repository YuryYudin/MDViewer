import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from './helpers/app';

/**
 * Dark-mode visibility audit.
 *
 * Walk every interactive element across the major views and assert two
 * things in dark mode:
 *
 *   1. The element's background is distinguishable from its parent's
 *      background (Δ > 12 in summed RGB) OR it has a visible border.
 *   2. Foreground text (when present) contrasts with its own background
 *      (Δ > 80 summed RGB ≈ ~3:1 contrast — relaxed from WCAG-AA's 4.5:1
 *      because dim labels intentionally use lower contrast).
 *
 * The full screenshot+OCR fidelity check is out of scope; this is the
 * minimum bar that catches "button is invisible because its bg matches
 * the panel's bg" — exactly the regression Screenshot.png surfaced.
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

async function switchToDark(): Promise<void> {
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
  // Settings overlay stays open intentionally so the audit covers it too.
  await browser.waitUntil(
    async () =>
      ((await browser.$('body').getAttribute('class')) ?? '').includes('theme-dark'),
    { timeout: 5_000, timeoutMsg: 'theme-dark class never applied' },
  );
}

function parseRgb(s: string): [number, number, number] {
  // getComputedStyle returns "rgb(R, G, B)" or "rgba(R, G, B, A)" or
  // "transparent" / "rgba(0, 0, 0, 0)" — treat transparent as null sentinel.
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return [0, 0, 0];
  const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
  if (a < 0.05) return [-1, -1, -1]; // transparent — caller sees parent bg
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
          // Walk ancestors until we find one with an opaque background.
          // Stops at <body> at the latest; fully-transparent stack bottoms
          // out as the body's bg, which is always set by the theme.
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
    // The element's effective background is its own if opaque, otherwise
    // the first opaque ancestor (already resolved in probeAll).
    const effectiveBg = p.bgRgb[0] >= 0 ? p.bgRgb : p.parentBgRgb;

    // Distinguishability check: only enforce when the element has its
    // own opaque bg. Transparent elements (e.g. version-label) ride on
    // the parent's bg — they're "visible" via text contrast alone.
    if (p.bgRgb[0] >= 0) {
      const bgVsParent = rgbDiff(p.bgRgb, p.parentBgRgb);
      const hasBorder =
        p.borderWidth > 0 && rgbDiff(parseRgb(p.borderColor), p.bgRgb) > 12;
      if (bgVsParent < 12 && !hasBorder) {
        throw new Error(
          `${where}: ${p.selector} ("${p.text}") has same bg as parent and no visible border ` +
            `(bg=${p.bgRgb.join(',')} parent=${p.parentBgRgb.join(',')} border=${p.borderColor}@${p.borderWidth})`,
        );
      }
    }

    // Foreground vs effective-background — only when there's text.
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

describe('dark-mode visibility audit', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    // Make sure the active settings.toml has display_name set so the
    // session boots into Workspace, not ProfileSetup.
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    const target = path.join(fixture.tmpDir, 'sample.md');
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [target] }, null, 2),
    );
    await browser.reloadSession();
  });
  after(async () => { await fixture.cleanup(); });

  it('Settings overlay buttons + inputs visible in dark mode', async () => {
    await switchToDark();
    const probes = await probeAll('[data-view="settings"]', [
      'button',
      'input[type="text"]',
      'input[type="number"]',
      'input[type="color"]',
      'select',
    ]);
    expect(probes.length).toBeGreaterThan(0);
    assertVisible(probes, 'Settings');
  });

  it('StartPage action row + recents visible in dark mode', async () => {
    await browser.$('[data-action="close-settings"]').click();
    await browser.waitUntil(
      async () => !(await browser.$('[data-view="settings"]').isExisting()),
      { timeout: 5_000 },
    );
    const probes = await probeAll('[data-view="start"]', ['button', '[data-test="recent-item"]']);
    expect(probes.length).toBeGreaterThan(0);
    assertVisible(probes, 'StartPage');
  });

  it('Document view chrome (toolbar buttons) visible in dark mode', async () => {
    await openDocByE2eHook(path.join(fixture.tmpDir, 'sample.md'));
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000 },
    );
    const probes = await probeAll('[data-region="doc-toolbar"]', ['button']);
    expect(probes.length).toBeGreaterThan(0);
    assertVisible(probes, 'Document toolbar');
  });

  it('CommentsSidebar threads + reply composer visible in dark mode', async () => {
    const probes = await probeAll('[data-view="sidebar-comments"]', [
      '[data-test="thread"]',
      '[data-action="post-reply"]',
      '[data-action="resolve"]',
      '[data-test="reply-body"]',
    ]);
    if (probes.length > 0) assertVisible(probes, 'CommentsSidebar');
  });

  it('Status bar version label + profile chip visible in dark mode', async () => {
    const probes = await probeAll('[data-region="status"]', [
      '[data-test="user-name"]',
      '[data-test="version-label"]',
    ]);
    expect(probes.length).toBe(2);
    assertVisible(probes, 'Status bar');
  });
});
