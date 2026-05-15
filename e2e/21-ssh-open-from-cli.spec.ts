/**
 * A1: SSH e2e RED spec — CLI ingest of `ssh://` URLs.
 *
 * Two scenarios from `plan.json`'s `e2e.scenarios` array:
 *   - "Open via CLI argv — ssh://host/file.md opens a tab with the same
 *      toolbar as local files"     (wireframe 01)
 *   - "Host key changed — open fails with explicit host-key-verification-
 *      failed error toast"          (wireframe 01)
 *
 * RED-by-design until B5. The expected failure modes for this file are:
 *
 *   1. The import of `./helpers/sshd-fixture.ts` fails because that
 *      helper is created in B4 — the entire spec file refuses to load.
 *      That's the cleanest failure: there's no implementation yet so
 *      there's nothing to drive.
 *
 *   2. Once B4 lands the helper, the spec runs but `__mdviewerE2E.openSshUrl`
 *      is undefined (lands in A11 via the `ssh_open_url` Tauri command
 *      wiring) so `done({ error: 'ssh open hook missing' })` fires.
 *
 *   3. Once A11 lands the hook, the actual ssh transport returns failure
 *      (lands in A3 + A5 + A9) or — for the host-key-mismatch case —
 *      doesn't surface the expected toast (lands in A4 / A12 host-key
 *      check).
 *
 * Each missing layer closes one failure mode. B5 is the first task that
 * flips the suite GREEN. Anyone running `npm run test:e2e` at any task
 * boundary between A1 and B5 will see these specs failing — that is the
 * intended signal, not a regression.
 *
 * Selectors are deliberately mirrored from `e2e/01-open-render.spec.ts`
 * and `e2e/05-edit-reattach.spec.ts` so the "looks like a local tab"
 * assertion is structurally identical: a remote tab must mount the same
 * `[data-region="doc-toolbar"]` with View/Edit toggle, Share, and the
 * font-zoom cluster — exactly like a local file.
 */
import { startSshd, type SshdFixture } from './helpers/sshd-fixture';

const HOST_KEY_OK_PORT = 2222;
const HOST_KEY_CHANGED_PORT = 2223;

/**
 * Drives `ssh://` URL opens through the e2e side-channel. The hook lands
 * in A11 (`__mdviewerE2E.openSshUrl`). Until then `done({ error: ... })`
 * fires and the awaiting promise rejects — that's the RED signal.
 */
async function openSshUrlByE2eHook(url: string): Promise<void> {
  await browser.executeAsync(
    function (sshUrl: string, done: (v: unknown) => void): void {
      const w = window as unknown as {
        __mdviewerE2E?: { openSshUrl?(u: string): Promise<void> };
      };
      if (!w.__mdviewerE2E || !w.__mdviewerE2E.openSshUrl) {
        done({ error: 'ssh open hook missing (A11 not landed)' });
        return;
      }
      w.__mdviewerE2E.openSshUrl(sshUrl).then(
        () => done(null),
        (err: unknown) => done({ error: String(err) }),
      );
    },
    url,
  );
}

describe('CLI ingest of ssh:// URL', () => {
  let fixture: SshdFixture;

  before(async () => {
    // B4 helper. Spawns a local sshd against the fixture keypair in
    // `src-tauri/tests/fixtures/ssh/` and seeds a writable `fixture.md`
    // in the returned tmpDir so save-back specs (23) can mutate it.
    // The host-key-changed port (2223) and the auth-failure port (2224)
    // come from A12 — the fixture helper exposes them as named ports.
    fixture = await startSshd();
  });

  after(async () => {
    await fixture.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: Open via CLI argv
  // wireframe: 01-startpage-open-from-remote.html
  // ──────────────────────────────────────────────────────────────────────
  it('opens a tab whose toolbar is structurally identical to a local tab', async () => {
    const url = `ssh://localhost:${HOST_KEY_OK_PORT}/${fixture.tmpDir}/fixture.md`;
    await openSshUrlByE2eHook(url);

    // The document view must mount, just like a local-file open.
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 12_000, timeoutMsg: 'document view never mounted after ssh:// open' },
    );

    // "Looks like a local tab" — identical toolbar surface as 01-open-render.
    const toolbar = browser.$('[data-region="doc-toolbar"]');
    expect(await toolbar.isExisting()).toBe(true);

    // View/Edit toggle (selector matches 05-edit-reattach.spec.ts:20).
    const toggle = toolbar.$('[data-action="toggle-edit"]');
    expect(await toggle.isExisting()).toBe(true);
    expect(await toggle.isEnabled()).toBe(true);

    // Share button (08-share-export.spec.ts:28).
    const share = toolbar.$('[data-action="share"]');
    expect(await share.isExisting()).toBe(true);
    expect(await share.isEnabled()).toBe(true);

    // Font-zoom cluster (15-font-size.spec.ts:570).
    const decrease = toolbar.$('[data-action="font-decrease"]');
    const reset = toolbar.$('[data-action="font-reset"]');
    const increase = toolbar.$('[data-action="font-increase"]');
    expect(await decrease.isExisting()).toBe(true);
    expect(await reset.isExisting()).toBe(true);
    expect(await increase.isExisting()).toBe(true);

    // Comments sidebar mounted in the right rail. The plan's done_when
    // for this scenario calls out `[data-testid="comments-sidebar"]` —
    // see plan.e2e.scenarios. (The existing local-tab sidebar uses
    // `[data-view="sidebar-comments"]`; the new selector is the
    // remote-tab-aware testid the implementation must surface.)
    const sidebar = browser.$('[data-testid="comments-sidebar"]');
    expect(await sidebar.isExisting()).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: Host key changed
  // wireframe: 01-startpage-open-from-remote.html
  // ──────────────────────────────────────────────────────────────────────
  it('refuses to open and surfaces a host-key-verification-failed toast when the remote key has changed', async () => {
    const url = `ssh://localhost:${HOST_KEY_CHANGED_PORT}/${fixture.tmpDir}/fixture.md`;

    // The open must reject — but the spec doesn't assert on the rejection
    // shape because the toast IS the user-visible contract. We swallow
    // the rejection here so the assertions below can run.
    await openSshUrlByE2eHook(url).catch(() => undefined);

    // Inverse assertion: the document view must NOT mount.
    // Brief settle so any racing mount has a chance to surface (we want
    // a true "never mounted", not a "didn't mount yet").
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await browser.$('[data-view="document"]').isExisting()).toBe(false);

    // Toast must surface with the verbatim prefix. The toast text comes
    // from the russh / openssh diagnostic — A4 specifies it must include
    // 'host key verification failed' (case-insensitive substring).
    await browser.waitUntil(
      async () => {
        const text = await browser
          .$('[data-region="toast"]')
          .getText()
          .catch(() => '');
        return /host key verification failed/i.test(text);
      },
      {
        timeout: 8_000,
        timeoutMsg: 'host-key-verification-failed toast never appeared',
      },
    );
  });
});
