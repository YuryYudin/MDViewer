import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../helpers/app';

/**
 * A1 — Print @media stylesheet (scenarios S2, S3, S4).
 *
 * The Print (B1) and Export-to-PDF (C1) actions both render under print
 * media, so this stylesheet is what makes their output clean. This spec
 * asserts the `@media print` rules are present and carry the expected
 * declarations.
 *
 * Why CSSOM-rule introspection instead of live print-media emulation:
 * tauri-webdriver-automation does not expose a way to force the WebView's
 * media to `print` (no `Emulation.setEmulatedMedia` CDP equivalent, no
 * driveable print dialog). So we read every rule nested inside an
 * `@media print` block (a `CSSMediaRule` whose `media.mediaText` includes
 * "print"), resolve the cascade of declarations that target a given
 * selector, and assert the expected property values. This is a faithful
 * proxy for "what the print engine would compute" because the engine
 * applies exactly these print-media rules on top of the screen cascade,
 * and our rules use `!important` so they win deterministically.
 *
 * The adversarial case (S2) is the DARK theme active: the render region's
 * print background must still be white and body text black, so the dark
 * theme's --surface / --text tokens cannot leak into printed output.
 */

interface PrintDecl {
  /** Selector text of a rule found inside an `@media print` block. */
  selectorText: string;
  /** Property → value map for that rule (priority suffixed as " !important"). */
  declarations: Record<string, string>;
}

/**
 * Collect every style rule that lives inside an `@media print` block across
 * all stylesheets the document has loaded. Runs inside the WebView so it can
 * walk `document.styleSheets` / the live CSSOM.
 */
async function collectPrintRules(): Promise<PrintDecl[]> {
  return browser.execute(function (): PrintDecl[] {
    const out: PrintDecl[] = [];
    function walk(rules: CSSRuleList): void {
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i] as CSSRule;
        // CSSMediaRule whose media query is (or includes) print.
        const media = (rule as CSSMediaRule).media;
        if (media && /\bprint\b/i.test(media.mediaText)) {
          const inner = (rule as CSSMediaRule).cssRules;
          for (let j = 0; j < inner.length; j++) {
            const styleRule = inner[j] as CSSStyleRule;
            if (!styleRule.selectorText || !styleRule.style) continue;
            const declarations: Record<string, string> = {};
            for (let k = 0; k < styleRule.style.length; k++) {
              const prop = styleRule.style[k];
              const val = styleRule.style.getPropertyValue(prop).trim();
              const prio = styleRule.style.getPropertyPriority(prop);
              declarations[prop] = prio ? val + ' !important' : val;
            }
            out.push({ selectorText: styleRule.selectorText, declarations });
          }
        }
      }
    }
    for (let s = 0; s < document.styleSheets.length; s++) {
      let rules: CSSRuleList | null = null;
      try {
        rules = document.styleSheets[s].cssRules;
      } catch {
        // Cross-origin sheet — skip. Our stylesheets are same-origin.
        continue;
      }
      if (rules) walk(rules);
    }
    return out;
  });
}

/**
 * Normalize a selector for comparison: strip quotes (WebKit's CSSOM may
 * report `[data-region=render]` while the authored source quotes the
 * value) and collapse whitespace. This keeps the matcher robust to the
 * engine's selector-text normalization.
 */
