/**
 * A1: SSH e2e RED spec — Conflict + Askpass.
 *
 * Three scenarios from `plan.json`'s `e2e.scenarios` array:
 *   - "Conflict on save — out-of-band remote change triggers the existing
 *      conflict modal with SshHashMismatch source"  (wireframe 01)
 *   - "Askpass prompt — empty ssh-agent surfaces the passphrase modal and
 *      the open proceeds on submit"                  (wireframe 03)
 *   - "Askpass cancel — Cancel terminates ssh and the open fails with a
 *      clean 'auth cancelled' error"                 (wireframe 03)
 *
 * RED-by-design until B5. Expected failure modes:
 *
 *   1. Imports of `./helpers/sshd-fixture.ts` and
 *      `./helpers/independentSshWrite.ts` fail — both land in B4.
 *   2. Once those land, the `ssh_open_url` hook is missing (A11) so the
 *      open promise rejects before we can even attempt a conflict.
 *   3. Once A11 lands, the Conflict modal doesn't gain the
 *      `SshHashMismatch` source variant — lands in A8.
 *   4. Askpass scenarios additionally need the Unix askpass socket +
 *      AskpassModal — lands in A6 + A11.
 *
 * The passphrase port (2225) is the same sshd seeded with a key that
 * REQUIRES a passphrase (A12 provisions it). The known passphrase is
 * exposed by the fixture helper as `fixture.passphrasedKey.passphrase`.
 */
import { startSshd, type SshdFixture } from './helpers/sshd-fixture';
import { independentSshWrite } from './helpers/independentSshWrite';

const HOST_KEY_OK_PORT = 2222;
const PASSPHRASE_PORT = 2225;
const MARKER = 'WDIO conflict marker';
const REMOTE_OUT_OF_BAND = 'rewritten by an out-of-band peer\n';

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

describe('Conflict on save', () => {
  let fixture: SshdFixture;

  before(async () => {
    fixture = await startSshd();
  });

  after(async () => {
    await fixture.cleanup();
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: surfaces Conflict modal when remote bytes diverge
  // wireframe: 01-startpage-open-from-remote.html
  // ──────────────────────────────────────────────────────────────────────
  it('surfaces the Conflict modal when remote bytes diverge', async () => {
    const remotePath = `${fixture.tmpDir}/fixture.md`;
    const url = `ssh://localhost:${HOST_KEY_OK_PORT}${remotePath}`;

    await openSshUrlByE2eHook(url);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 12_000, timeoutMsg: 'document view never mounted after ssh:// open' },
    );

    // Edit locally first — the dirty marker pre-empts the save path.
    await browser.$('[data-action="toggle-edit"]').click();
    await browser.waitUntil(
      async () => browser.$('[data-test="editor"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'editor never mounted' },
    );
    await browser.execute((marker: string) => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-test="editor"]');
      if (!ta) throw new Error('editor missing');
      ta.value = `${ta.value}\n\n${marker}\n`;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, MARKER);

    // Mutate the remote out-of-band via an independent SSH client.
    // This rewrites fixture.md on the server so the pre-save SHA-256
    // probe (A5 `operations::save_back`) sees a mismatch.
    await independentSshWrite({
      host: 'localhost',
      port: HOST_KEY_OK_PORT,
      user: 'tester',
      identityFile: fixture.identityFile,
      remotePath,
      contents: REMOTE_OUT_OF_BAND,
    });

    // Trigger the save — the production path.
    await browser.execute(() => {
      document.dispatchEvent(new CustomEvent('mdviewer:save-document'));
    });

    // Conflict modal must render with both versions visible and source
    // = SshHashMismatch (lands in A8 — `ConflictSource` gains the new
    // variant and the wire arm at `workspace.rs:1308`).
    await browser.waitUntil(
      async () => browser.$('[data-view="conflict"]').isExisting(),
      { timeout: 12_000, timeoutMsg: 'conflict modal never appeared after diverged save' },
    );
    const modal = browser.$('[data-view="conflict"]');
    expect(
      await modal.$('[data-conflict-source="SshHashMismatch"]').isExisting(),
    ).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: Askpass prompt proceeds on submit
  // wireframe: 03-askpass-modal.html
  // ──────────────────────────────────────────────────────────────────────
  it('shows the Askpass modal when ssh-agent is empty and proceeds on submit', async () => {
    const remotePath = `${fixture.tmpDir}/fixture.md`;
    const url = `ssh://localhost:${PASSPHRASE_PORT}${remotePath}`;

    // Kick off the open. The promise won't resolve until the askpass
    // round-trip completes — we drive the modal in parallel.
    const openPromise = openSshUrlByE2eHook(url).catch(() => undefined);

    // Wireframe-03 askpass modal must mount.
    const askpass = browser.$('[data-testid="askpass-modal"]');
    await browser.waitUntil(async () => askpass.isExisting(), {
      timeout: 12_000,
      timeoutMsg: 'askpass modal never appeared on passphrase-port open',
    });
    expect(await askpass.getAttribute('data-kind')).toBe('passphrase');

    // Fill the passphrase field — fixture exposes the known passphrase.
    await askpass.$('input[type="password"]').setValue(fixture.passphrasedKey.passphrase);
    await askpass.$('[data-action="submit"]').click();

    // Modal dismisses; the document tab opens.
    await browser.waitUntil(async () => !(await askpass.isExisting()), {
      timeout: 8_000,
      timeoutMsg: 'askpass modal never dismissed after submit',
    });
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 12_000, timeoutMsg: 'document view never mounted after askpass submit' },
    );

    await openPromise;
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scenario: Askpass cancel fails open with a clean error
  // wireframe: 03-askpass-modal.html
  // ──────────────────────────────────────────────────────────────────────
  it('fails open with a clean error when Askpass is cancelled', async () => {
    const remotePath = `${fixture.tmpDir}/fixture.md`;
    const url = `ssh://localhost:${PASSPHRASE_PORT}${remotePath}`;

    const openPromise = openSshUrlByE2eHook(url).catch(() => undefined);

    const askpass = browser.$('[data-testid="askpass-modal"]');
    await browser.waitUntil(async () => askpass.isExisting(), {
      timeout: 12_000,
      timeoutMsg: 'askpass modal never appeared',
    });

    // Click Cancel. The askpass helper bin exits non-zero, ssh
    // terminates, the open promise rejects with an "auth cancelled"
    // shaped error that surfaces as a toast.
    await askpass.$('[data-action="cancel"]').click();

    await browser.waitUntil(async () => !(await askpass.isExisting()), {
      timeout: 8_000,
      timeoutMsg: 'askpass modal never dismissed after cancel',
    });

    // Toast carries 'auth cancelled'. The toast region is the same
    // surface 21-ssh-open-from-cli's host-key-changed scenario asserts.
    await browser.waitUntil(
      async () => {
        const text = await browser
          .$('[data-region="toast"]')
          .getText()
          .catch(() => '');
        return /auth cancelled/i.test(text);
      },
      { timeout: 8_000, timeoutMsg: '"auth cancelled" toast never appeared' },
    );

    // And the document view stayed unmounted.
    expect(await browser.$('[data-view="document"]').isExisting()).toBe(false);

    await openPromise;
  });
});
