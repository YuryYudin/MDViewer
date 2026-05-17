/**
 * DOM tests for the AskpassModal (wireframe-03 SSH passphrase / password
 * prompt).
 *
 * The modal subscribes to `ssh:askpass-request` Tauri events through
 * `ipc.onSshAskpassRequest` and renders one of two variants based on
 * `isPassword` (false = SSH key passphrase, true = SSH password). Cancel
 * sends `null`; submit sends the user-supplied string. Escape acts as
 * Cancel; Enter acts as Submit.
 *
 * We mock the IPC module so tests can drive the event subscription
 * synchronously from inside each spec — the askpass-request handler
 * captured by `onSshAskpassRequest` is the real wireup, and invoking it
 * directly lets us assert the same DOM transitions a real Tauri event
 * would trigger.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sshPasswordResponseMock = vi.fn();
let askpassHandler: ((req: { reqId: string; prompt: string; isPassword: boolean }) => void) | null = null;
const onSshAskpassRequestMock = vi.fn(
  (h: (req: { reqId: string; prompt: string; isPassword: boolean }) => void) => {
    askpassHandler = h;
    return () => {
      askpassHandler = null;
    };
  },
);

vi.mock('../../src/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../src/ipc')>('../../src/ipc');
  return {
    ...actual,
    ipc: {
      ...actual.tauriIpc,
      sshOpenUrl: vi.fn(),
      sshPasswordResponse: (reqId: string, value: string | null) =>
        sshPasswordResponseMock(reqId, value),
      onSshAskpassRequest: (h: (req: { reqId: string; prompt: string; isPassword: boolean }) => void) =>
        onSshAskpassRequestMock(h),
    },
  };
});

beforeEach(() => {
  document.body.innerHTML = '';
  sshPasswordResponseMock.mockReset();
  sshPasswordResponseMock.mockResolvedValue(undefined);
  onSshAskpassRequestMock.mockClear();
  askpassHandler = null;
});

afterEach(() => {
  vi.useRealTimers();
});

async function importMount(): Promise<typeof import('../../src/views/AskpassModal').mountAskpassModal> {
  const mod = await import('../../src/views/AskpassModal');
  return mod.mountAskpassModal;
}

describe('AskpassModal', () => {
  it('renders an overlay hidden by default with the wireframe-03 controls', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    // B5: testid is only attached while the modal is *shown* — query the
    // stable host attribute for the initial-mount check. The testid
    // toggles in `show()` / `hide()` so spec 24's `!isExisting()` poll
    // can resolve once the user dismisses the modal.
    const overlay = document.querySelector('[data-region="askpass-host"]') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(overlay.style.display).toBe('none');
    // Initial mount: no testid yet (modal dormant).
    expect(overlay.hasAttribute('data-testid')).toBe(false);
    expect(overlay.querySelector('.askpass-title')).toBeTruthy();
    expect(overlay.querySelector('.askpass-prompt')).toBeTruthy();
    const input = overlay.querySelector('.askpass-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.type).toBe('password');
    expect(overlay.querySelector('.askpass-cancel')).toBeTruthy();
    expect(overlay.querySelector('.askpass-submit')).toBeTruthy();
  });

  it('subscribes to ssh:askpass-request via ipc.onSshAskpassRequest', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    expect(onSshAskpassRequestMock).toHaveBeenCalledTimes(1);
  });

  it('renders the passphrase variant (variant A) when isPassword=false', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'r1', prompt: 'Enter passphrase for key:', isPassword: false });
    const title = document.querySelector('.askpass-title') as HTMLElement;
    const prompt = document.querySelector('.askpass-prompt') as HTMLElement;
    expect(title.textContent).toContain('passphrase');
    expect(prompt.textContent).toBe('Enter passphrase for key:');
    const overlay = document.querySelector('[data-testid="askpass-modal"]') as HTMLElement;
    expect(overlay.style.display).not.toBe('none');
  });

  it('renders the password variant (variant B) when isPassword=true', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'r2', prompt: "user@host's password:", isPassword: true });
    const title = document.querySelector('.askpass-title') as HTMLElement;
    expect(title.textContent?.toLowerCase()).toContain('password');
    // The passphrase wording must NOT appear on the password variant — the
    // wireframe explicitly differentiates the two titles.
    expect(title.textContent?.toLowerCase()).not.toContain('passphrase');
  });

  it('submit click forwards the input value via ipc.sshPasswordResponse', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'x', prompt: 'Password:', isPassword: true });
    const input = document.querySelector('.askpass-input') as HTMLInputElement;
    input.value = 'hunter2';
    (document.querySelector('.askpass-submit') as HTMLButtonElement).click();
    expect(sshPasswordResponseMock).toHaveBeenCalledWith('x', 'hunter2');
    // Modal hides after submission. The testid is dropped (spec 24's
    // `!isExisting()` poll resolves); the stable host attribute persists
    // so the unit test can still locate the overlay for the display check.
    const overlay = document.querySelector('[data-region="askpass-host"]') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    expect(document.querySelector('[data-testid="askpass-modal"]')).toBeNull();
  });

  it('cancel click sends null and hides the overlay', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'x', prompt: 'P:', isPassword: true });
    (document.querySelector('.askpass-cancel') as HTMLButtonElement).click();
    expect(sshPasswordResponseMock).toHaveBeenCalledWith('x', null);
    const overlay = document.querySelector('[data-region="askpass-host"]') as HTMLElement;
    expect(overlay.style.display).toBe('none');
    expect(document.querySelector('[data-testid="askpass-modal"]')).toBeNull();
  });

  it('cancel click emits a mdviewer:toast event with "auth cancelled"', async () => {
    // B5 spec 24 contract — the toast surface is the user-visible signal.
    // The Toast view (mounted by Workspace) listens on document for
    // `mdviewer:toast`; here we assert the producer side fires it with
    // the verbatim text the spec polls.
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'x', prompt: 'P:', isPassword: false });
    const received: Array<{ message: string; level?: string }> = [];
    const handler = (ev: Event): void => {
      const d = (ev as CustomEvent<{ message: string; level?: string }>).detail;
      received.push(d);
    };
    document.addEventListener('mdviewer:toast', handler);
    try {
      (document.querySelector('.askpass-cancel') as HTMLButtonElement).click();
    } finally {
      document.removeEventListener('mdviewer:toast', handler);
    }
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe('auth cancelled');
    expect(received[0].level).toBe('error');
  });

  it('Escape key triggers cancel (sends null)', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'x', prompt: 'P:', isPassword: true });
    const input = document.querySelector('.askpass-input') as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sshPasswordResponseMock).toHaveBeenCalledWith('x', null);
  });

  it('Enter key triggers submit with the input value', async () => {
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'x', prompt: 'P:', isPassword: true });
    const input = document.querySelector('.askpass-input') as HTMLInputElement;
    input.value = 'secret';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sshPasswordResponseMock).toHaveBeenCalledWith('x', 'secret');
  });

  it('clicking buttons without a pending prompt is a no-op', async () => {
    // Edge case: the buttons exist before any prompt has fired (overlay
    // is hidden). Click handlers must guard against `pending == null` so a
    // stray click can't send a stale reqId.
    const mount = await importMount();
    mount({ root: document.body });
    (document.querySelector('.askpass-cancel') as HTMLButtonElement).click();
    (document.querySelector('.askpass-submit') as HTMLButtonElement).click();
    expect(sshPasswordResponseMock).not.toHaveBeenCalled();
  });

  it('clears the input when a fresh prompt arrives so old text does not leak', async () => {
    // Security: a previous prompt's typed value must not survive into the
    // next prompt's input field. Otherwise a passphrase typed for key A
    // could be sent verbatim as the response to key B's prompt.
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'first', prompt: 'P1:', isPassword: true });
    const input = document.querySelector('.askpass-input') as HTMLInputElement;
    input.value = 'leak';
    askpassHandler!({ reqId: 'second', prompt: 'P2:', isPassword: false });
    expect(input.value).toBe('');
  });

  it('focuses the input on next tick after a prompt arrives', async () => {
    // The deferred focus is the setTimeout(focus, 0) polish — without it
    // the first keystroke into the password field can be lost on slower
    // WebView boots. We use fake timers and advance by 0 to flush.
    vi.useFakeTimers();
    const mount = await importMount();
    mount({ root: document.body });
    askpassHandler!({ reqId: 'r', prompt: 'P:', isPassword: true });
    vi.runAllTimers();
    const input = document.querySelector('.askpass-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  it('returned dispose function unsubscribes and removes the overlay', async () => {
    const mount = await importMount();
    const dispose = mount({ root: document.body });
    // B5: testid toggles with show/hide — initial mount is dormant, so
    // the host attribute is the stable selector for the "did the overlay
    // mount" check. Dispose() removes the whole overlay node.
    expect(document.querySelector('[data-region="askpass-host"]')).toBeTruthy();
    dispose();
    expect(document.querySelector('[data-region="askpass-host"]')).toBeNull();
    expect(document.querySelector('[data-testid="askpass-modal"]')).toBeNull();
    // After dispose, the captured handler ref is cleared so a stray event
    // (e.g. fired before the unsubscribe round-trip completes) can't render
    // into a detached overlay.
    expect(askpassHandler).toBeNull();
  });
});
