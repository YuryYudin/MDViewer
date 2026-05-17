/**
 * WDIO sshd test fixture helper (B4 + B5 gap 8).
 *
 * The TS analog of `src-tauri/tests/common/ssh_fixture.rs` (A12). Spawns
 * FOUR real `/usr/sbin/sshd` processes on the literal ports the immutable
 * A1 specs reference (2222-2225), each with a per-scenario config:
 *
 *   * 2222 / happy             — id_test.pub authorized; standard host
 *                                key. The "looks like a local tab" and
 *                                save-back scenarios (specs 21, 22, 23)
 *                                hit this listener.
 *   * 2223 / hostKeyMismatch   — id_test.pub authorized BUT a different
 *                                host key (generated ad-hoc per run).
 *                                The client's known_hosts is implicitly
 *                                seeded from 2222's fingerprint; the
 *                                production transport must surface
 *                                "host key verification failed" when it
 *                                connects to 2223 and sees the different
 *                                fingerprint. Drives spec 21's host-key-
 *                                changed assertion.
 *   * 2224 / unauthorized      — authorized_keys is EMPTY. The client's
 *                                id_test fails publickey auth and ssh
 *                                emits "Permission denied (publickey)".
 *                                Drives spec 22's auth-failure scenario.
 *   * 2225 / passphrasedKey    — a second ed25519 keypair (generated at
 *                                fixture start, NOT committed) protected
 *                                by a known passphrase. authorized_keys
 *                                = the new pub. The client must invoke
 *                                askpass to unlock the key. Drives spec
 *                                24's askpass scenarios.
 *
 * All four share the same `tmpDir` so the seeded `fixture.md` file lives
 * at a path every sshd can serve.
 *
 * Coverage seam: the small pure helpers — `renderSshdConfig`,
 * `pickRandomPort`, `waitForPort`, and the argv composers in the
 * sibling files — are unit-tested under `tests/e2e-helpers/`. The
 * `startSshd` body that actually shells to `/usr/sbin/sshd` is NOT
 * unit-tested: that's the artifact whose behavior we're verifying,
 * and mocking it would only exercise the test scaffolding. The real
 * spawn lifecycle is exercised by the WDIO suite (B5) on macOS / Linux
 * CI.
 *
 * Windows: `/usr/sbin/sshd` doesn't exist on Windows and the WDIO suite
 * doesn't run there (see `wdio.conf.ts`). We reject with a clear message
 * pointing the caller at the Rust integration tests instead.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `__dirname` isn't defined in ESM. The project sets "type": "module"
// and `module: "ESNext"` in tsconfig, so we have to compute it from
// `import.meta.url`. Same pattern as `tests/codegen.test.ts`.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Literal port numbers the immutable A1 specs hardcode. Centralised so a
 * future renumber blows up here, not deep inside spec assertions or the
 * sshd spawn loop.
 *
 * NOTE: these are LITERAL ports, not ephemeral. The spec contract is
 * "open ssh://localhost:2222/..." — if the kernel hands us a different
 * port the spec's URL no longer points at our sshd. The fallback when
 * a port is already in use is to surface the bind failure loudly so
 * the dev / CI runner notices and shuts down the stale listener.
 */
export const SCENARIO_PORTS = {
  happy: 2222,
  hostKeyMismatch: 2223,
  unauthorized: 2224,
  passphrasedKey: 2225,
} as const;

/**
 * Per-scenario sub-fixture. Each gets its own tmpdir (sshd writes a
 * pidfile + log here) but they all share the parent `tmpDir` for the
 * served `fixture.md` so the specs can compose the same URL path
 * regardless of which scenario port they're hitting.
 */
export interface ScenarioSubFixture {
  port: number;
  cleanup: () => Promise<void>;
}

export interface HappyScenario extends ScenarioSubFixture {
  /** Client identity file (= the committed id_test). */
  identityFile: string;
}

export interface HostKeyMismatchScenario extends ScenarioSubFixture {
  // No identityFile here — the connect should fail before auth even runs.
  // Host key is generated ad-hoc and lives in this scenario's per-port
  // tmpdir, so the path isn't a stable spec contract.
}

export interface UnauthorizedScenario extends ScenarioSubFixture {
  /** Client identity file the spec offers — server rejects it. */
  identityFile: string;
}

export interface PassphrasedKeyScenario extends ScenarioSubFixture {
  /** Plain-text passphrase the askpass modal must echo back. */
  passphrase: string;
  /** Absolute path to the passphrased client identity. */
  identityFile: string;
}

export interface SshdFixture {
  /**
   * Writable tmpdir under `os.tmpdir()`. The helper seeds it with a
   * baseline `fixture.md` so save-back / conflict specs can mutate the
   * file at a path they control. Per-scenario sshd configs live in
   * per-scenario subdirectories under this root.
   */
  tmpDir: string;
  /**
   * Absolute path to the committed default client identity (`id_test`).
   * Top-level so existing specs that pass `identityFile: fixture.identityFile`
   * to `independentSshRead` / `independentSshWrite` keep working.
   */
  identityFile: string;
  /** Standard happy-path listener (id_test.pub authorized). */
  happy: HappyScenario;
  /** Listener with a divergent host key — drives the host-key-changed toast. */
  hostKeyMismatch: HostKeyMismatchScenario;
  /** Listener with no authorized keys — drives "Permission denied (publickey)". */
  unauthorized: UnauthorizedScenario;
  /** Listener whose only authorized key is passphrase-protected — drives askpass. */
  passphrasedKey: PassphrasedKeyScenario;
  /** SIGTERMs every sshd and removes the shared tmpdir. */
  cleanup: () => Promise<void>;
}

