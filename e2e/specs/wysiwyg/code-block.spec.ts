import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook } from '../../helpers/app';

/**
 * Phase-1 WYSIWYG acceptance: fenced-code & mermaid block widgets.
 *
 *  (a) A `python` fenced block collapses to its raw source on caret-in
 *      (wireframes 04 -> 05) and re-renders on caret-out.
 *  (b) A `mermaid` fenced block renders as a mermaid widget, and
 *      clicking the `✎ Raw` pencil drops to raw source.
 *
 * RED until A.6 (blocks decoration extension) lands. The block widgets
 * carry the [data-testid="code-widget"] / [data-testid="mermaid-widget"]
 * / [data-testid="code-widget-raw"] testids per the wireframes.
 */
describe('WYSIWYG: code-block & mermaid widgets render and collapse to raw', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
    await fs.rm(path.join(fixture.tmpDir, 'sample.md.comments.json'), { force: true });

    // Augment the sample.md with both a python fence AND a mermaid fence
    // so we can exercise both widget paths from one document open.
    const augmented = [
      '# Sample Document',
      '',
      'A short paragraph that contains **bold** and *italic* text.',
      '',
      '## Code',
      '',
      '```python',
      'def consume(tenant: str) -> bool:',
      '    return True',
      '```',
      '',
      '## Diagram',
      '',
      '```mermaid',
      'graph LR',
      '  A --> B',
      '```',
      '',
    ].join('\n');
    await fs.writeFile(path.join(fixture.tmpDir, 'sample.md'), augmented, 'utf8');
  });
  after(async () => { await fixture.cleanup(); });

  it('python fenced block collapses on caret-in and re-renders on caret-out', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    const source = await fs.readFile(target, 'utf8');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-testid="live-editor"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    // (a) Caret-out: the python block renders as an atomic widget.
    const codeWidget = browser.$('[data-testid="code-widget"][data-lang="python"]');
    await browser.waitUntil(
      async () => codeWidget.isExisting(),
      { timeout: 5_000, timeoutMsg: 'python code-widget never rendered' },
    );

    // Drop the caret inside the fence by setting the live-editor
    // selection at an offset between ```python and the closing ```.
    const fenceStart = source.indexOf('```python');
    const innerOffset = source.indexOf('def consume', fenceStart);
    expect(innerOffset).toBeGreaterThan(0);
    await browser.executeAsync(
      function (off: number, done: (v: unknown) => void): void {
        const w = window as unknown as {
          __mdviewerE2E?: { setLiveEditorSelection?: (s: number, e: number) => Promise<void> };
        };
        if (!w.__mdviewerE2E?.setLiveEditorSelection) {
          done({ error: 'setLiveEditorSelection hook missing' });
          return;
        }
        w.__mdviewerE2E
          .setLiveEditorSelection(off, off)
          .then(() => done(null), (e) => done({ error: String(e) }));
      },
      innerOffset,
    );

    // Now the rendered widget is replaced by [data-testid="code-widget-raw"]
    // showing the raw fence text (opener + code + closer).
    await browser.waitUntil(
      async () => browser.$('[data-testid="code-widget-raw"][data-lang="python"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'code widget never collapsed to raw on caret-in' },
    );
    expect(await codeWidget.isExisting()).toBe(false);
    const rawBody = await browser
      .$('[data-testid="code-widget-raw"][data-lang="python"]')
      .getText();
    // Raw view includes the fence openers AND the closer.
    expect(rawBody).toContain('```python');
    expect(rawBody).toContain('def consume');
    expect(rawBody).toContain('```');

    // Move the caret out (into the heading "## Diagram") — widget must
    // re-render to the rendered code widget.
    const outsideOffset = source.indexOf('## Diagram');
    expect(outsideOffset).toBeGreaterThan(0);
    await browser.executeAsync(
      function (off: number, done: (v: unknown) => void): void {
        const w = window as unknown as {
          __mdviewerE2E?: { setLiveEditorSelection?: (s: number, e: number) => Promise<void> };
        };
        w.__mdviewerE2E!.setLiveEditorSelection!(off, off).then(
          () => done(null),
          (e) => done({ error: String(e) }),
        );
      },
      outsideOffset,
    );
    await browser.waitUntil(
      async () => browser.$('[data-testid="code-widget"][data-lang="python"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'code widget never re-rendered on caret-out' },
    );
  });

  it('mermaid block renders as a widget and ✎ Raw collapses to raw source', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-testid="live-editor"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'live-editor surface never mounted' },
    );

    const mermaidWidget = browser.$('[data-testid="mermaid-widget"]');
    await browser.waitUntil(
      async () => mermaidWidget.isExisting(),
      { timeout: 10_000, timeoutMsg: 'mermaid widget never rendered' },
    );
    // Mermaid library replaces the inner source with an <svg> — assert
    // an SVG actually rendered inside the widget.
    const svgCount = await browser.execute(() => {
      const w = document.querySelector('[data-testid="mermaid-widget"]');
      return w ? w.querySelectorAll('svg').length : -1;
    });
    expect(svgCount).toBeGreaterThan(0);

    // Click the ✎ Raw pencil. The widget collapses to the same raw fence
    // shape as the code-widget-raw view.
    const pencil = mermaidWidget.$('button[data-action="raw-edit"]');
    expect(await pencil.isExisting()).toBe(true);
    await pencil.click();

    // After Raw pencil: the widget is replaced by a raw fence view
    // ([data-testid="code-widget-raw"][data-lang="mermaid"] per the
    // wireframe-05 pattern).
    await browser.waitUntil(
      async () => browser.$('[data-testid="code-widget-raw"][data-lang="mermaid"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'mermaid widget never collapsed to raw on ✎ Raw click' },
    );
    const rawBody = await browser
      .$('[data-testid="code-widget-raw"][data-lang="mermaid"]')
      .getText();
    expect(rawBody).toContain('```mermaid');
    expect(rawBody).toContain('graph LR');
  });
});
