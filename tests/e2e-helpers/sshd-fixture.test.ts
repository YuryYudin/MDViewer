/**
 * Unit tests for the WDIO sshd test fixture helper (B4).
 *
 * The helper's *main* job — actually spawning `/usr/sbin/sshd` — can only
 * be exercised end-to-end by the WDIO suite on macOS (per the existing
 * `wdio.conf.ts` policy). These tests cover the pure-logic surfaces:
 *
 *   - Windows rejection error shape.
 *   - sshd_config template substitution (single source of truth for
 *     `__PORT__` / `__HOST_KEY__` / `__AUTHKEYS__` / `__PIDFILE__`).
 *   - `independentSshRead` / `independentSshWrite` shell-out argv shape:
 *     critical so the helpers bypass our app's transport when verifying
 *     save-back / simulating out-of-band conflict in specs 23 + 24.
 *
 * The spawn step itself is tested indirectly by the WDIO suite (B5).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const fixtureRoot = path.join(repoRoot, 'src-tauri/tests/fixtures/ssh');

describe('sshd-fixture: platform gating', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    // Restore process.platform after every test so other test files in
    // the run (e.g. tests/views/StartPage.test.ts which depend on the
    // real platform for dialog-vs-E2E-mode dispatch) don't inherit a
    // mutated global. Mocha/Vitest run files in parallel workers but
    // share module state per file, and `Object.defineProperty` on
    // process.platform persists across `describe` blocks otherwise.
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.resetModules();
  });

  it('throws a clear skip-style error on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.resetModules();
    const { startSshd } = await import('../../e2e/helpers/sshd-fixture');
    await expect(startSshd()).rejects.toThrow(/Windows/);
    await expect(startSshd()).rejects.toThrow(/Rust integration tests/);
  });
});

describe('sshd-fixture: config template rendering', () => {
  let lastTmpDir: string | undefined;

  afterEach(() => {
    if (lastTmpDir && existsSync(lastTmpDir)) {
      rmSync(lastTmpDir, { recursive: true, force: true });
    }
    lastTmpDir = undefined;
    vi.resetModules();
  });

  it('substitutes every placeholder token from the committed template', async () => {
    if (process.platform === 'win32') return; // Windows path rejects early.
    const { renderSshdConfig } = await import('../../e2e/helpers/sshd-fixture');
    const out = renderSshdConfig({
      port: 31415,
      hostKey: '/abs/host_key',
      authorizedKeys: '/abs/authorized_keys',
      pidfile: '/abs/sshd.pid',
    });
    expect(out).toMatch(/^Port 31415$/m);
    expect(out).toMatch(/^HostKey \/abs\/host_key$/m);
    expect(out).toMatch(/^AuthorizedKeysFile \/abs\/authorized_keys$/m);
    expect(out).toMatch(/^PidFile \/abs\/sshd\.pid$/m);
    // Sanity: every templated token has been replaced — no `__X__` left.
    expect(out).not.toMatch(/__[A-Z_]+__/);
  });

  it('reads the canonical template from src-tauri/tests/fixtures/ssh', async () => {
    if (process.platform === 'win32') return;
    const { renderSshdConfig } = await import('../../e2e/helpers/sshd-fixture');
    // Sanity-check that the template file exists at the documented path —
    // failure here means somebody moved the fixture without updating the
    // helper, which would make both Rust + WDIO suites stale.
    const tmplPath = path.join(fixtureRoot, 'sshd_config.template');
    expect(existsSync(tmplPath)).toBe(true);
    const raw = readFileSync(tmplPath, 'utf8');
    expect(raw).toContain('__PORT__');
    expect(raw).toContain('__HOST_KEY__');
    expect(raw).toContain('__AUTHKEYS__');
    expect(raw).toContain('__PIDFILE__');
    // And the render fn produces output the template can sensibly accept.
    const out = renderSshdConfig({
      port: 22,
      hostKey: '/h',
      authorizedKeys: '/a',
      pidfile: '/p',
    });
    expect(out).toContain('ListenAddress 127.0.0.1');
  });
});

import type { SshdFixture } from '../../e2e/helpers/sshd-fixture';

describe('sshd-fixture: SshdFixture shape', () => {
  it('SshdFixture type matches what A1 specs destructure', () => {
    // Type-level shape check — the immutable A1 spec files (21/22/23/24)
    // destructure `port`, `tmpDir`, `cleanup`, `identityFile`, and
    // `passphrasedKey.{passphrase,identityFile}`. The `satisfies` clause
    // below fails to compile if the interface regresses, which is a
    // strictly stronger guarantee than the previous source-text regex
    // check: tsc enforces both shape AND types, whereas regex was
    // happy with stale `// port: ...` comments etc.
    const _shape = {
      port: 22,
      tmpDir: '/tmp/x',
      identityFile: '/tmp/key',
      passphrasedKey: { identityFile: '/tmp/k', passphrase: 'p' },
      cleanup: async () => {},
    } satisfies SshdFixture;
    // Runtime: keep one no-op assertion to anchor the test name.
    expect(_shape.port).toBe(22);
  });
});

describe('independentSshRead / Write: argv composition', () => {
  // We don't actually want to spawn ssh in vitest — but we DO want to
  // pin the argv shape so future edits don't accidentally drop e.g.
  // `StrictHostKeyChecking=no`, which would make tests prompt the dev
  // for known_hosts confirmation and hang forever in CI.

  it('independentSshRead composes ssh argv with IdentitiesOnly + StrictHostKeyChecking=no', async () => {
    const mod = await import('../../e2e/helpers/independentSshRead');
    const argv = mod.composeSshReadArgs({
      port: 12345,
      user: 'tester',
      host: '127.0.0.1',
      identityFile: '/abs/id_test',
      remotePath: '/srv/fixture.md',
    });
    expect(argv).toContain('-i');
    expect(argv).toContain('/abs/id_test');
    expect(argv).toContain('-o');
    expect(argv).toContain('IdentitiesOnly=yes');
    expect(argv).toContain('StrictHostKeyChecking=no');
    expect(argv).toContain('UserKnownHostsFile=/dev/null');
    expect(argv).toContain('-p');
    expect(argv).toContain('12345');
    expect(argv).toContain('tester@127.0.0.1');
    // Last arg must be the literal remote path — argv-quoting is the
    // caller's job because `ssh` runs it through the remote shell.
    expect(argv[argv.length - 1]).toBe('/srv/fixture.md');
    expect(argv).toContain('cat');
  });

  it('independentSshRead defaults identityFile to the committed fixture key', async () => {
    const mod = await import('../../e2e/helpers/independentSshRead');
    const argv = mod.composeSshReadArgs({
      port: 12345,
      user: 'tester',
      host: '127.0.0.1',
      remotePath: '/srv/fixture.md',
    });
    const idIdx = argv.indexOf('-i');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(argv[idIdx + 1]).toBe(path.join(fixtureRoot, 'id_test'));
  });

  it('independentSshWrite composes scp argv that pipes contents via stdin redirect', async () => {
    const mod = await import('../../e2e/helpers/independentSshWrite');
    const argv = mod.composeSshWriteArgs({
      port: 12345,
      user: 'tester',
      host: '127.0.0.1',
      identityFile: '/abs/id_test',
      remotePath: '/srv/fixture.md',
    });
    expect(argv).toContain('-i');
    expect(argv).toContain('/abs/id_test');
    expect(argv).toContain('-o');
    expect(argv).toContain('IdentitiesOnly=yes');
    expect(argv).toContain('StrictHostKeyChecking=no');
    expect(argv).toContain('UserKnownHostsFile=/dev/null');
    expect(argv).toContain('-p');
    expect(argv).toContain('12345');
    expect(argv).toContain('tester@127.0.0.1');
    // The remote-cmd payload is shell-quoted because the path can
    // contain spaces or arbitrary characters from the test tmpdir.
    const remoteCmd = argv[argv.length - 1];
    expect(remoteCmd).toMatch(/^cat > '[^']+'$/);
  });

  it('independentSshWrite escapes embedded single-quotes in the remote path', async () => {
    const mod = await import('../../e2e/helpers/independentSshWrite');
    const argv = mod.composeSshWriteArgs({
      port: 12345,
      user: 'tester',
      host: '127.0.0.1',
      remotePath: "/tmp/she's-here.md",
    });
    const remoteCmd = argv[argv.length - 1];
    // The single quote in the path must be escaped via the classic
    // `'\''` sh idiom (close, escaped-literal, reopen). If we don't do
    // this the remote `sh -c` parse fails and `independentSshWrite`
    // throws — which would mask the actual test failure.
    expect(remoteCmd).toContain(`'\\''`);
  });

  it('independentSshWrite defaults identityFile to the committed fixture key', async () => {
    const mod = await import('../../e2e/helpers/independentSshWrite');
    const argv = mod.composeSshWriteArgs({
      port: 12345,
      user: 'tester',
      host: '127.0.0.1',
      remotePath: '/srv/fixture.md',
    });
    const idIdx = argv.indexOf('-i');
    expect(idIdx).toBeGreaterThanOrEqual(0);
    expect(argv[idIdx + 1]).toBe(path.join(fixtureRoot, 'id_test'));
  });
});

describe('sshd-fixture: pickRandomPort + waitForPort', () => {
  it('pickRandomPort returns a usable ephemeral port', async () => {
    if (process.platform === 'win32') return;
    const { pickRandomPort } = await import('../../e2e/helpers/sshd-fixture');
    const a = await pickRandomPort();
    const b = await pickRandomPort();
    // Ephemeral ports must be in the unprivileged range and (usually)
    // distinct across back-to-back calls.
    expect(a).toBeGreaterThan(1023);
    expect(a).toBeLessThan(65536);
    expect(b).toBeGreaterThan(1023);
    expect(b).toBeLessThan(65536);
  });

  it('waitForPort throws when the deadline expires', async () => {
    if (process.platform === 'win32') return;
    const { pickRandomPort, waitForPort } = await import('../../e2e/helpers/sshd-fixture');
    // Pick a port the kernel handed us — nothing is listening on it
    // (we closed the listener inside pickRandomPort). A 200ms ceiling
    // is enough to deterministically time out without slowing the
    // suite down.
    const port = await pickRandomPort();
    await expect(waitForPort(port, 200)).rejects.toThrow(/never came up/);
  });

  it('waitForPort resolves once a listener is bound on the port', async () => {
    if (process.platform === 'win32') return;
    const { waitForPort } = await import('../../e2e/helpers/sshd-fixture');
    const { createServer } = await import('node:net');
    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') {
      srv.close();
      throw new Error('no address');
    }
    try {
      await waitForPort(addr.port, 2000);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});

/*
 * Skipping `startSshd` lifecycle tests from vitest: the function shells
 * out to `/usr/sbin/sshd`, which is the artifact whose behavior we're
 * verifying. Mocking it just exercises the test scaffolding, not the
 * code. Vitest covers everything-but-the-spawn (template render,
 * port-pick, port-wait, argv composition); the spawn itself is the
 * domain of the WDIO suite (B5) running against a real sshd on macOS.
 *
 * The corresponding Rust-side fixture `src-tauri/tests/common/ssh_fixture.rs`
 * is tested via `ssh_integration_phase1.rs` for the same reason —
 * neither suite ships unit-level "did spawn get called" assertions
 * because they would protect nothing.
 */
