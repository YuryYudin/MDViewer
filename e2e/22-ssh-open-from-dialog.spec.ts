/**
 * A1: SSH e2e RED spec — Open Remote dialog flow.
 *
 * Two scenarios from `plan.json`'s `e2e.scenarios` array:
 *   - "Open via Remote Dialog — host entry, directory browse, file pick
 *      lands a tab"                              (wireframe 02)
 *   - "Auth failure on connect — verbatim ssh stderr renders in dialog
 *      state C"                                  (wireframe 02)
 *
 * RED-by-design until B5. Expected failure modes are layered:
 *
 *   1. The import of `./helpers/sshd-fixture.ts` fails — the helper
 *      lands in B4.
 *   2. Once B4 lands, the `[data-testid="open-from-remote-button"]`
 *      on StartPage doesn't exist — it lands in B2.
 *   3. Once B2 lands the button, the dialog states A/B/C and the
 *      ssh_list_dir backing IPC don't exist — they land in B1 + B2.
 *   4. Once the UI is wired, the `auth-failure` port (2224 from the
 *      A12 fixture) needs the actual ssh stderr surfacing — lands
 *      in A3 + A5.
 *
 * Selectors match wireframe 02 (`data-testid="open-remote-dialog"`,
 * `data-state="host-entry" | "browsing" | "error"`, action attrs
 * `connect` / `cancel` / `open`, and `data-testid="remote-file-list"`).
 */
import { startSshd, type SshdFixture } from './helpers/sshd-fixture';

const HOST_KEY_OK_PORT = 2222;
const AUTH_FAIL_PORT = 2224;

describe('Open Remote dialog flow', () => {
  let fixture: SshdFixture;

  before(async () => {
    fixture = await startSshd();
  });

  after(async () => {
    await fixture.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: host entry → directory browse → file pick lands a tab
  // wireframe: 02-open-remote-dialog.html
  // ──────────────────────────────────────────────────────────────────────
  it('opens a tab via host entry → directory browse → file pick', async () => {
    // Start at StartPage.
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);

    // The "Open from remote…" button is the new StartPage entry point
    // (wireframe 01). It lands in B2.
    const openRemoteBtn = browser.$('[data-testid="open-from-remote-button"]');
    expect(await openRemoteBtn.isExisting()).toBe(true);
    await openRemoteBtn.click();

    // Wireframe 02 state A: host-entry.
    const dialog = browser.$('[data-testid="open-remote-dialog"]');
    await browser.waitUntil(async () => dialog.isExisting(), {
      timeout: 5_000,
      timeoutMsg: 'open-remote-dialog never mounted',
    });
    expect(await dialog.getAttribute('data-state')).toBe('host-entry');

    // Fill the host field with user@host:port. The user account "tester"
    // is provisioned by the A12 fixture (authorized_keys → id_test pubkey).
    const hostInput = dialog.$('input#host');
    await hostInput.setValue(`tester@localhost:${HOST_KEY_OK_PORT}`);
    await dialog.$('[data-action="connect"]').click();

    // Wireframe 02 state B: directory browse. The breadcrumb + file list
    // must surface; fixture.md is the seeded markdown the helper drops
    // into the tmp home dir.
    await browser.waitUntil(
      async () => (await dialog.getAttribute('data-state')) === 'browsing',
      { timeout: 12_000, timeoutMsg: 'dialog never reached the browsing state' },
    );
    const fileList = dialog.$('[data-testid="remote-file-list"]');
    expect(await fileList.isExisting()).toBe(true);

    // The seeded fixture.md row must be present and "openable" (i.e. md).
    await browser.waitUntil(
      async () => {
        const rows = await fileList.$$('.file-row');
        for (const row of rows) {
          const nameEl = row.$('.name');
          if (!(await nameEl.isExisting())) continue;
          const name = await nameEl.getText();
          if (name === 'fixture.md') return true;
        }
        return false;
      },
      { timeout: 8_000, timeoutMsg: 'fixture.md never appeared in the remote file list' },
    );

    // Double-click descend / open. Per wireframe annotation:
    // "double-click a .md opens immediately".
    const target = await browser.execute(() => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="remote-file-list"] .file-row',
        ),
      );
      const match = rows.find((r) => r.querySelector('.name')?.textContent === 'fixture.md');
      if (!match) throw new Error('fixture.md row missing at click time');
      const evt = new MouseEvent('dblclick', { bubbles: true });
      match.dispatchEvent(evt);
      return true;
    });
    expect(target).toBe(true);

    // The dialog dismisses and a document tab opens.
    await browser.waitUntil(
      async () => !(await dialog.isExisting()),
      { timeout: 8_000, timeoutMsg: 'open-remote-dialog never dismissed after pick' },
    );
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 12_000, timeoutMsg: 'document view never mounted after remote pick' },
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: verbatim ssh stderr on auth failure
  // wireframe: 02-open-remote-dialog.html state C
  // ──────────────────────────────────────────────────────────────────────
  it('shows verbatim ssh stderr on auth failure', async () => {
    expect(await browser.$('[data-view="start"]').isExisting()).toBe(true);

    const openRemoteBtn = browser.$('[data-testid="open-from-remote-button"]');
    expect(await openRemoteBtn.isExisting()).toBe(true);
    await openRemoteBtn.click();

    const dialog = browser.$('[data-testid="open-remote-dialog"]');
    await browser.waitUntil(async () => dialog.isExisting(), {
      timeout: 5_000,
      timeoutMsg: 'open-remote-dialog never mounted',
    });

    // The auth-fail fixture port is the same sshd with the test key NOT
    // present in `authorized_keys`. A12 provisions it as port 2224.
    await dialog.$('input#host').setValue(`unauthorized@localhost:${AUTH_FAIL_PORT}`);
    await dialog.$('[data-action="connect"]').click();

    // State C: error.
    await browser.waitUntil(
      async () => (await dialog.getAttribute('data-state')) === 'error',
      { timeout: 12_000, timeoutMsg: 'dialog never reached the error state' },
    );

    // Verbatim ssh stderr — the literal substring openssh emits when key
    // auth is refused. The transport's contract (A3) is "captures stderr
    // verbatim, returns it on non-zero exit", so the surface text must
    // include this string unmodified.
    const errorText = await dialog.$('.error').getText();
    expect(errorText).toContain('Permission denied');
  });
});
