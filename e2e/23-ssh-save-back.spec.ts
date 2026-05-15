/**
 * A1: SSH e2e RED spec — Save-back to remote.
 *
 * One scenario from `plan.json`'s `e2e.scenarios` array:
 *   - "Save-back — saving a remote tab uploads the bytes to the remote
 *      host"                                     (wireframe 01)
 *
 * RED-by-design until B5. Expected failure modes:
 *
 *   1. Imports of `./helpers/sshd-fixture.ts` and
 *      `./helpers/independentSshRead.ts` fail — both land in B4.
 *   2. Once those land, `__mdviewerE2E.openSshUrl` is undefined (A11).
 *   3. Once A11 lands, the actual save_back over the transport is a
 *      no-op (A5).
 *
 * The end-to-end shape is:
 *   - Open the URL via the CLI path (e2e hook drives `ssh_open_url`).
 *   - Toggle into Edit mode using the same `[data-action="toggle-edit"]`
 *     button local-file tabs surface (asserted by 21-ssh-open-from-cli).
 *   - Mutate the textarea contents (same direct DOM write as
 *     05-edit-reattach.spec.ts — wdio setValue is unreliable inside
 *     WKWebView).
 *   - Dispatch `mdviewer:save-document` to drive the production save
 *     path (same CustomEvent the keymap binds to — see
 *     19-drive-comments.spec.ts:282).
 *   - Read the remote file out-of-band via an independent SSH client
 *     to confirm the bytes really landed on the server.
 */
import { startSshd, type SshdFixture } from './helpers/sshd-fixture';
import { independentSshRead } from './helpers/independentSshRead';

const HOST_KEY_OK_PORT = 2222;
const MARKER = 'WDIO marker';

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

describe('Save-back to remote', () => {
  let fixture: SshdFixture;

  before(async () => {
    fixture = await startSshd();
  });

  after(async () => {
    await fixture.cleanup();
  });

  it('persists local edits back to the remote host', async () => {
    const remotePath = `${fixture.tmpDir}/fixture.md`;
    const url = `ssh://localhost:${HOST_KEY_OK_PORT}${remotePath}`;

    // 1. Open the URL via the CLI path.
    await openSshUrlByE2eHook(url);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 12_000, timeoutMsg: 'document view never mounted after ssh:// open' },
    );

    // 2. Switch into Edit mode — same toggle that local tabs use.
    await browser.$('[data-action="toggle-edit"]').click();
    await browser.waitUntil(
      async () => browser.$('[data-test="editor"]').isExisting(),
      { timeout: 5_000, timeoutMsg: 'editor never mounted after toggle-edit' },
    );

    // 3. Insert the marker at the end of the buffer. Direct DOM write
    //    is the same workaround 05-edit-reattach uses.
    const inserted = await browser.execute((marker: string) => {
      const ta = document.querySelector<HTMLTextAreaElement>('[data-test="editor"]');
      if (!ta) throw new Error('editor missing');
      ta.value = `${ta.value}\n\n${marker}\n`;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    }, MARKER);
    expect(inserted).toContain(MARKER);

    // 4. Trigger save via the production save path — same CustomEvent
    //    the menu / keymap dispatch.
    await browser.execute(() => {
      document.dispatchEvent(new CustomEvent('mdviewer:save-document'));
    });

    // 5. Tab returns to a clean state (dirty indicator gone). The tab's
    //    dirty flag surfaces as a data attribute on the active tab; we
    //    accept either no `data-dirty` attribute or `data-dirty="false"`.
    await browser.waitUntil(
      async () => {
        const dirty = await browser.execute(() => {
          const active =
            document.querySelector('[data-region="tabbar"] [data-active="true"]') ??
            document.querySelector('.tab-active');
          if (!active) return null;
          return active.getAttribute('data-dirty');
        });
        return dirty === null || dirty === 'false';
      },
      { timeout: 12_000, timeoutMsg: 'dirty indicator never cleared after save' },
    );

    // 6+7. Independent SSH read confirms the bytes really landed on the
    //      remote. The helper bypasses our app entirely — it shells out
    //      to a plain `ssh` + `cat` so we're not asserting on our own
    //      writer to validate our own writer.
    const remoteBytes = await independentSshRead({
      host: 'localhost',
      port: HOST_KEY_OK_PORT,
      user: 'tester',
      identityFile: fixture.identityFile,
      remotePath,
    });
    expect(remoteBytes).toContain(MARKER);
  });
});
