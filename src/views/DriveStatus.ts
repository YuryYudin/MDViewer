/**
 * DriveStatus — small status-bar pill that reflects the current Drive
 * connection / sync state. Mounted inside Workspace's status region (A8).
 *
 * The pill is event-driven: a single `drive-status-changed` Tauri event
 * subscription updates the rendered text and `data-connected` /
 * `data-online` attributes whenever the Rust side emits a fresh
 * `DriveStatus`. The Rust handlers in main.rs emit the event after every
 * `drive_connect` / `drive_disconnect` so the pill stays in sync without
 * polling.
 *
 * The initial render fires `drive_status` once via the typed IPC wrapper
 * so the pill has a value at boot. After that, the event subscription is
 * the source of truth.
 *
 * Returns an unsubscribe handle the caller can store on its disposer
 * list. In jsdom unit tests `@tauri-apps/api/event` is mocked, so the
 * import resolves to a stub that just records the listener without
 * touching native bridge code.
 */
import type { DriveStatus } from '../types-generated';

export function mountDriveStatus(host: HTMLElement): () => void {
  host.classList.add('drive-status-pill');
  host.setAttribute('data-test', 'drive-status-pill');
  // Initial state — no `DriveStatus` yet. Mark the pill empty so CSS can
  // hide it via `.drive-status-pill:empty` if the host wants to.
  host.dataset.connected = 'false';
  host.dataset.online = 'true';
  host.textContent = '';

  function render(s: DriveStatus): void {
    host.dataset.connected = String(s.connected);
    host.dataset.online = String(s.online);
    if (!s.connected) {
      host.textContent = 'Drive: not connected';
      return;
    }
    if (!s.online) {
      host.textContent = `Drive: offline (${s.pending_count} pending)`;
      return;
    }
    host.textContent =
      s.pending_count > 0 ? `Drive: ${s.pending_count} pending` : 'Drive: synced';
  }

  let unsub: () => void = () => undefined;
  let cancelled = false;

  // Subscribe to the event bus first so we never miss an update emitted
  // between the initial fetch and the listener install. tauri's event
  // import is async; loaded lazily so unit tests that don't hit this view
  // don't pull in the Tauri shim.
  void (async () => {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      if (cancelled) return;
      const u = await listen<DriveStatus>('drive-status-changed', (e) => render(e.payload));
      if (cancelled) {
        u();
        return;
      }
      unsub = u;
    } catch {
      // jsdom / unit tests without the Tauri runtime — fall through.
    }
  })();

  // Initial fetch. Done after subscribing so a status change racing with
  // boot doesn't get dropped. Best-effort — in jsdom the IPC throws and
  // the pill keeps its empty initial state.
  void (async () => {
    try {
      const { driveStatus } = await import('../ipc');
      const s = await driveStatus();
      if (!cancelled) render(s);
    } catch {
      // No backend in unit tests — leave the pill empty.
    }
  })();

  return () => {
    cancelled = true;
    unsub();
  };
}
