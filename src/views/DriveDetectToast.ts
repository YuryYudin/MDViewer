/**
 * DriveDetectToast — wireframe 08 "Drive folder detected" prompt.
 *
 * Mounted by `main.ts` when the user opens a document that lives under a
 * Drive Desktop mount AND the four trigger predicates all hold (see
 * `maybeShowDriveDetectToast` in main.ts for the full contract). The
 * toast is a persistent, non-modal status surface — it intentionally does
 * NOT auto-dismiss on a timer, because the user choice ("Not now" vs.
 * "Connect to Drive") is what the surrounding feature uses to decide
 * whether to show the toast again.
 *
 * Contract with the caller (main.ts):
 *   - `onDismiss(filePath)` writes `drive_detect_dismissed = true` to
 *     the per-file doc-prefs entry so the toast never re-appears for
 *     this specific file. Per-file (not global) by design.
 *   - `onConnected()` runs after `drive_connect` resolves successfully;
 *     the caller flips `settings.cloud.drive.detect_toast_suppressed`
 *     to `true` so the toast is globally suppressed for every future
 *     open in the workspace.
 *
 * The toast does NOT directly mutate doc-prefs or settings — those side
 * effects live in main.ts so a future re-host (e.g. mounting the toast
 * inside Workspace.ts instead of from main.ts) doesn't have to thread
 * the IPC layer through this view.
 */
import { driveConnect } from '../ipc';

export interface DriveDetectToastDeps {
  /** Absolute on-disk path of the document that triggered the toast.
   *  Forwarded to `onDismiss` so the caller can key the doc-prefs entry. */
  filePath: string;
  /** Persists the per-file dismissal flag (drive_detect_dismissed=true).
   *  Returning a Promise lets the caller fail loudly if the IPC fails;
   *  the toast unmounts regardless of outcome (consistent with native
   *  toast UX — the dismissal is visual; the persistence is best-effort). */
  onDismiss: (filePath: string) => Promise<void>;
  /** Called after `drive_connect` resolves successfully. The caller uses
   *  this to flip the global suppression flag in settings so future opens
   *  on Drive Desktop paths don't re-prompt. */
  onConnected: () => Promise<void>;
}

const CONNECT_LABEL = 'Connect to Drive';
const CONNECTING_LABEL = 'Connecting…';
const DISMISS_LABEL = 'Not now';
const TOAST_MESSAGE =
  'This file is in your Google Drive folder. Connect to enable comment sync.';

/**
 * Mount the Drive-detect toast under `host` and return a `close()` callback
 * the caller can invoke to dismiss programmatically (e.g. when the tab
 * closes before the user has clicked anything).
 *
 * Returning a closer (rather than relying on the caller to query the DOM)
 * mirrors `mountOpenFromDrive` and lets future re-hosts (Workspace.ts,
 * StartPage.ts, etc.) tear down the toast without owning a DOM query.
 */
export function mountDriveDetectToast(
  host: HTMLElement,
  deps: DriveDetectToastDeps,
): () => void {
  const toast = document.createElement('div');
  toast.className = 'drive-toast';
  // role=status (not role=alert): the toast is a non-blocking informational
  // surface — alerting the AT user with `role=alert` would interrupt the
  // document they just opened, which is the opposite of the wireframe's
  // intent.
  toast.setAttribute('role', 'status');

  const msg = document.createElement('span');
  msg.className = 'drive-toast-message';
  msg.textContent = TOAST_MESSAGE;
  toast.appendChild(msg);

  const connectBtn = document.createElement('button');
  connectBtn.type = 'button';
  connectBtn.textContent = CONNECT_LABEL;
  connectBtn.dataset.testid = 'drive-toast-connect';
  connectBtn.className = 'drive-toast-connect';
  toast.appendChild(connectBtn);

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.textContent = DISMISS_LABEL;
  dismissBtn.dataset.testid = 'drive-toast-dismiss';
  dismissBtn.className = 'drive-toast-dismiss';
  toast.appendChild(dismissBtn);

  // Bug fix (2025-05-01): connect failures (e.g. PLACEHOLDER client_id
  // error) used to only console.warn — invisible to users without
  // DevTools. Inline error element shows the rejection inline so the
  // user knows why nothing happened.
  const errorEl = document.createElement('div');
  errorEl.className = 'drive-toast-error';
  errorEl.dataset.testid = 'drive-toast-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.color = 'var(--danger)';
  errorEl.style.marginTop = '8px';
  errorEl.style.fontSize = '13px';
  errorEl.style.flexBasis = '100%';
  errorEl.hidden = true;
  toast.appendChild(errorEl);

  host.appendChild(toast);

  const close = (): void => {
    toast.remove();
  };

  // Tauri IPC rejects with the raw `Err(String)` payload, NOT an Error
  // object. Normalize so we never display "undefined".
  const errMsg = (e: unknown): string => {
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
      return (e as { message: string }).message;
    }
    return String(e);
  };

  dismissBtn.addEventListener('click', () => {
    // Fire onDismiss but unmount synchronously — the user clicked Not now,
    // so the visual disappearance must be immediate even if the doc-prefs
    // write hasn't flushed yet. A failed write surfaces through the
    // caller's promise rejection (the toast is gone either way).
    void deps.onDismiss(deps.filePath).catch((err) => {
      // best-effort log; dismissal already happened visually.
      console.warn('drive-detect dismissal failed to persist:', err);
    });
    close();
  });

  connectBtn.addEventListener('click', () => {
    // Disable + label-swap synchronously so a double-click can't fire
    // drive_connect twice (the OAuth window is heavy — a duplicate would
    // pop a second browser tab).
    connectBtn.disabled = true;
    connectBtn.textContent = CONNECTING_LABEL;
    errorEl.textContent = '';
    errorEl.hidden = true;
    void (async () => {
      try {
        await driveConnect();
        await deps.onConnected();
        close();
      } catch (err) {
        // Reset to the resting state so the user can retry. The toast
        // stays mounted on failure and surfaces the error inline so the
        // user knows what happened.
        connectBtn.disabled = false;
        connectBtn.textContent = CONNECT_LABEL;
        errorEl.textContent = `Failed to connect: ${errMsg(err)}`;
        errorEl.hidden = false;
        console.warn('drive-detect connect failed:', err);
      }
    })();
  });

  return close;
}
