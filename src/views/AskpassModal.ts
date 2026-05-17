import { ipc } from '../ipc';

/**
 * Wireframe-03 SSH passphrase / password prompt.
 *
 * Mounted once at app boot (the mount call lives in `Workspace.ts`, owned
 * by A8). The modal owns its own DOM lifecycle: created on mount, removed
 * by the returned `dispose()`. It subscribes to `ssh:askpass-request`
 * Tauri events via `ipc.onSshAskpassRequest` and surfaces one of two
 * variants based on the payload's `isPassword` flag:
 *
 *   - `isPassword=false` → variant A ("SSH key passphrase required")
 *   - `isPassword=true`  → variant B ("SSH password required")
 *
 * The two variants share the entire DOM and differ only in the title /
 * helper-text strings — we do NOT string-match the `prompt` field to pick
 * a variant. The Rust side is the source of truth for which prompt fired.
 *
 * Security:
 *
 *   - The typed value is never stored locally. It rides
 *     `ipc.sshPasswordResponse(reqId, value)` straight back to Rust and is
 *     then dropped on the next prompt (the input is cleared on `show`).
 *   - Cancel sends `null` (NOT an empty string) so the Rust side can
 *     distinguish "user aborted" from "user entered no characters".
 *
 * Focus management is deferred via `setTimeout(focus, 0)` so the next
 * layout tick handles the focus call. A synchronous focus on `show()`
 * races the WebView's compositor and can drop the first keystroke — see
 * the a11.md "Avoid" note for the polish rationale.
 */
export interface AskpassModalProps {
  root: HTMLElement;
}

interface PendingPrompt {
  reqId: string;
  prompt: string;
  isPassword: boolean;
}

export function mountAskpassModal(props: AskpassModalProps): () => void {
  const overlay = document.createElement('div');
  overlay.className = 'askpass-overlay modal-overlay';
  overlay.style.display = 'none';
  // B5: the `data-testid="askpass-modal"` attribute is toggled
  // visible↔hidden along with the overlay so spec 24's
  // `await browser.waitUntil(async () => !(await askpass.isExisting()))`
  // polling resolves once the user clicks Submit / Cancel.
  // WDIO's isExisting() checks DOM presence, NOT CSS visibility — a
  // display:none element still exists, so the only reliable way to make
  // the "no longer mounted" poll resolve is to drop the testid attribute
  // (`querySelector('[data-testid="askpass-modal"]')` returns null when
  // the attribute is absent). A stable `data-region="askpass-host"`
  // attribute stays on the overlay regardless so unit tests can still
  // locate the host element on initial mount via that selector.
  overlay.setAttribute('data-region', 'askpass-host');

  const panel = document.createElement('div');
  panel.className = 'askpass-panel modal-card';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  overlay.appendChild(panel);

  const title = document.createElement('h2');
  title.className = 'askpass-title';
  panel.appendChild(title);

  const promptEl = document.createElement('p');
  promptEl.className = 'askpass-prompt';
  panel.appendChild(promptEl);

  const input = document.createElement('input');
  input.className = 'askpass-input';
  input.type = 'password';
  input.autocomplete = 'off';
  panel.appendChild(input);

  const actions = document.createElement('div');
  actions.className = 'askpass-actions modal-actions';
  panel.appendChild(actions);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'askpass-cancel';
  // B5: spec 24 selector — `[data-action="cancel"]`. The class is kept
  // alongside so legacy unit-test selectors don't drift.
  cancelBtn.setAttribute('data-action', 'cancel');
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(cancelBtn);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'askpass-submit primary';
  // B5: spec 24 selector — `[data-action="submit"]`. Co-exists with the
  // class for the same reason as the cancel button above.
  submitBtn.setAttribute('data-action', 'submit');
  submitBtn.textContent = 'Submit';
  actions.appendChild(submitBtn);

  props.root.appendChild(overlay);

  // Tracks the in-flight prompt. Cleared on submit / cancel / dispose so
  // a stray button click can't send a stale reqId back to Rust.
  let pending: PendingPrompt | null = null;

  function show(req: PendingPrompt): void {
    pending = req;
    title.textContent = req.isPassword
      ? 'SSH password required'
      : 'SSH key passphrase required';
    promptEl.textContent = req.prompt;
    // B5: spec 24 contract — `data-kind` on the overlay is the canonical
    // discriminator between the passphrase (variant A) and password
    // (variant B) variants. The Rust side is the source of truth (the
    // `isPassword` flag in the askpass payload) — we never pattern-match
    // the prompt text to pick a variant.
    overlay.setAttribute('data-kind', req.isPassword ? 'password' : 'passphrase');
    // Toggle the spec-side testid on so `browser.$('[data-testid=...]')`
    // resolves to the overlay once the modal is visible.
    overlay.setAttribute('data-testid', 'askpass-modal');
    // Clear any previous value — a passphrase typed for key A must NEVER
    // survive into key B's prompt.
    input.value = '';
    overlay.style.display = 'flex';
    // Defer focus so layout settles before the focus call. Synchronous
    // focus drops the first keystroke on slower WebView boots.
    setTimeout(() => input.focus(), 0);
  }

  function hide(): void {
    pending = null;
    overlay.style.display = 'none';
    // Drop the testid so spec 24's `!askpass.isExisting()` poll resolves
    // (the element still lives in the DOM tree under the persistent
    // `[data-region="askpass-host"]` selector, but queries by testid
    // miss while the modal is dormant).
    overlay.removeAttribute('data-testid');
    overlay.removeAttribute('data-kind');
  }

  cancelBtn.addEventListener('click', () => {
    if (!pending) return;
    const reqId = pending.reqId;
    hide();
    void ipc.sshPasswordResponse(reqId, null);
    // B5: spec 24 contract — the askpass cancel path must surface
    // "auth cancelled" via the global toast region. Ssh terminates
    // shortly after the null response and the open promise rejects,
    // but the user-visible signal is the toast — that's what the spec
    // polls for. Dispatched on `document` so the Toast view (mounted
    // by Workspace) picks it up regardless of where the cancel click
    // originated.
    document.dispatchEvent(
      new CustomEvent('mdviewer:toast', {
        detail: { message: 'auth cancelled', level: 'error' },
      }),
    );
  });

  submitBtn.addEventListener('click', () => {
    if (!pending) return;
    const reqId = pending.reqId;
    const value = input.value;
    hide();
    void ipc.sshPasswordResponse(reqId, value);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelBtn.click();
    } else if (e.key === 'Enter') {
      submitBtn.click();
    }
  });

  const unsubscribe = ipc.onSshAskpassRequest(show);

  return () => {
    unsubscribe();
    pending = null;
    overlay.remove();
  };
}
