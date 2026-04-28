import { prepareFixture } from './helpers/app';

describe('Settings changes take effect immediately', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: 'e2e/fixtures' });
  });
  after(async () => { await fixture.cleanup(); });

  it('applies dark theme + reattachment confidence 80 without a restart', async () => {
    await browser.$('[data-action="open-settings"]').click();
    await expect(browser.$('[data-view="settings"]')).toBeDisplayed();

    await browser.$('[data-test="theme-select"]').selectByAttribute('value', 'dark');
    await browser.$('[data-test="reattach-confidence"]').setValue('80');
    await browser.$('[data-action="close-settings"]').click();

    // Theme applied via class on <body>.
    await expect(browser.$('body')).toHaveElementClass('theme-dark');

    // The Tauri command get_settings reflects the new value.
    const settings = await browser.execute(async () => {
      const { invoke } = (window as unknown as {
        __TAURI__: { core: { invoke: (name: string) => Promise<unknown> } };
      }).__TAURI__.core;
      return invoke('get_settings');
    });
    await expect((settings as { reattachment_confidence: number }).reattachment_confidence)
      .toBe(80);
  });
});
