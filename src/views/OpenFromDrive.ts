import { driveOpenUrl } from '../ipc';

/**
 * Wireframe-04 "Open from Drive" modal.
 *
 * Mounts on demand from the File → Open from Drive menu (and from any
 * `mdviewer:open-from-drive` CustomEvent). The modal owns its own DOM
 * lifecycle: created on mount, removed on close. Same pattern as the
 * Settings overlay in `main.ts` — there is no global singleton.
 *
 * The TS-side regex is *only* an input affordance — it gates the Open
 * button so the user gets immediate feedback, but the canonical parser
 * lives in Rust (`parse_drive_url` behind `drive_open_url`). On submit we
 * forward the raw trimmed URL and let Rust be the source of truth for
 * which URL shapes are valid; the regex is intentionally permissive
 * (any `*.google.com/*` host) so we don't reject URLs the Rust side
 * could actually parse.
 */
const URL_RE = /^https:\/\/(?:[^./]+\.)*google\.com\//i;

const DEBOUNCE_MS = 80;

const HINT_EMPTY = 'Paste a Drive URL to a markdown file you have access to.';
const HINT_VALID = 'Looks good — click Open.';
const HINT_INVALID = "That doesn't look like a Google Drive URL.";

/**
 * Mount the Open-from-Drive modal under `parent` (defaults to `<body>`)
 * and return a `close()` callback the caller can invoke to dismiss it
 * programmatically. The modal also closes itself on Esc, Cancel, the
 * overlay-backdrop click, and a successful `drive_open_url` round-trip.
 */
export function mountOpenFromDrive(parent: HTMLElement = document.body): () => void {
  // The overlay IS the click-out target; clicking the inner card does NOT
  // close the modal. We compare event.target === overlay so child clicks
  // bubbling up are safely ignored.
  const overlay = document.createElement('div');
  overlay.className = 'drive-modal modal-overlay';

  const card = document.createElement('div');
  card.className = 'modal-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Open from Drive');
  overlay.appendChild(card);

  const heading = document.createElement('h2');
  heading.textContent = 'Open from Google Drive';
  card.appendChild(heading);

  const intro = document.createElement('p');
  intro.className = 'modal-intro';
  intro.textContent =
    'Paste a Drive URL or file ID. The file must be a markdown (.md) document.';
  card.appendChild(intro);

  const label = document.createElement('label');
  label.className = 'modal-field';
  label.textContent = 'Drive URL';
  card.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.dataset.testid = 'drive-url-input';
  input.placeholder = 'https://drive.google.com/file/d/.../view';
  label.appendChild(input);

  const hint = document.createElement('p');
  hint.className = 'modal-hint';
  hint.dataset.testid = 'drive-url-hint';
  hint.dataset.state = 'empty';
  hint.textContent = HINT_EMPTY;
  card.appendChild(hint);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  card.appendChild(actions);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.dataset.testid = 'drive-modal-cancel';
  cancelBtn.textContent = 'Cancel';
  actions.appendChild(cancelBtn);

  const openBtn = document.createElement('button');
  openBtn.type = 'submit';
  openBtn.dataset.testid = 'drive-modal-open';
  openBtn.textContent = 'Open';
  openBtn.disabled = true;
  actions.appendChild(openBtn);

  parent.appendChild(overlay);

  // The debounce coalesces a burst of keystrokes into one regex check so
  // the Open button doesn't flicker enabled/disabled mid-paste. The
  // wireframe shows a single one-keystroke-of-latency update.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const setHintState = (state: 'empty' | 'valid' | 'invalid', text: string): void => {
    hint.dataset.state = state;
    hint.textContent = text;
  };
  input.addEventListener('input', () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      const v = input.value.trim();
      if (!v) {
        openBtn.disabled = true;
        setHintState('empty', HINT_EMPTY);
      } else if (URL_RE.test(v)) {
        openBtn.disabled = false;
        setHintState('valid', HINT_VALID);
      } else {
        openBtn.disabled = true;
        setHintState('invalid', HINT_INVALID);
      }
    }, DEBOUNCE_MS);
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const close = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };

  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);

  // Click-out: only the overlay backdrop (not its descendants) dismisses.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  openBtn.addEventListener('click', () => {
    // Disable while in flight so a double-click doesn't double-submit.
    openBtn.disabled = true;
    void (async () => {
      try {
        await driveOpenUrl(input.value.trim());
        close();
      } catch (e) {
        // Backend rejected the URL (parse_drive_url, network, permissions,
        // etc.). Surface the message inline and re-enable Open so the user
        // can edit and retry — explicitly do NOT auto-close on error.
        const msg = e instanceof Error ? e.message : String(e);
        setHintState('invalid', msg);
        openBtn.disabled = false;
      }
    })();
  });

  return close;
}
