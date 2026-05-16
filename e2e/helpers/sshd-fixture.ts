/**
 * WDIO sshd test fixture helper (B4).
 *
 * The TS analog of `src-tauri/tests/common/ssh_fixture.rs` (A12). Spawns
 * a real `/usr/sbin/sshd` against a random ephemeral port using the
 * committed test keypair under `src-tauri/tests/fixtures/ssh/`, so the
 * WDIO suite (specs 21-24) drives the production SSH transport end-to-
 * end against a real server we control.
 *
 * Coverage seam: the small pure helpers — `renderSshdConfig`,
 * `pickRandomPort`, `waitForPort`, and the argv composers in the
 * sibling files — are unit-tested under `tests/e2e-helpers/`. The
 * `startSshd` body that actually shells to `/usr/sbin/sshd` is NOT
 * unit-tested: that's the artifact whose behavior we're verifying,
 * and mocking it would only exercise the test scaffolding. The real
 * spawn lifecycle is exercised by the WDIO suite (B5) on macOS.
 *
 * Lifecycle:
 *   1. `const fixture = await startSshd()` — spawns sshd, blocks until
 *      the port accepts a TCP connect, returns a handle.
 *   2. The caller uses `fixture.port`, `fixture.tmpDir/fixture.md`, etc.
 *   3. `await fixture.cleanup()` — SIGTERMs sshd, removes the tmpdir.
 *
 * Why a tmpdir at all: sshd needs writable scratch (its pidfile lives
 * here) AND we need a writable mountpoint for `fixture.md` that the
 * specs can mutate (save-back marker, conflict simulation). Combining
 * those two into one tmpdir keeps the lifecycle trivial.
 *
 * Windows: `/usr/sbin/sshd` doesn't exist on Windows and the WDIO suite
 * doesn't run there (see `wdio.conf.ts`). We reject with a clear message
 * pointing the caller at the Rust integration tests instead.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `__dirname` isn't defined in ESM. The project sets "type": "module"
// and `module: "ESNext"` in tsconfig, so we have to compute it from
// `import.meta.url`. Same pattern as `tests/codegen.test.ts`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SshdFixture {
  /** Ephemeral TCP port sshd is listening on (loopback only). */
  port: number;
  /**
   * Writable tmpdir under `os.tmpdir()`. The helper seeds it with a
   * baseline `fixture.md` so save-back / conflict specs can mutate the
   * file at a path they control. The rendered sshd config and pidfile
   * also live here.
   */
  tmpDir: string;
  /**
   * Absolute path to the client identity. Forwarded into the app under
   * test via `MDVIEWER_TEST_SSH_IDENTITY` (same env-var the Rust
   * integration tests use). Specs 23/24 also pass it directly to the
   * out-of-band `independentSshRead` / `independentSshWrite` helpers
   * so those bypass the production transport.
   */
  identityFile: string;
  /**
   * The fixture for the askpass-modal scenarios (spec 24). The Phase A
   * fixture set up by A12 doesn't ship a separate passphrased keypair
   * yet — the field exists so the immutable A1 spec file continues to
   * compile, and so a future fixture extension can drop the real
   * passphrased key in without touching the helper's API surface.
   */
  passphrasedKey: {
    /** Plain-text passphrase the askpass modal must echo back. */
    passphrase: string;
    /** Absolute path to the passphrased client identity. */
    identityFile: string;
  };
  /** SIGTERMs sshd, awaits exit, and removes the tmpdir. */
  cleanup: () => Promise<void>;
}

/**
 * Workspace-root-relative path to the committed fixture keypair. The
 * fixture dir is shared with the Rust integration tests; the README at
 * `tests/fixtures/ssh/README.md` documents that contract.
 */
export const FIXTURE_ROOT = path.resolve(__dirname, '../../src-tauri/tests/fixtures/ssh');

/**
 * Substitute the templated tokens in the committed sshd_config template.
 * Exported for unit tests — the template substitution is the only piece
 * of pure logic in this module and we want vitest coverage on it.
 */
export function renderSshdConfig(opts: {
  port: number;
  hostKey: string;
  authorizedKeys: string;
  pidfile: string;
}): string {
  const template = readFileSync(path.join(FIXTURE_ROOT, 'sshd_config.template'), 'utf8');
  // Replace-all — the committed template references each token twice
  // (once in the docs block at the top, once in the actual directive
  // below), so a single-shot `String#replace` would leave the real
  // directive intact and sshd would fail to bind a sensible port.
  return template
    .replaceAll('__PORT__', String(opts.port))
    .replaceAll('__HOST_KEY__', opts.hostKey)
    .replaceAll('__AUTHKEYS__', opts.authorizedKeys)
    .replaceAll('__PIDFILE__', opts.pidfile);
}

