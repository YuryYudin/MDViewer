/**
 * DOM tests for the Drive-detect toast (wireframe 08).
 *
 * Three behaviours under test:
 *   1. First-show — mounting the toast renders the wireframe-08 controls
 *      (Connect button + small "Not now" close) and persists for as long
 *      as the user does nothing (no auto-dismiss timer).
 *   2. Per-file dismissal — clicking "Not now" calls the supplied
 *      `onDismiss(filePath)` and removes the toast from the DOM.
 *   3. Connect — clicking "Connect to Drive" triggers `drive_connect`
 *      asynchronously, flips the button into a "Connecting…" state, and
 *      on success calls `onConnected` (which the caller uses to set the
 *      global suppression flag) before unmounting the toast.
 *
 * The IPC layer is mocked so jsdom doesn't need a Tauri runtime — both
 * `driveConnect` (a typed wrapper) and the raw `invoke` path are stubbed
 * because the toast itself only depends on `driveConnect`. The trigger-
 * gating logic that consumes `is_drive_desktop_path`, `get_doc_pref`, and
 * `save_settings` lives in main.ts and is exercised through its own
 * harness — this file covers only the toast view's contract with its
 * caller.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const driveConnectMock = vi.fn();

vi.mock('../../src/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../src/ipc')>('../../src/ipc');
  return {
    ...actual,
    driveConnect: () => driveConnectMock(),
  };
});

beforeEach(() => {
  driveConnectMock.mockReset();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('DriveDetectToast', () => {
  it('mounts wireframe-08 controls (Connect + Not-now) under the host element', async () => {
    const { mountDriveDetectToast } = await import('../../src/views/DriveDetectToast');
    const host = document.createElement('div');
    document.body.appendChild(host);

    mountDriveDetectToast(host, {
      filePath: '/Users/alice/GoogleDrive/notes.md',
      onDismiss: vi.fn(),
      onConnected: vi.fn(),
    });

    const toast = host.querySelector<HTMLElement>('.drive-toast');
    expect(toast).toBeTruthy();
    // role=status so screen readers announce the toast as a non-modal
    // status update rather than an alert.
    expect(toast!.getAttribute('role')).toBe('status');
    expect(host.querySelector('[data-testid="drive-toast-connect"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="drive-toast-dismiss"]')).toBeTruthy();
  });

  it('does not auto-dismiss on a timer (must persist until the user acts)', async () => {
    // Wireframe-08 calls out explicitly that this toast persists until the
    // user clicks Connect or Not now — it must NOT be a transient toast.
    vi.useFakeTimers();
    try {
      const { mountDriveDetectToast } = await import('../../src/views/DriveDetectToast');
      const host = document.createElement('div');
      document.body.appendChild(host);

      mountDriveDetectToast(host, {
        filePath: '/p',
        onDismiss: vi.fn(),
        onConnected: vi.fn(),
      });

      // Advance well past any plausible auto-dismiss window.
      vi.advanceTimersByTime(60_000);
      expect(host.querySelector('.drive-toast')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clicking "Not now" calls onDismiss(filePath) and removes the toast', async () => {
    const { mountDriveDetectToast } = await import('../../src/views/DriveDetectToast');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onDismiss = vi.fn().mockResolvedValue(undefined);

    mountDriveDetectToast(host, {
      filePath: '/Users/alice/GoogleDrive/notes.md',
      onDismiss,
      onConnected: vi.fn(),
    });

    const dismissBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="drive-toast-dismiss"]',
    )!;
    dismissBtn.click();
    await flushAsync();

    expect(onDismiss).toHaveBeenCalledWith('/Users/alice/GoogleDrive/notes.md');
    expect(host.querySelector('.drive-toast')).toBeNull();
  });

  it('clicking Connect calls driveConnect, then onConnected, then unmounts', async () => {
    const { mountDriveDetectToast } = await import('../../src/views/DriveDetectToast');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onConnected = vi.fn().mockResolvedValue(undefined);
    driveConnectMock.mockResolvedValue({
      connected: true,
      account_email: 'alice@example.com',
      online: true,
      pending_count: 0,
    });

    mountDriveDetectToast(host, {
      filePath: '/p',
      onDismiss: vi.fn(),
      onConnected,
    });

    const connectBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="drive-toast-connect"]',
    )!;
    connectBtn.click();
    // Synchronously: the button goes into a "Connecting…" affordance so a
    // double-click can't double-submit.
    expect(connectBtn.disabled).toBe(true);
    expect(connectBtn.textContent).toMatch(/Connect/i);
    await flushAsync();
    await flushAsync();

    expect(driveConnectMock).toHaveBeenCalledTimes(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.drive-toast')).toBeNull();
  });

  it('re-enables Connect when driveConnect rejects so the user can retry', async () => {
    const { mountDriveDetectToast } = await import('../../src/views/DriveDetectToast');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onConnected = vi.fn();
    driveConnectMock.mockRejectedValue(new Error('user cancelled'));

    mountDriveDetectToast(host, {
      filePath: '/p',
      onDismiss: vi.fn(),
      onConnected,
    });

    const connectBtn = host.querySelector<HTMLButtonElement>(
      '[data-testid="drive-toast-connect"]',
    )!;
    connectBtn.click();
    await flushAsync();
    await flushAsync();

    // onConnected MUST NOT fire when the connect failed — that would set
    // the global suppression flag for a connection that never happened.
    expect(onConnected).not.toHaveBeenCalled();
    expect(connectBtn.disabled).toBe(false);
    expect(connectBtn.textContent).toBe('Connect to Drive');
    // Toast remains so the user can click Connect again or dismiss.
    expect(host.querySelector('.drive-toast')).toBeTruthy();
  });
});

/**
 * The trigger-gating predicate lives in `src/main.ts` (per spec Step 4):
 * the toast appears iff
 *   (1) `is_drive_desktop_path(path)` returns true,
 *   (2) settings.cloud.drive.connected is false,
 *   (3) settings.cloud.drive.detect_toast_suppressed is false,
 *   (4) doc_prefs entry for path has drive_detect_dismissed === false.
 *
 * These tests assert the predicate that main.ts evaluates BEFORE invoking
 * `mountDriveDetectToast`. They mock the four IPC inputs and assert the
 * mount call (vs. early return) — exactly the first-show / per-file-
 * dismissed / post-connect-suppressed cases the done_when calls out.
 */
