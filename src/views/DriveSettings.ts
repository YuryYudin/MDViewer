/**
 * DriveSettings — Drive sub-section of the Settings panel (wireframes 01/02).
 *
 * Renders one of two states based on `settings.cloud.drive.connected`:
 *   - Disconnected: "Not connected" status card + Connect button
 *     (matches wireframe 01).
 *   - Connected: "Connected as {email}" status card + Disconnect button
 *     (matches wireframe 02).
 * Both states show an `<details>` "Advanced" toggle that reveals the BYO
 * (Bring-Your-Own) OAuth `client_id` input. The full Backend dropdown and
 * poll-interval picker are wireframe non-goals at the IPC level for A8 —
 * they're inert/disabled controls until later phases wire them.
 *
 * Persistence:
 *   - The BYO `client_id` input writes through the caller-supplied
 *     `saveSettings(patch)` so the existing dirty-flag UX from the parent
 *     Settings panel keeps working. We DO NOT keep a parallel local copy.
 *   - Connect/Disconnect call the typed wrappers in `src/ipc.ts`. The Rust
 *     handlers also emit `drive-status-changed`, so the status pill updates
 *     without a follow-up read here.
 *
 * C5 (Phase 3): the caller (`Settings.ts`) now mounts us unconditionally —
 * the `feature_enabled` UI gate was removed when the default flipped to
 * `true`. The user-facing kill-switch lives in `src-tauri/src/main.rs`
 * (`drive_connect` / `drive_open_url` short-circuit when
 * `cloud.drive.feature_enabled = false`), so the Settings panel keeps
 * showing the section in either state — it's how the user flips the
 * kill-switch back on without hand-editing TOML. Defense-in-depth: we
 * still no-op when the slice is missing entirely (e.g. a synthetic
 * settings object that omits `cloud`).
 */
import type { Settings } from '../ipc';
import { driveConnect, driveDisconnect } from '../ipc';

export interface DriveSettingsDeps {
  /** Persist a Settings snapshot (whole-snapshot pattern, same as the
   *  rest of Settings.ts). The caller decides whether to debounce. */
  saveSettings: (next: Settings) => Promise<void>;
  /** Optional toast/notification hook. The Drive section logs Connect /
   *  Disconnect failures here so the user sees them. */
  notify?: (msg: string, kind?: 'info' | 'error') => void;
}

const BYO_DEBOUNCE_MS = 250;

