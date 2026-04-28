import { prepareFixture } from './helpers/app';

describe('First-run profile setup', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ resetProfile: true });
  });
  after(async () => { await fixture.cleanup(); });

  it('prompts for name + color on first run and persists the profile', async () => {
    // wireframes/02-profile-setup.html: profile dialog shown on a profileless launch.
    await expect(browser.$('[data-view="profile-setup"]')).toBeDisplayed();

    await browser.$('[data-test="profile-name"]').setValue('Carol');
    await browser.$('[data-test="profile-color"]').setValue('#00aa88');
    await browser.$('[data-action="save-profile"]').click();

    // After save, the status bar shows the chosen name.
    await expect(browser.$('[data-view="status-bar"] [data-test="user-name"]'))
      .toHaveText('Carol');
  });
});