/**
 * Bind to port 0, read what the kernel handed us, close the listener.
 * The port can in principle be reused before sshd binds it, but the
 * race window is microseconds and `waitForPort` below absorbs any
 * actual startup delay. Same approach as `ssh_fixture.rs::pick_random_port`.
 */
export function pickRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close();
        reject(new Error('failed to read ephemeral port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Poll the loopback listener at `port` until it accepts a TCP connect or
 * the deadline expires. 50ms × 5s ceiling, matching ssh_fixture.rs.
 * Fixed sleeps flake under CI load; this is the cheap, deterministic
 * substitute.
 */
export async function waitForPort(port: number, deadlineMs: number = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((res) => {
      const s = createConnection(port, '127.0.0.1');
      s.once('connect', () => {
        s.end();
        res(true);
      });
      s.once('error', () => res(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`sshd at 127.0.0.1:${port} never came up within ${deadlineMs}ms`);
}

/**
 * Spawn `/usr/sbin/sshd -f <rendered config> -D -e` against the committed
 * fixture keypair on a random ephemeral port. Returns a handle the caller
 * can drive specs against; the handle's `cleanup` SIGTERMs sshd and
 * removes the tmpdir.
 */
export async function startSshd(): Promise<SshdFixture> {
  if (process.platform === 'win32') {
    throw new Error(
      'WDIO sshd fixture not supported on Windows; use the Rust integration tests instead.',
    );
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'mdviewer-wdio-sshd-'));
  const port = await pickRandomPort();
  const configPath = path.join(tmpDir, 'sshd_config');
  const pidfile = path.join(tmpDir, 'sshd.pid');
  const identityFile = path.join(FIXTURE_ROOT, 'id_test');
  const hostKey = path.join(FIXTURE_ROOT, 'test_host_key');
  const authorizedKeys = path.join(FIXTURE_ROOT, 'authorized_keys');

  const rendered = renderSshdConfig({ port, hostKey, authorizedKeys, pidfile });
  // 0o600 because sshd refuses to load a config with group/other write
  // bits set when StrictModes is on. We set StrictModes=no in the
  // template too, but defense-in-depth on a test fixture costs nothing.
  writeFileSync(configPath, rendered, { mode: 0o600 });

  // Re-tighten the committed private-key perms before sshd reads them.
  // git can preserve mode bits across clones on most filesystems, but
  // the safe-by-default belt-and-braces is to chmod 600 here. sshd
  // refuses to load a key whose perms grant group/other read.
  const { chmodSync } = await import('node:fs');
  for (const p of [identityFile, hostKey]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      // chmod can fail on filesystems that don't track unix perms (e.g.
      // some CI cache mounts). The fixture has the right perms in git
      // already, so a failed re-tighten isn't fatal — let sshd surface
      // the real error if it cares.
    }
  }

  // Seed the writable markdown file specs 21/22/23/24 open.
  writeFileSync(path.join(tmpDir, 'fixture.md'), '# original\n');

  // `-D` keeps sshd in the foreground so `child.kill()` reaps the
  // listener; `-e` forwards logs to stderr so a failed spawn surfaces
  // the actual reason in the test output rather than a generic
  // "sshd never came up".
  const child: ChildProcess = spawn('/usr/sbin/sshd', ['-f', configPath, '-D', '-e'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  // If sshd dies before we can wait for the port, surface that explicitly
  // rather than letting `waitForPort` time out with a misleading message.
  let earlyExitCode: number | null = null;
  child.once('exit', (code) => {
    earlyExitCode = code;
  });

  try {
    await waitForPort(port);
  } catch (e) {
    if (earlyExitCode !== null) {
      throw new Error(`sshd exited with code ${earlyExitCode} before binding port ${port}`);
    }
    throw e;
  }

  const cleanup = async (): Promise<void> => {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
      // Wait up to 2s for the process to actually exit; on stubborn
      // sshd builds (or under heavy CI load) SIGTERM can take a moment.
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Process already dead — fall through.
          }
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a tmpdir we couldn't remove on Windows-mounted FS
      // doesn't break the next run because we mkdtemp a fresh one.
    }
  };

  return {
    port,
    tmpDir,
    identityFile,
    // Phase A's A12 fixture doesn't yet ship a separate passphrased
    // keypair — the askpass-modal scenarios (spec 24) lean on a future
    // fixture extension. Until that lands we expose the API shape with
    // a sentinel passphrase + the same identity file so the immutable
    // A1 spec file keeps compiling. The real spec assertions stay RED
    // for spec 24 until the passphrased fixture follow-up.
    passphrasedKey: {
      passphrase: 'test-passphrase',
      identityFile,
    },
    cleanup,
  };
}