export function mountDriveSettings(
  root: HTMLElement,
  settings: Settings,
  deps: DriveSettingsDeps,
): void {
  const drive = settings.cloud?.drive;
  if (!drive) return; // defensive — caller should already feature-flag.

  // The single Drive sub-section element. Marker attribute lets the parent
  // Settings tests assert presence/absence without poking at internals.
  const section = document.createElement('section');
  section.setAttribute('data-section', 'drive');
  section.setAttribute('data-testid', 'drive-section');
  section.className = 'settings-subsection';

  const heading = document.createElement('h2');
  heading.textContent = 'Drive integration';
  section.appendChild(heading);

  // ── Status card ──────────────────────────────────────────────────────
  // The card shape (icon + 2-line text + action button) matches wireframes
  // 01 and 02. The icon and copy flip based on `connected`.
  const card = document.createElement('div');
  card.className = 'status-card';

  const icon = document.createElement('span');
  icon.className = drive.connected ? 'icon success' : 'icon warn';
  icon.textContent = drive.connected ? '✓' : '⚠'; // ✓ / ⚠
  card.appendChild(icon);

  const text = document.createElement('div');
  text.className = 'text';
  const line1 = document.createElement('div');
  line1.className = 'line1';
  const line1Strong = document.createElement('strong');
  if (drive.connected) {
    const email = drive.account_email ?? 'unknown account';
    line1Strong.textContent = `Connected as ${email}`;
  } else {
    line1Strong.textContent = 'Not connected';
  }
  line1.appendChild(line1Strong);
  text.appendChild(line1);
  const line2 = document.createElement('div');
  line2.className = 'line2';
  line2.textContent = drive.connected
    ? 'Real-time comment sync is on for Drive-stored documents.'
    : 'Sign in with Google to enable real-time comment sync on Drive-stored documents.';
  text.appendChild(line2);
  card.appendChild(text);

  const actionBtn = document.createElement('button');
  // Bug fix (2025-05-01): Settings.ts didn't pass `notify`, so connect/
  // disconnect failures (including Bug-1's PLACEHOLDER client_id error)
  // were silently swallowed by `notify?.()`. Render an always-present
  // inline error element next to the button — visible without DevTools.
  const errorEl = document.createElement('div');
  errorEl.className = 'drive-error';
  errorEl.setAttribute('data-testid', 'drive-error');
  errorEl.setAttribute('role', 'alert');
  errorEl.style.color = 'var(--danger)';
  errorEl.style.marginTop = '8px';
  errorEl.style.fontSize = '13px';
  errorEl.hidden = true;
  const showError = (msg: string): void => {
    errorEl.textContent = msg;
    errorEl.hidden = false;
    deps.notify?.(msg, 'error'); // keep the optional toast hook for tests
  };
  const clearError = (): void => {
    errorEl.textContent = '';
    errorEl.hidden = true;
  };
  if (drive.connected) {
    actionBtn.className = 'danger';
    actionBtn.textContent = 'Disconnect';
    actionBtn.setAttribute('data-testid', 'drive-disconnect-btn');
    actionBtn.addEventListener('click', () => {
      clearError();
      void (async () => {
        try {
          await driveDisconnect();
          // The Rust handler emits `drive-status-changed`; the status pill
          // and any future re-render will pick up the new state from there.
        } catch (e) {
          showError(`Failed to disconnect: ${(e as Error).message}`);
        }
      })();
    });
  } else {
    actionBtn.className = 'primary';
    actionBtn.textContent = 'Connect to Drive…'; // …
    actionBtn.setAttribute('data-testid', 'drive-connect-btn');
    actionBtn.addEventListener('click', () => {
      clearError();
      void (async () => {
        try {
          await driveConnect();
        } catch (e) {
          showError(`Failed to connect: ${(e as Error).message}`);
        }
      })();
    });
  }
  card.appendChild(actionBtn);
  card.appendChild(errorEl);
  section.appendChild(card);

  // ── Advanced (BYO OAuth client) ──────────────────────────────────────
  // <details>/<summary> matches the wireframe — collapsed by default so
  // first-time users see the simpler card-only surface. Per the
  // wireframes the Client Secret field shows under the same toggle, but
  // A8 wires only the `client_id` because that's what the Settings type
  // exposes; the secret lives in the keyring (B5) and is not a settings
  // field.
  const advanced = document.createElement('details');
  advanced.setAttribute('data-testid', 'drive-advanced-toggle');
  advanced.className = 'drive-advanced';
  const summary = document.createElement('summary');
  summary.textContent = drive.connected
    ? 'Advanced — custom OAuth client'
    : 'Advanced — use a custom OAuth client (corporate / BYO)';
  advanced.appendChild(summary);

  const cidRow = document.createElement('div');
  cidRow.className = 'row';
  const cidLabel = document.createElement('label');
  cidLabel.textContent = 'Client ID ';
  cidLabel.setAttribute('for', 'drive-byo-client-id');
  cidLabel.style.marginTop = '8px';
  const cidInput = document.createElement('input');
  cidInput.id = 'drive-byo-client-id';
  cidInput.setAttribute('data-testid', 'drive-byo-client-id');
  cidInput.type = 'text';
  cidInput.className = 'mono';
  cidInput.placeholder = '123456789-abcde.apps.googleusercontent.com';
  cidInput.value = drive.custom_oauth_client_id ?? '';
  cidRow.append(cidLabel, cidInput);
  advanced.appendChild(cidRow);

  // Debounced persist — mirrors the profile-name pattern in Settings.ts.
  // Read live from the input every fire so coalesced edits keep the
  // latest value. An empty string maps to `null` so a Settings TOML
  // round-trip writes the field absent rather than as an empty string.
  let timer: ReturnType<typeof setTimeout> | undefined;
  cidInput.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const next = cidInput.value.trim();
      settings.cloud.drive.custom_oauth_client_id = next === '' ? null : next;
      void deps.saveSettings(settings);
    }, BYO_DEBOUNCE_MS);
  });

  const help = document.createElement('p');
  help.className = 'help';
  help.textContent = drive.connected
    ? 'Changes apply on next reconnect.'
    : 'Useful for organizations using Internal OAuth on a Google Workspace project.';
  advanced.appendChild(help);

  section.appendChild(advanced);

  root.appendChild(section);
}
