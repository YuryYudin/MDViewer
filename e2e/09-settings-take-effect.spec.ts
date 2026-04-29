import { prepareFixture } from './helpers/app';

describe('Settings changes take effect immediately', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: 'e2e/fixtures' });
  });
  after(async () => { await fixture.cleanup(); });

  it('applies dark theme + reattachment confidence 80 without a restart', async () => {
    // Trigger the settings overlay via the open-settings event
    // (StartPage's button dispatches this; the keymap binds to it too).
    await browser.execute(() =>
      document.dispatchEvent(new CustomEvent('mdviewer:open-settings')),
    );
    await browser.waitUntil(
      async () => browser.$('[data-view="settings"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'settings did not mount' },
    );

    // Set the select value via direct DOM and dispatch `change` — the
    // plugin's send-keys-style selectByAttribute doesn't always trigger
    // the change event Settings.ts listens on.
    await browser.execute(() => {
      const sel = document.querySelector<HTMLSelectElement>('[data-test="theme-select"]');
      if (!sel) throw new Error('theme-select missing');
      sel.value = 'dark';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Direct DOM set + input dispatch — same dance as spec 05; setValue
    // through the plugin's send-keys can be flaky on numeric inputs.
    await browser.execute(() => {
      const inp = document.querySelector<HTMLInputElement>(
        '[data-test="reattachment-confidence"]',
      );
      if (!inp) throw new Error('reattachment-confidence input missing');
      inp.value = '80';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Wait for the debounced setSettings round-trip to land on disk.
    await new Promise((r) => setTimeout(r, 500));

    await browser.$('[data-action="close-settings"]').click();

    // Theme applied via class on <body>.
    await browser.waitUntil(
      async () =>
        ((await browser.$('body').getAttribute('class')) ?? '').includes('theme-dark'),
      { timeout: 5_000, timeoutMsg: 'body did not gain theme-dark class' },
    );

    // Verify persisted: re-open settings and read the field back. We use
    // the rendered DOM rather than __TAURI__.core.invoke because the
    // plugin doesn't expose the core-API surface and the e2e hook above
    // only knows how to open documents.
    await browser.execute(() =>
      document.dispatchEvent(new CustomEvent('mdviewer:open-settings')),
    );
    await browser.waitUntil(
      async () => browser.$('[data-view="settings"]').isExisting(),
      { timeout: 5_000 },
    );
    const persisted = await browser
      .$('[data-test="reattachment-confidence"]')
      .getValue();
    expect(persisted).toBe('80');
  });
});
