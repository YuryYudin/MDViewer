/**
 * Global Toast surface.
 *
 * Mounted once at app boot under the workspace shell. Renders nothing
 * until something dispatches an `mdviewer:toast` CustomEvent on
 * `document` — the only public API. The event detail shape:
 *
 *   { message: string; level?: 'error' | 'info' }
 *
 * Each toast becomes a `<div role="alert" class="toast" data-level="...">`
 * appended to the `[data-region="toast"]` host. After `timeoutMs`
 * (default 5000) the toast is removed. The host itself stays mounted
 * so the spec's `[data-region="toast"]` selector resolves at any
 * time, even when no toast is currently visible.
 *
 * Why a CustomEvent rather than a singleton API: the toast surface has
 * many producers (SSH transport errors via `main.ts::openSshUrl`, the
 * askpass cancel handler in `AskpassModal.ts`, future save-failure /
 * conflict paths). A document-level event lets each producer fire-and-
 * forget without importing the toast module, and lets tests drive the
 * surface by dispatching a normal `CustomEvent` (no module-level
 * singleton to reset between tests).
 *
 * Specs that read this surface:
 *   - `e2e/21-ssh-open-from-cli.spec.ts` (host-key-verification-failed)
 *   - `e2e/24-ssh-conflict.spec.ts` (auth cancelled)
 */
export type ToastLevel = 'error' | 'info';

export interface ToastEventDetail {
  message: string;
  level?: ToastLevel;
}

export interface MountToastOptions {
  /** Auto-dismiss delay in ms. Defaults to 5000. */
  timeoutMs?: number;
}

/**
 * Mount the toast host under `root`. Returns a `dispose()` that removes
 * the host and detaches the document-level event listener.
 */
export function mountToast(root: HTMLElement, options: MountToastOptions = {}): () => void {
  const timeoutMs = options.timeoutMs ?? 5000;

  const host = document.createElement('div');
  host.setAttribute('data-region', 'toast');
  host.className = 'toast-host';
  root.appendChild(host);

  const onToast = (ev: Event): void => {
    const detail = (ev as CustomEvent<Partial<ToastEventDetail>>).detail;
    const message = detail?.message;
    if (typeof message !== 'string' || message.length === 0) {
      // Defensive: ignore malformed events. A blank toast would render
      // as an empty alert box, which the user can't dismiss and tells
      // them nothing.
      return;
    }
    const level: ToastLevel = detail?.level ?? 'error';
    const toast = document.createElement('div');
    toast.setAttribute('role', 'alert');
    toast.setAttribute('data-level', level);
    toast.className = 'toast';
    toast.textContent = message;
    host.appendChild(toast);

    setTimeout(() => {
      // Defensive: the toast may have already been removed if the host
      // was disposed mid-flight. Calling remove() on a detached node
      // is a no-op so we don't have to guard explicitly, but we still
      // skip the work if the host is gone.
      if (toast.parentElement === host) {
        host.removeChild(toast);
      }
    }, timeoutMs);
  };

  document.addEventListener('mdviewer:toast', onToast);

  return () => {
    document.removeEventListener('mdviewer:toast', onToast);
    if (host.parentElement) {
      host.parentElement.removeChild(host);
    }
  };
}