function normSelector(s: string): string {
  return s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Resolve the print-media value of `prop` for the last rule (in source
 * order, so the cascade wins) whose selectorText, split on commas,
 * contains `selector` as one of its comma-separated parts. Returns the
 * value (with any " !important" suffix) or undefined if no print rule
 * sets it.
 */
function printValue(
  rules: PrintDecl[],
  selector: string,
  prop: string,
): string | undefined {
  let resolved: string | undefined;
  const want = normSelector(selector);
  for (const r of rules) {
    const parts = r.selectorText.split(',').map(normSelector);
    if (parts.includes(want) && prop in r.declarations) {
      resolved = r.declarations[prop];
    }
  }
  return resolved;
}

describe('A1: print @media stylesheet', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    const dataDir = process.env.MDVIEWER_DATA_DIR!;
    const target = path.join(fixture.tmpDir, 'sample.md');
    await fs.writeFile(
      path.join(dataDir, 'recents.json'),
      JSON.stringify({ entries: [target] }, null, 2),
    );
    await browser.reloadSession();
    // Open a document so the render region + chrome are all mounted and
    // the stylesheets that target them are live in the CSSOM.
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document never mounted' },
    );
    // Switch to the dark theme — the adversarial case for S2. The print
    // rules must force white/black regardless of the active theme.
    await browser.execute(() => {
      document.body.classList.add('theme-dark');
    });
    await browser.waitUntil(
      async () =>
        ((await browser.$('body').getAttribute('class')) ?? '').includes('theme-dark'),
      { timeout: 5_000, timeoutMsg: 'theme-dark class never applied' },
    );
  });
  after(async () => { await fixture.cleanup(); });

  it('S2: print output is clean and theme-independent', async () => {
    const rules = await collectPrintRules();
    expect(rules.length).toBeGreaterThan(0);

    // Chrome regions are hidden in print output. The chrome-hiding rule in
    // app.css lists these four full selectors; the render region cascade is
    // unaffected (those rules live in document.css).
    expect(
      printValue(rules, ".workspace > [data-region='tabbar']", 'display'),
    ).toBe('none !important');
    expect(
      printValue(rules, ".workspace > [data-region='status']", 'display'),
    ).toBe('none !important');
    expect(
      printValue(
        rules,
        ".workspace > [data-region='body'] [data-region='sidebar']",
        'display',
      ),
    ).toBe('none !important');
    expect(
      printValue(
        rules,
        "[data-view='document'] [data-region='doc-toolbar']",
        'display',
      ),
    ).toBe('none !important');

    // Render region: white background / black text even with the dark theme
    // active. Assert the print rule forces these regardless of --surface /
    // --text tokens (which are near-black in dark mode).
    expect(printValue(rules, "[data-region='render']", 'background')).toBe(
      '#fff !important',
    );
    expect(printValue(rules, "[data-region='render']", 'color')).toBe(
      '#000 !important',
    );
    // Full-bleed: screen padding neutralized, content overflows across pages.
    expect(printValue(rules, "[data-region='render']", 'overflow')).toBe(
      'visible !important',
    );
    expect(printValue(rules, "[data-region='render']", 'padding')).toBe(
      '0 !important',
    );

    // Body text elements forced to black so the dark theme can't render
    // light-on-white prose; verify a representative one.
    expect(printValue(rules, "[data-region='render'] p", 'color')).toBe(
      '#000 !important',
    );
  });

  it('S3: page-break hygiene keeps headings and atomic blocks intact', async () => {
    const rules = await collectPrintRules();

    // Headings keep their following content on the same page.
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(printValue(rules, `[data-region='render'] ${h}`, 'break-after')).toBe(
        'avoid',
      );
    }
    // Code blocks, tables, and images never split across a page boundary.
    expect(printValue(rules, "[data-region='render'] pre", 'break-inside')).toBe(
      'avoid',
    );
    expect(printValue(rules, "[data-region='render'] table", 'break-inside')).toBe(
      'avoid',
    );
    expect(printValue(rules, "[data-region='render'] img", 'break-inside')).toBe(
      'avoid',
    );
  });

  it('S4: comment highlights are excluded from printed output', async () => {
    const rules = await collectPrintRules();

    // mark[data-anchor] highlight background is neutralized under print.
    const markBg =
      printValue(rules, "[data-region='render'] mark[data-anchor]", 'background') ??
      printValue(rules, "[data-region='render'] mark[data-anchor]", 'background-color') ??
      printValue(rules, "[data-region='render'] mark[data-anchor]", 'display');
    expect(markBg).toBeDefined();
    expect(['none !important', 'transparent !important']).toContain(markBg);

    // The bare `.anchored` wrapper (Android highlight carrier) is likewise
    // neutralized so a shared print path stays clean.
    const anchoredBg =
      printValue(rules, '.anchored', 'background') ??
      printValue(rules, '.anchored', 'background-color') ??
      printValue(rules, '.anchored', 'display');
    expect(anchoredBg).toBeDefined();
    expect(['none !important', 'transparent !important']).toContain(anchoredBg);
  });
});