/**
 * Workspace-root-relative path to the committed fixture keypair. The
 * fixture dir is shared with the Rust integration tests; the README at
 * `src-tauri/tests/fixtures/ssh/README.md` documents that contract.
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
 * Generate an ed25519 keypair using the system `ssh-keygen`. Writes
 * `<dest>` and `<dest>.pub`. Optional passphrase encrypts the private key.
 *
 * The keypair is throwaway — used only for the host-key-mismatch and
 * passphrased-key scenarios. Not committed; regenerated on every fixture
 * spawn so stale fingerprints don't leak across runs.
 */
function generateEd25519Key(dest: string, passphrase: string = ''): void {
  // -t ed25519: algorithm
  // -f <dest>: output file
  // -N <pass>: new passphrase (empty string = no passphrase)
  // -C <comment>: identifier so the comment column doesn't read "user@host"
  // -q: quiet (no random-art pretty-print)
  const result = spawnSync(
    'ssh-keygen',
    ['-t', 'ed25519', '-f', dest, '-N', passphrase, '-C', 'mdviewer-b5-fixture', '-q'],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (result.status !== 0) {
    throw new Error(`ssh-keygen failed (status ${result.status}) generating ${dest}`);
  }
  // Tighten perms — sshd refuses keys whose perms grant group/other read.
  chmodSync(dest, 0o600);
}

/**
 * Spawn one sshd process. Renders a per-scenario sshd_config in
 * `scenarioDir`, drops a `pidfile`, and waits for the port to accept
 * a TCP connect. Returns the child + a cleanup that SIGTERMs the
 * listener and removes the per-scenario dir.
 *
 * Throws if sshd dies before binding (the message includes the exit
 * code so a CI failure points at the actual cause, not a generic
 * "never came up" timeout).
 */
async function spawnOneSshd(opts: {
  port: number;
  hostKey: string;
  authorizedKeys: string;
  scenarioDir: string;
}): Promise<{ cleanup: () => Promise<void> }> {
  const configPath = path.join(opts.scenarioDir, 'sshd_config');
  const pidfile = path.join(opts.scenarioDir, 'sshd.pid');
  const rendered = renderSshdConfig({
    port: opts.port,
    hostKey: opts.hostKey,
    authorizedKeys: opts.authorizedKeys,
    pidfile,
  });
  writeFileSync(configPath, rendered, { mode: 0o600 });
  chmodSync(opts.hostKey, 0o600);

  const child: ChildProcess = spawn('/usr/sbin/sshd', ['-f', configPath, '-D', '-e'], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  let earlyExitCode: number | null = null;
  child.once('exit', (code) => {
    earlyExitCode = code;
  });

  try {
    await waitForPort(opts.port);
  } catch (e) {
    if (earlyExitCode !== null) {
      throw new Error(
        `sshd exited with code ${earlyExitCode} before binding port ${opts.port}; ` +
          `is the port already in use? (configured for the immutable spec contract)`,
      );
    }
    throw e;
  }

  const cleanup = async (): Promise<void> => {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
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
  };

  return { cleanup };
}

/**
 * Spawn one sshd PER scenario on the literal spec ports 2222-2225.
 *
 * Why literal ports: the A1 spec files (immutable) hardcode the port
 * numbers in their `const HOST_KEY_OK_PORT = 2222` etc. declarations.
 * Allocating ephemeral ports here would mean threading a per-scenario
 * port back into the specs, which we cannot do.
 *
 * The cost of literal ports is collision with other processes on the
 * runner. CI runs on a clean image so collision is rare; for local dev,
 * any prior fixture run that didn't shut down cleanly will hit a
 * "port in use" error on the next start — that's by design; the message
 * points the user at the stale sshd.
 */
export async function startSshd(): Promise<SshdFixture> {
  if (process.platform === 'win32') {
    throw new Error(
      'WDIO sshd fixture not supported on Windows; use the Rust integration tests instead.',
    );
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'mdviewer-wdio-sshd-'));
  // Seed the shared writable markdown file specs 21/22/23/24 open.
  writeFileSync(path.join(tmpDir, 'fixture.md'), '# original\n');

  const identityFile = path.join(FIXTURE_ROOT, 'id_test');
  const committedHostKey = path.join(FIXTURE_ROOT, 'test_host_key');
  const committedAuthKeys = path.join(FIXTURE_ROOT, 'authorized_keys');

  // Re-tighten the committed private-key perms — git can preserve mode
  // bits across clones on most filesystems, but defense-in-depth on a
  // test fixture costs nothing.
  for (const p of [identityFile, committedHostKey]) {
    try {
      chmodSync(p, 0o600);
    } catch {
      // chmod can fail on filesystems that don't track unix perms (e.g.
      // some CI cache mounts). Let sshd surface the real error if it cares.
    }
  }

  // ---- Per-scenario directories ----------------------------------------
  const happyDir = path.join(tmpDir, 'happy');
  const mismatchDir = path.join(tmpDir, 'hostKeyMismatch');
  const unauthorizedDir = path.join(tmpDir, 'unauthorized');
  const passphraseDir = path.join(tmpDir, 'passphrasedKey');
  for (const d of [happyDir, mismatchDir, unauthorizedDir, passphraseDir]) {
    mkdirSync(d, { recursive: true });
  }

  // ---- hostKeyMismatch: ad-hoc divergent host key -----------------------
  // The host key MUST differ from the committed test_host_key. We
  // generate a fresh ed25519 keypair per fixture spawn so a stale
  // known_hosts entry from a prior run can't accidentally satisfy this
  // scenario.
  const mismatchHostKey = path.join(mismatchDir, 'host_key_mismatch');
  generateEd25519Key(mismatchHostKey);

  // ---- unauthorized: empty authorized_keys ------------------------------
  // The empty file is its own authoritative "no keys accepted" signal —
  // sshd happily loads it (StrictModes=no in the template) and rejects
  // every pubkey attempt with "Permission denied (publickey)".
  const unauthorizedAuthKeys = path.join(unauthorizedDir, 'authorized_keys');
  writeFileSync(unauthorizedAuthKeys, '', { mode: 0o600 });

  // ---- passphrasedKey: new keypair with a known passphrase --------------
  // The askpass modal echoes the typed passphrase back to ssh; ssh
  // decrypts the key and proceeds. The passphrase is exposed on the
  // returned fixture so spec 24 can drive the modal deterministically.
  const passphrase = 'mdviewer-b5-passphrase';
  const passphrasedKeyPath = path.join(passphraseDir, 'id_passphrased');
  generateEd25519Key(passphrasedKeyPath, passphrase);
  const passphrasedAuthKeys = path.join(passphraseDir, 'authorized_keys');
  writeFileSync(passphrasedAuthKeys, readFileSync(`${passphrasedKeyPath}.pub`, 'utf8'), {
    mode: 0o600,
  });

  // ---- Spawn all four sshds ---------------------------------------------
  // Sequential spawn so a "port in use" failure surfaces against the
  // specific scenario that hit it, rather than as a confused
  // Promise.all rejection.
  const spawned: Array<{ cleanup: () => Promise<void> }> = [];
  const cleanupAll = async (): Promise<void> => {
    await Promise.allSettled(spawned.map((s) => s.cleanup()));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort: a tmpdir we couldn't remove doesn't break the next
      // run because we mkdtemp a fresh one.
    }
  };

  try {
    const happy = await spawnOneSshd({
      port: SCENARIO_PORTS.happy,
      hostKey: committedHostKey,
      authorizedKeys: committedAuthKeys,
      scenarioDir: happyDir,
    });
    spawned.push(happy);

    const mismatch = await spawnOneSshd({
      port: SCENARIO_PORTS.hostKeyMismatch,
      hostKey: mismatchHostKey,
      authorizedKeys: committedAuthKeys,
      scenarioDir: mismatchDir,
    });
    spawned.push(mismatch);

    const unauthorized = await spawnOneSshd({
      port: SCENARIO_PORTS.unauthorized,
      hostKey: committedHostKey,
      authorizedKeys: unauthorizedAuthKeys,
      scenarioDir: unauthorizedDir,
    });
    spawned.push(unauthorized);

    const passphrased = await spawnOneSshd({
      port: SCENARIO_PORTS.passphrasedKey,
      hostKey: committedHostKey,
      authorizedKeys: passphrasedAuthKeys,
      scenarioDir: passphraseDir,
    });
    spawned.push(passphrased);
  } catch (err) {
    // If any spawn fails, tear down what we did get up. Re-throw the
    // original error so the caller sees the root cause.
    await cleanupAll();
    throw err;
  }
  // Pull the per-scenario cleanups out by index for the sub-fixture
  // bindings — every spawnOneSshd above pushed in scenario order.
  const [happyCleanup, mismatchCleanup, unauthorizedCleanup, passphrasedCleanup] = spawned.map(
    (s) => s.cleanup,
  );

  return {
    tmpDir,
    identityFile,
    happy: {
      port: SCENARIO_PORTS.happy,
      identityFile,
      cleanup: happyCleanup,
    },
    hostKeyMismatch: {
      port: SCENARIO_PORTS.hostKeyMismatch,
      cleanup: mismatchCleanup,
    },
    unauthorized: {
      port: SCENARIO_PORTS.unauthorized,
      identityFile,
      cleanup: unauthorizedCleanup,
    },
    passphrasedKey: {
      port: SCENARIO_PORTS.passphrasedKey,
      passphrase,
      identityFile: passphrasedKeyPath,
      cleanup: passphrasedCleanup,
    },
    cleanup: cleanupAll,
  };
}
