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
  overlay.setAttribute('data-testid', 'askpass-modal');

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
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(cancelBtn);

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'askpass-submit primary';
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
  }

  cancelBtn.addEventListener('click', () => {
    if (!pending) return;
    const reqId = pending.reqId;
    hide();
    void ipc.sshPasswordResponse(reqId, null);
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
