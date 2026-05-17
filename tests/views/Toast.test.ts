/**
 * DOM tests for the global Toast surface (B5).
 *
 * The Toast view mounts a single `[data-region="toast"]` host element under
 * the app shell. Anything in the app that wants to surface a transient
 * error/info message dispatches a `mdviewer:toast` CustomEvent with the
 * shape `{ message: string; level?: 'error' | 'info' }`. The toast view
 * appends a `<div role="alert" class="toast">message</div>` child and
 * removes it after a timeout.
 *
 * Two consumers care about this surface:
 *   - Spec 21 (host-key changed): the SSH transport rejection
 *     "host key verification failed" surfaces here via main.ts's
 *     `openSshUrl` rejection handler.
 *   - Spec 24 (askpass cancel): clicking the askpass modal's Cancel
 *     button emits "auth cancelled" here, then ssh terminates.
 *
 * The host element is the single source of truth for the `data-region`
 * selector both specs query. Auto-dismiss is short (default 5s) so a
 * fresh toast can replace a stale one without piling visible alerts on
 * top of each other.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountToast } from '../../src/views/Toast';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('mountToast', () => {
  it('mounts a [data-region="toast"] host under the provided root', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    mountToast(root);

    const host = root.querySelector('[data-region="toast"]');
    expect(host).not.toBeNull();
    // Host starts empty — no toast text until an event fires.
    expect(host?.children.length).toBe(0);
  });

  it('appends a role=alert toast on mdviewer:toast event', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root);

    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'host key verification failed' } }),
    );

    const host = root.querySelector('[data-region="toast"]')!;
    const alerts = host.querySelectorAll('[role="alert"]');
    expect(alerts.length).toBe(1);
    expect(alerts[0].textContent).toBe('host key verification failed');
    expect(alerts[0].classList.contains('toast')).toBe(true);
  });

  it('renders the verbatim text the spec polls via getText()', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root);

    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'auth cancelled' } }),
    );

    const host = root.querySelector('[data-region="toast"]')!;
    // The toast text must read concatenated through the host so the
    // spec's `browser.$('[data-region="toast"]').getText()` resolves
    // to the message — that is the contract spec 24 polls for.
    expect(host.textContent).toContain('auth cancelled');
  });

  it('auto-dismisses the toast after the timeout elapses', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root, { timeoutMs: 1000 });

    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'transient error' } }),
    );

    const host = root.querySelector('[data-region="toast"]')!;
    expect(host.children.length).toBe(1);

    vi.advanceTimersByTime(1000);

    expect(host.children.length).toBe(0);
  });

  it('stacks multiple toasts and dismisses each independently', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root, { timeoutMs: 1000 });

    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'first' } }),
    );
    vi.advanceTimersByTime(400);
    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'second' } }),
    );

    const host = root.querySelector('[data-region="toast"]')!;
    expect(host.children.length).toBe(2);

    // Advance just past the first toast's 1000ms.
    vi.advanceTimersByTime(700);
    expect(host.children.length).toBe(1);
    expect(host.textContent).toContain('second');
    expect(host.textContent).not.toContain('first');

    // Advance past the second toast.
    vi.advanceTimersByTime(400);
    expect(host.children.length).toBe(0);
  });

  it('reflects the level via data-level on the toast element', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root);

    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'oops', level: 'error' } }),
    );

    const alert = root.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-level')).toBe('error');
  });

  it('defaults level to error when the event omits it', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root);

    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'oops' } }),
    );

    const alert = root.querySelector('[role="alert"]')!;
    expect(alert.getAttribute('data-level')).toBe('error');
  });

  it('returns a dispose() that removes the host and stops listening', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const dispose = mountToast(root);

    dispose();

    expect(root.querySelector('[data-region="toast"]')).toBeNull();

    // Post-dispose events must not throw and must not resurface the host.
    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', { detail: { message: 'after dispose' } }),
    );
    expect(root.querySelector('[data-region="toast"]')).toBeNull();
  });

  it('ignores events without a message field', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    mountToast(root);

    // Malformed payloads must not crash and must not produce a blank toast.
    document.dispatchEvent(new CustomEvent('mdviewer:toast', { detail: {} }));
    document.dispatchEvent(new CustomEvent('mdviewer:toast'));

    const host = root.querySelector('[data-region="toast"]')!;
    expect(host.children.length).toBe(0);
  });
});
