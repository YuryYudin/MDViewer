import { describe, it, expect, vi, beforeEach } from 'vitest';

// Defer the listen() promise so the test can resolve it manually after
// calling dispose(), exercising the cancellation race in DriveStatus.ts
// (lines 60-62: `if (cancelled) { u(); return; }` after listen resolves).
type Listener = (ev: { payload: unknown }) => void;
type ListenPromiseHandle = {
  resolve: (unsub: () => void) => void;
  reject: (e: unknown) => void;
};
const listenHandles: ListenPromiseHandle[] = [];
const listenCalls: { event: string; cb: Listener }[] = [];

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, cb: Listener) => {
    listenCalls.push({ event, cb });
    return new Promise<() => void>((resolve, reject) => {
      listenHandles.push({ resolve, reject });
    });
  },
}));

// driveStatus() goes through invoke('drive_status'); defer its resolution
// the same way so we can interleave dispose() before render().
type InvokeHandle = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const invokeHandles: InvokeHandle[] = [];
const invokeCalls: string[] = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) => {
    invokeCalls.push(cmd);
    return new Promise((resolve, reject) => {
      invokeHandles.push({ resolve, reject });
    });
  },
}));

beforeEach(() => {
  listenHandles.length = 0;
  listenCalls.length = 0;
  invokeHandles.length = 0;
  invokeCalls.length = 0;
});

// DriveStatus.ts uses two `void (async () => { ... })()` IIFEs that each
// `await import(...)` before touching the mocked modules. Waiting a few
// microtasks lets both dynamic imports resolve and reach the mock call.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('DriveStatus — cancellation + error paths', () => {
  it('calls the unsub when dispose() runs after listen() resolves (race window)', async () => {
    const { mountDriveStatus } = await import('../../src/views/DriveStatus');
    const host = document.createElement('div');
    const dispose = mountDriveStatus(host);

    // Let the dynamic imports inside the two IIFEs resolve so listen() and
    // invoke('drive_status') get called and their pending promises register.
    await flushAsync();
    expect(listenHandles.length).toBe(1);

    // Trip cancelled=true BEFORE the listen promise resolves so the
    // post-await `if (cancelled) { u(); return; }` branch fires
    // (DriveStatus.ts:60-62).
    dispose();

    const unsub = vi.fn();
    listenHandles[0]!.resolve(unsub);
    await flushAsync();

    // The cancellation branch tears the listener down by calling the unsub
    // returned from listen() — this is the only way we can verify the
    // branch ran since render() is a no-op when cancelled.
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('skips render() when dispose() runs before driveStatus() resolves', async () => {
    const { mountDriveStatus } = await import('../../src/views/DriveStatus');
    const host = document.createElement('div');
    const dispose = mountDriveStatus(host);

    // The status-fetch IIFE awaits a dynamic import of '../ipc' before
    // calling driveStatus(); poll the call list so we don't depend on a
    // fixed number of microtasks.
    for (let i = 0; i < 50 && invokeCalls.length === 0; i++) {
      await flushAsync();
      await new Promise((r) => setTimeout(r, 0));
    }
    // dispose before driveStatus resolves → render() must NOT be called
    // (DriveStatus.ts:76 — `if (!cancelled) render(s);`).
    dispose();

    expect(invokeCalls).toContain('drive_status');
    invokeHandles[invokeCalls.indexOf('drive_status')]!.resolve({
      connected: true,
      account_email: 'late@example.com',
      online: true,
      pending_count: 9,
    });
    await flushAsync();

    // The pill text must remain at its initial empty value because render()
    // was skipped by the cancellation guard.
    expect(host.textContent).toBe('');
    expect(host.dataset.connected).toBe('false');
  });

  it('survives listen() rejection (jsdom path) without throwing', async () => {
    const { mountDriveStatus } = await import('../../src/views/DriveStatus');
    const host = document.createElement('div');
    const dispose = mountDriveStatus(host);

    await flushAsync();
    expect(listenHandles.length).toBe(1);

    // Reject the listen promise — the catch in DriveStatus.ts swallows it
    // (covers the catch arm in the listen IIFE for completeness).
    listenHandles[0]!.reject(new Error('no tauri runtime'));
    await flushAsync();

    // Pill stays in its initial empty/disconnected state.
    expect(host.textContent).toBe('');
    expect(() => dispose()).not.toThrow();
  });
});
