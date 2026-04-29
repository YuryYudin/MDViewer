import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('First-run profile setup', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  let originalSettings: string | null = null;
  const settingsPath = path.join(process.env.MDVIEWER_DATA_DIR ?? '', 'settings.toml');

  before(async () => {
    fixture = await prepareFixture({ resetProfile: true });
    // wdio.conf.ts pre-seeds settings.toml with display_name set so most
    // specs boot into Workspace. This spec exercises the first-run flow,
    // so blank the display_name back out and reload the WebDriver session
    // — that drops the running app and tauri-wd respawns with the modified
    // settings.toml. browser.refresh() alone wouldn't help because the
    // backend Settings store is read once at app launch.
    if (process.env.MDVIEWER_DATA_DIR) {
      originalSettings = await fs.readFile(settingsPath, 'utf8');
      await fs.writeFile(
        settingsPath,
        originalSettings.replace(/display_name = ".*"/, 'display_name = ""'),
      );
      await browser.reloadSession();
    }
  });
  after(async () => {
    // Restore so subsequent specs in the same run see a profile-having
    // settings.toml (and thus boot into Workspace).
    if (originalSettings) {
      await fs.writeFile(settingsPath, originalSettings);
    }
    await fixture.cleanup();
  });

  it('prompts for name + color on first run and persists the profile', async () => {
    // wireframes/02-profile-setup.html: profile dialog shown on a profileless launch.
    await browser.waitUntil(
      async () => browser.$('[data-view="profile-setup"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'profile setup view did not mount' },
    );

    await browser.$('[data-test="profile-name"]').setValue('Carol');
    await browser.$('[data-test="profile-color"]').setValue('#00aa88');
    await browser.$('[data-action="save-profile"]').click();

    // After save, main.ts mounts Workspace; the status bar's chip shows
    // the chosen name.
    await browser.waitUntil(
      async () => {
        const el = browser.$('[data-view="status-bar"] [data-test="user-name"]');
        if (!(await el.isExisting())) return false;
        return (await el.getText()) === 'Carol';
      },
      { timeout: 5_000, timeoutMsg: 'status-bar did not show "Carol" after save' },
    );
  });
});
