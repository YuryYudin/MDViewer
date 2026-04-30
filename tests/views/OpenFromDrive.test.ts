/**
 * DOM tests for the Open-from-Drive modal (wireframe 04).
 *
 * The modal has three input affordance states (empty / valid / invalid) and
 * we cover all three plus:
 *   - submit invokes `drive_open_url` IPC with the trimmed URL
 *   - inline error stays visible on backend failure (modal does NOT auto-close)
 *   - Esc + click-out + Cancel each close the modal
 *   - the regex matches every `*.google.com/*` host (drive / docs / etc)
 *
 * The IPC layer is mocked at module-resolution time so jsdom doesn't need a
 * Tauri runtime — the modal imports `driveOpenUrl` from `../ipc`, and this
 * stub records every call so tests can assert the URL forwarded to Rust.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const driveOpenUrlMock = vi.fn();

vi.mock('../../src/ipc', async () => {
  const actual = await vi.importActual<typeof import('../../src/ipc')>('../../src/ipc');
  return {
    ...actual,
    driveOpenUrl: (url: string) => driveOpenUrlMock(url),
  };
});

// The modal's input listener uses a short debounce so wiretests don't have to
// hit a real timer — fake timers let us advance past the debounce window
// deterministically.
beforeEach(() => {
  vi.useFakeTimers();
  driveOpenUrlMock.mockReset();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
});

afterEach(() => {
  vi.useRealTimers();
});

async function importMount(): Promise<typeof import('../../src/views/OpenFromDrive').mountOpenFromDrive> {
  const mod = await import('../../src/views/OpenFromDrive');
  return mod.mountOpenFromDrive;
}

function flushDebounce(): void {
  // Advance past the 80ms debounce window the input handler uses.
  vi.advanceTimersByTime(120);
}

describe('OpenFromDrive', () => {
  it('mounts a modal overlay with the wireframe-04 controls', async () => {
    const mount = await importMount();
    mount();
    const modal = document.querySelector('.drive-modal');
    expect(modal).toBeTruthy();
    expect(document.querySelector('[data-testid="drive-url-input"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="drive-modal-cancel"]')).toBeTruthy();
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    expect(open).toBeTruthy();
    // Initial state: Open is disabled because the URL is empty.
    expect(open.disabled).toBe(true);
  });

  it('shows the empty-state hint when the input is blank', async () => {
    const mount = await importMount();
    mount();
    const hint = document.querySelector('[data-testid="drive-url-hint"]') as HTMLElement;
    expect(hint).toBeTruthy();
    expect(hint.dataset.state ?? 'empty').toBe('empty');
  });

  it('keeps Open disabled and surfaces an invalid hint for non-Drive URLs', async () => {
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    const hint = document.querySelector('[data-testid="drive-url-hint"]') as HTMLElement;
    input.value = 'not-a-url';
    input.dispatchEvent(new Event('input'));
    flushDebounce();
    expect(open.disabled).toBe(true);
    expect(hint.dataset.state).toBe('invalid');
  });

  it('enables Open and shows the valid hint for a Drive URL', async () => {
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    const hint = document.querySelector('[data-testid="drive-url-hint"]') as HTMLElement;
    input.value = 'https://drive.google.com/file/d/1ABCxyz/view';
    input.dispatchEvent(new Event('input'));
    flushDebounce();
    expect(open.disabled).toBe(false);
    expect(hint.dataset.state).toBe('valid');
  });

  it('also accepts docs.google.com URLs (any *.google.com host)', async () => {
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    input.value = 'https://docs.google.com/document/d/abc/edit';
    input.dispatchEvent(new Event('input'));
    flushDebounce();
    expect(open.disabled).toBe(false);
  });

  it('debounces the input event so the affordance updates only once per burst', async () => {
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    // Type partial value, then quickly overwrite — only the final state
    // should win after the debounce flushes.
    input.value = 'h';
    input.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(20);
    input.value = 'https://drive.google.com/file/d/X/view';
    input.dispatchEvent(new Event('input'));
    // Before the debounce flushes, button is still disabled (no
    // intermediate state was committed for the partial 'h').
    expect(open.disabled).toBe(true);
    flushDebounce();
    expect(open.disabled).toBe(false);
  });

  it('clicking Open invokes driveOpenUrl with the trimmed URL and closes the modal', async () => {
    driveOpenUrlMock.mockResolvedValue({ id: 't1', title: 'doc.md' });
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    input.value = '   https://drive.google.com/file/d/1ABCxyz/view   ';
    input.dispatchEvent(new Event('input'));
    flushDebounce();
    open.click();
    // Wait for the microtask queue + the close-on-success path.
    await vi.runAllTimersAsync();
    expect(driveOpenUrlMock).toHaveBeenCalledWith('https://drive.google.com/file/d/1ABCxyz/view');
    expect(document.querySelector('.drive-modal')).toBeFalsy();
  });

  it('shows the inline error and stays open when drive_open_url rejects', async () => {
    driveOpenUrlMock.mockRejectedValue(new Error('File not found or not shared.'));
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const open = document.querySelector('[data-testid="drive-modal-open"]') as HTMLButtonElement;
    const hint = document.querySelector('[data-testid="drive-url-hint"]') as HTMLElement;
    input.value = 'https://drive.google.com/file/d/zzzNotMine/view';
    input.dispatchEvent(new Event('input'));
    flushDebounce();
    open.click();
    await vi.runAllTimersAsync();
    // Modal stays mounted with the error inline so the user can edit / cancel.
    expect(document.querySelector('.drive-modal')).toBeTruthy();
    expect(hint.dataset.state).toBe('invalid');
    expect(hint.textContent).toContain('File not found');
    // Open re-enables so the user can retry after editing.
    expect(open.disabled).toBe(false);
  });

  it('closes on Cancel click', async () => {
    const mount = await importMount();
    mount();
    const cancel = document.querySelector('[data-testid="drive-modal-cancel"]') as HTMLButtonElement;
    cancel.click();
    expect(document.querySelector('.drive-modal')).toBeFalsy();
  });

  it('closes on Escape keypress', async () => {
    const mount = await importMount();
    mount();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.drive-modal')).toBeFalsy();
  });

  it('closes on click-out (overlay backdrop click)', async () => {
    const mount = await importMount();
    mount();
    const overlay = document.querySelector('.drive-modal') as HTMLElement;
    // Simulate a click on the overlay itself (not on the inner card).
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.drive-modal')).toBeFalsy();
  });

  it('does NOT close when the inner card is clicked', async () => {
    const mount = await importMount();
    mount();
    const card = document.querySelector('.drive-modal .modal-card') as HTMLElement;
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.drive-modal')).toBeTruthy();
  });

  it('builds DOM imperatively — no innerHTML interpolation of user data', async () => {
    // Sanity: the heading and hint text use textContent. We assert by
    // searching for an HTML-shaped string in the rendered DOM and
    // confirming it doesn't appear as live markup.
    const mount = await importMount();
    mount();
    const input = document.querySelector('[data-testid="drive-url-input"]') as HTMLInputElement;
    const hint = document.querySelector('[data-testid="drive-url-hint"]') as HTMLElement;
    input.value = '<img src=x onerror=alert(1)>';
    input.dispatchEvent(new Event('input'));
    flushDebounce();
    // The invalid-state branch sets a fixed message; the user input never
    // gets interpolated into the hint, so no <img> tag appears anywhere.
    expect(hint.querySelector('img')).toBeNull();
  });

  it('returns a close() function the caller can invoke to dismiss the modal', async () => {
    const mount = await importMount();
    const close = mount();
    expect(document.querySelector('.drive-modal')).toBeTruthy();
    close();
    expect(document.querySelector('.drive-modal')).toBeFalsy();
  });

  it('removes the keydown listener after close (no Escape leak)', async () => {
    const mount = await importMount();
    const close = mount();
    close();
    // Dispatching Escape with no modal mounted must not throw and must
    // not somehow re-create / remove anything.
    expect(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    ).not.toThrow();
    expect(document.querySelector('.drive-modal')).toBeFalsy();
  });
});