describe('Drive-detect toast trigger gating (main.ts)', () => {
  type Invocation = { cmd: string; args: unknown };
  let invocations: Invocation[];
  let invokeImpl: (cmd: string, args: unknown) => Promise<unknown>;

  beforeEach(() => {
    invocations = [];
    invokeImpl = async (cmd: string, args: unknown) => {
      invocations.push({ cmd, args });
      switch (cmd) {
        case 'is_drive_desktop_path':
          return true;
        case 'get_doc_pref':
          return { font_size_px: 14, drive_detect_dismissed: false };
        default:
          return undefined;
      }
    };
  });

  async function runTrigger(
    filePath: string,
    settings: {
      cloud?: { drive?: { connected?: boolean; detect_toast_suppressed?: boolean } };
    },
  ): Promise<{ mounted: boolean; calls: Invocation[] }> {
    const { maybeShowDriveDetectToast } = await import('../../src/main');
    const host = document.createElement('div');
    let mounted = false;
    await maybeShowDriveDetectToast(host, filePath, settings, {
      invoke: (cmd, args) => invokeImpl(cmd, args),
      mount: () => {
        mounted = true;
      },
    });
    return { mounted, calls: invocations };
  }

  it('first-show: mounts when path is on Drive Desktop, not connected, no dismissal, no global suppression', async () => {
    const { mounted, calls } = await runTrigger('/Users/alice/GoogleDrive/notes.md', {
      cloud: { drive: { connected: false, detect_toast_suppressed: false } },
    });
    expect(mounted).toBe(true);
    // Order matters for early-return correctness: we must not invoke
    // `is_drive_desktop_path` or `get_doc_pref` when settings already
    // disqualify the toast. With everything green, both must be called.
    expect(calls.map((c) => c.cmd)).toContain('is_drive_desktop_path');
    expect(calls.map((c) => c.cmd)).toContain('get_doc_pref');
  });

  it('per-file dismissed: does not mount when doc_prefs.drive_detect_dismissed is true', async () => {
    invokeImpl = async (cmd: string, args: unknown) => {
      invocations.push({ cmd, args });
      switch (cmd) {
        case 'is_drive_desktop_path':
          return true;
        case 'get_doc_pref':
          return { font_size_px: 14, drive_detect_dismissed: true };
        default:
          return undefined;
      }
    };
    const { mounted } = await runTrigger('/Users/alice/GoogleDrive/notes.md', {
      cloud: { drive: { connected: false, detect_toast_suppressed: false } },
    });
    expect(mounted).toBe(false);
  });

  it('post-connect global suppressed: does not mount when settings.cloud.drive.detect_toast_suppressed is true', async () => {
    const { mounted, calls } = await runTrigger('/Users/alice/GoogleDrive/notes.md', {
      cloud: { drive: { connected: false, detect_toast_suppressed: true } },
    });
    expect(mounted).toBe(false);
    // Optimisation: when the global suppression flag is already on we must
    // short-circuit BEFORE the IPC roundtrips so opening a file that lives
    // on the Drive mount stays as cheap as opening any other local file.
    expect(calls).toHaveLength(0);
  });

  it('already-connected: does not mount when settings.cloud.drive.connected is true', async () => {
    const { mounted, calls } = await runTrigger('/Users/alice/GoogleDrive/notes.md', {
      cloud: { drive: { connected: true, detect_toast_suppressed: false } },
    });
    expect(mounted).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('not on a Drive Desktop mount: does not mount even with everything else green', async () => {
    invokeImpl = async (cmd: string, args: unknown) => {
      invocations.push({ cmd, args });
      switch (cmd) {
        case 'is_drive_desktop_path':
          return false;
        default:
          return undefined;
      }
    };
    const { mounted, calls } = await runTrigger('/Users/alice/notes.md', {
      cloud: { drive: { connected: false, detect_toast_suppressed: false } },
    });
    expect(mounted).toBe(false);
    // get_doc_pref MUST NOT be called once is_drive_desktop_path returns
    // false — the path-classifier is the cheapest gate, so no follow-up IPC.
    expect(calls.map((c) => c.cmd)).not.toContain('get_doc_pref');
  });
});
