/**
 * Out-of-band SSH read helper for the WDIO save-back spec (23).
 *
 * Shells out to the system `ssh` client with the committed fixture
 * keypair and runs `cat <remotePath>` on the remote host. Bypasses our
 * production SSH transport entirely — the whole point of save-back
 * verification is that we don't validate our own writer using our own
 * reader.
 *
 * Why a separate file instead of a method on `SshdFixture`: spec 23
 * imports `{ independentSshRead }` directly (it's a top-level utility,
 * not a method on a stateful handle), and the plan's `files.create`
 * list called for three separate files. Keeping them separate also
 * lets the symmetric `independentSshWrite` sit at the same level
 * with the same code shape.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Same FIXTURE_ROOT as sshd-fixture.ts — duplicated locally to keep this
 * helper independently importable (spec 23 imports it without touching
 * sshd-fixture). */
const FIXTURE_ROOT = path.resolve(__dirname, '../../src-tauri/tests/fixtures/ssh');

export interface IndependentSshReadOpts {
  host: string;
  port: number;
  user: string;
  /** Absolute path to the client identity. Required so the caller can
   * point at the fixture key without relying on `~/.ssh/`. */
  identityFile?: string;
  /** Absolute path on the remote — passed verbatim to `cat`. */
  remotePath: string;
}

/**
 * Construct the ssh argv. Exported for vitest: pinning the argv shape in
 * a unit test stops a careless edit from dropping
 * `StrictHostKeyChecking=no`, which would make the spec block on a
 * known_hosts prompt and hang forever in CI.
 */
export function composeSshReadArgs(opts: IndependentSshReadOpts): string[] {
  const identityFile = opts.identityFile ?? path.join(FIXTURE_ROOT, 'id_test');
  return [
    '-i', identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'LogLevel=ERROR',
    '-p', String(opts.port),
    `${opts.user}@${opts.host}`,
    '--',
    'cat',
    opts.remotePath,
  ];
}

/**
 * Spawn `ssh ... -- cat <remotePath>` and return the captured stdout as
 * a string. Throws on non-zero exit or signal termination; the caller
 * (WDIO spec) should not need to inspect stderr, but it's surfaced in
 * the error message for easier debugging.
 */
export async function independentSshRead(opts: IndependentSshReadOpts): Promise<string> {
  const argv = composeSshReadArgs(opts);
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(
          new Error(
            `ssh cat exited ${code}; stderr=${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        );
      }
    });
  });
}
