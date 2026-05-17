/**
 * OpenRemoteDialog — wireframe 02.
 *
 * Three-state SSH open dialog:
 *
 *   - State A "host-entry" — user types `user@host[:port]`. A `<datalist>`
 *     of recently-used hosts (built once at mount from the Recents
 *     snapshot, ssh entries only, deduplicated) backs the input's
 *     autocomplete. Connect or Enter dispatches the first list_dir.
 *
 *   - State B "browsing" — breadcrumb + entries table. Double-click a
 *     directory to descend (re-fetches list_dir for that path), double-
 *     click a `.md` file to dismiss the dialog and hand the full
 *     `ssh://` URL to `onPick`. Breadcrumb segments navigate to any
 *     ancestor path by re-fetching list_dir for just that path — we
 *     intentionally do NOT cache tree state across navigation, because
 *     that's the stale-directory + race-with-out-of-band-edits footgun.
 *
 *   - State C "error" — the SSH transport's stderr message rendered
 *     verbatim inside a `<pre>` so newlines and shell formatting
 *     survive. A Back button returns to state A so the user can fix
 *     their host string and retry.
 *
 * Dismissal: Escape, the close (×) button, or a successful file pick.
 *
 * The Rust side is the source of truth for SSH URL grammar — we don't
 * pre-validate the host string; if it's malformed the strict parser
 * inside `ssh_list_dir` will reject it and we surface its stderr
 * verbatim in state C.
 */
import { ipc as defaultIpc } from '../ipc';
import type { DirEntry, Ipc } from '../ipc';

export interface OpenRemoteDialogProps {
  /** Root element the overlay is appended to. Typically `document.body`. */
  root: HTMLElement;
  /** Called with the full `ssh://` URL when the user double-clicks a
   *  markdown file. The dialog is dismissed BEFORE this fires so the caller
   *  can mount whatever follows (e.g. ipc.sshOpenUrl + Workspace.refresh)
   *  without the modal still on screen. */
  onPick: (url: string) => void;
  /** Optional autocomplete source override. When omitted, the dialog
   *  builds the suggestion set itself by reading `ipc.listRecents()` once
   *  at mount and pulling the deduplicated `user@host[:port]` substring
   *  from each `kind: 'ssh'` entry. Tests pass a fixture function so the
   *  Recents IPC doesn't have to be stubbed in every spec. */
  hostAutocompleteSource?: () => Promise<string[]>;
  /** Optional ipc override. Production callers omit this and get the
   *  singleton; tests can pass a fake so the assertion target is local
   *  to the test scope. */
  ipc?: Ipc;
}

interface State {
  kind: 'host-entry' | 'browsing' | 'error';
  suggestions?: string[];
  url?: string;
  entries?: DirEntry[];
  message?: string;
  /**
   * Index of the currently-focused row in `entries`. Used for keyboard
   * navigation while the dialog is in the browsing state. Resets to 0
   * on every directory change (re-render of the entries table) so the
   * user always starts at the top of a freshly-listed folder.
   */
  focused?: number;
}

export interface OpenRemoteDialogHandle {
  /** Programmatic dismissal — used by the host event-listener path so
   *  reopening the same dialog from a menu click does not stack. */
  close: () => void;
}

export function mountOpenRemoteDialog(
  props: OpenRemoteDialogProps,
): OpenRemoteDialogHandle {
  const ipc = props.ipc ?? defaultIpc;
  const overlay = document.createElement('div');
  overlay.className = 'open-remote-overlay modal-overlay';
  overlay.setAttribute('data-testid', 'open-remote-dialog');
  // B5: spec 22 polls `dialog.getAttribute('data-state')` for the wireframe-02
  // tri-state lifecycle (host-entry → browsing → error). Seeded with
  // the initial render's state.kind; updated inside `render()` before
  // each state transition so the polling waitUntil resolves promptly.
  overlay.setAttribute('data-state', 'host-entry');
  overlay.innerHTML = `
    <div class="open-remote-panel modal-card" role="dialog" aria-modal="true" aria-label="Open from remote">
      <header>
        <h2>Open from remote</h2>
        <button class="dialog-close" type="button" aria-label="Close">×</button>
      </header>
      <section class="dialog-body"></section>
    </div>
  `;
  props.root.appendChild(overlay);
  const body = overlay.querySelector('.dialog-body') as HTMLElement;

  // Mutable state — every render is a full repaint of the body region.
  // The intentionally small surface (host-entry / browsing / error)
  // makes a fancier diff loop unnecessary.
  let state: State = { kind: 'host-entry', suggestions: [] };

  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);

  overlay.querySelector('.dialog-close')?.addEventListener('click', close);

  function render(): void {
    // Mirror state.kind onto the overlay so spec 22's
    // `dialog.getAttribute('data-state')` poll resolves as soon as the
    // dialog transitions. Order matters: set the attribute BEFORE
    // rendering the body content so any synchronous spec poll that fires
    // right after the kind change picks up the right state.
    overlay.setAttribute('data-state', state.kind);
    switch (state.kind) {
      case 'host-entry':
        renderHostEntry();
        return;
      case 'browsing':
        renderBrowsing();
        return;
      case 'error':
        renderError();
        return;
    }
  }

  function renderHostEntry(): void {
    const suggestions = state.suggestions ?? [];
    // B5: spec 22 selectors — `input#host` and `[data-action="connect"]`.
    // The `id="host"` co-exists with the `.host-input` class so the
    // existing unit-test selectors still resolve. The connect button
    // gains `data-action="connect"` alongside the legacy `.connect-btn`
    // class for the same reason.
    body.innerHTML = `
      <label class="host-label" for="host">Host
        <input id="host" class="host-input" type="text" placeholder="user@host[:port]"
               list="recent-hosts" autocomplete="off" />
        <datalist id="recent-hosts">
          ${suggestions
            .map((s) => `<option value="${escapeAttr(s)}"></option>`)
            .join('')}
        </datalist>
      </label>
      <div class="dialog-actions modal-actions">
        <button class="connect-btn primary" data-action="connect" type="button">Connect</button>
      </div>
    `;
    const input = body.querySelector('.host-input') as HTMLInputElement;
    // Defer focus past the current task so the overlay's append + jsdom
    // layout settle before the focus call. The pattern is the same the
    // AskpassModal uses.
    setTimeout(() => input?.focus(), 0);
    body.querySelector('.connect-btn')?.addEventListener('click', () => {
      void onConnect();
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void onConnect();
      }
    });
  }

  function renderBrowsing(): void {
    const url = state.url!;
    const entries = state.entries ?? [];
    const segs = breadcrumbsForUrl(url);
    // Clamp the focused index so a stale value from a previous listing
    // (or a state hand-off through error/back) can never index past the
    // current entries array. Defaults to 0 when undefined or out of range.
    const focused =
      typeof state.focused === 'number' &&
      state.focused >= 0 &&
      state.focused < entries.length
        ? state.focused
        : 0;
    // B5: spec 22 selectors — `[data-testid="remote-file-list"]` on the
    // entries table, `.file-row` class on every row, `data-md="true"` on
    // markdown files (so `[data-md]` filters them at-a-glance), and
    // `data-kind="parent"` on the synthetic `..` row when one is present.
    // The legacy `class="entries"`, `tr[role="option"]`, `[data-name]`,
    // and `[data-is-dir]` selectors stay alongside so existing
    // unit-test selectors keep matching.
    body.innerHTML = `
      <nav class="breadcrumb" aria-label="Path">
        ${segs
          .map(
            (seg, i) => `
          <button class="breadcrumb-segment" type="button" data-target-idx="${i}">${escapeHtml(seg.label)}</button>
          ${i < segs.length - 1 ? '<span class="separator">/</span>' : ''}
        `,
          )
          .join('')}
      </nav>
      <table class="entries" data-testid="remote-file-list" role="listbox" tabindex="0">
        <tbody>
          ${entries
            .map(
              (e, i) => {
                const isMd = !e.isDir && isMarkdownName(e.name);
                const isParent = e.isDir && e.name === '..';
                const kindAttr = isParent ? ' data-kind="parent"' : '';
                const mdAttr = isMd ? ' data-md="true"' : '';
                return `
            <tr role="option" class="file-row${i === focused ? ' focused' : ''}" data-name="${escapeAttr(e.name)}" data-is-dir="${e.isDir}"${kindAttr}${mdAttr}
                aria-selected="${i === focused ? 'true' : 'false'}">
              <td class="icon">${e.isDir ? '📁' : '📄'}</td>
              <td class="name">${escapeHtml(e.name)}</td>
              <td class="size">${e.isDir ? '' : formatSize(e.size)}</td>
            </tr>
          `;
              },
            )
            .join('')}
        </tbody>
      </table>
    `;
    body.querySelectorAll<HTMLButtonElement>('.breadcrumb-segment').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.targetIdx);
        const target = segs[idx]?.url;
        if (target) void browse(target);
      });
    });
    body.querySelectorAll<HTMLTableRowElement>('tr[role="option"]').forEach((row) => {
      row.addEventListener('dblclick', () => {
        const name = row.dataset.name ?? '';
        const isDir = row.dataset.isDir === 'true';
        if (isDir) {
          void browse(joinSshDirPath(url, name));
        } else if (isMarkdownName(name)) {
          // File pick: dismiss BEFORE calling onPick so the caller's
          // follow-up (sshOpenUrl, Workspace refresh) doesn't have to
          // chase a stray overlay still on screen.
          const target = joinSshFilePath(url, name);
          close();
          props.onPick(target);
        }
      });
    });

    // Keyboard navigation. Scoped to the entries table (which gets
    // tabindex=0 so it can receive focus) rather than `document` to
    // avoid intercepting keydown when the user is interacting with the
    // breadcrumb buttons. Arrow keys move row focus, Enter activates
    // the focused row (descend if directory, pick if a `.md` file),
    // Backspace pops the last breadcrumb segment (no-op at host root).
    const table = body.querySelector('table.entries') as HTMLTableElement | null;
    table?.addEventListener('keydown', (e) => {
      if (state.kind !== 'browsing') return;
      const ents = state.entries ?? [];
      if (ents.length === 0) return;
      const cur =
        typeof state.focused === 'number' &&
        state.focused >= 0 &&
        state.focused < ents.length
          ? state.focused
          : 0;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = Math.min(cur + 1, ents.length - 1);
        state = { ...state, focused: next };
        render();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = Math.max(cur - 1, 0);
        state = { ...state, focused: prev };
        render();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const row = ents[cur];
        if (!row) return;
        if (row.isDir) {
          void browse(joinSshDirPath(url, row.name));
        } else if (isMarkdownName(row.name)) {
          const target = joinSshFilePath(url, row.name);
          close();
          props.onPick(target);
        }
      } else if (e.key === 'Backspace') {
        // Backspace at host root has nowhere to go — leave as a no-op
        // rather than navigating away. Breadcrumb length > 1 means we
        // have at least one path component beyond the host segment.
        if (segs.length > 1) {
          e.preventDefault();
          const parent = segs[segs.length - 2]?.url;
          if (parent) void browse(parent);
        }
      }
    });
    // Auto-focus the table so the keyboard handler picks up keydown
    // events without the user having to click first. setTimeout matches
    // the host-input focus pattern (deferred past mount/append).
    setTimeout(() => table?.focus(), 0);
  }

  function renderError(): void {
    const msg = state.message ?? '';
    body.innerHTML = `
      <div class="dialog-error" data-testid="dialog-error">
        <pre>${escapeHtml(msg)}</pre>
        <div class="dialog-actions modal-actions">
          <button class="dialog-retry" type="button">Back</button>
        </div>
      </div>
    `;
    body.querySelector('.dialog-retry')?.addEventListener('click', () => {
      state = { kind: 'host-entry', suggestions: state.suggestions ?? [] };
      render();
    });
  }

  async function onConnect(): Promise<void> {
    const input = body.querySelector('.host-input') as HTMLInputElement | null;
    const raw = input?.value.trim() ?? '';
    if (!raw) return;
    // Build a list-dir URL that targets the host's root listing. The
    // strict URL grammar lives in mdviewer_core::ssh_url::parse on the
    // Rust side; this is just a string compose, not a validator.
    const url = `ssh://${raw}/`;
    await browse(url);
  }

  async function browse(url: string): Promise<void> {
    try {
      const entries = await ipc.sshListDir(url);
      // focused: 0 is intentional — every navigation lands the
      // selection at the top of the freshly-listed folder. Carrying a
      // stale focused index across directory changes would point at the
      // wrong row (or worse, an out-of-range index).
      state = { kind: 'browsing', url, entries, focused: 0 };
      render();
    } catch (e: unknown) {
      // Surface the SSH transport's verbatim error string (state C). The
      // dialog intentionally does NOT classify / re-word these — that's
      // the user-confusion footgun design Decision 5 warns about.
      state = { kind: 'error', message: errorMessage(e), suggestions: state.suggestions };
      render();
    }
  }

  // Mount-time autocomplete fetch. The plan rules: do this ONCE, never
  // per keystroke. Recents access touches the IPC layer; per-keystroke
  // fetch would round-trip on every character.
  void (async () => {
    const source =
      props.hostAutocompleteSource ??
      (async () => {
        try {
          const recents = await ipc.listRecents();
          // Filter to ssh entries first, then map each to its
          // user@host[:port] substring, then deduplicate via a Set so
          // multiple recents pointing at the same host collapse to one
          // suggestion.
          return Array.from(
            new Set(
              recents
                .filter((r) => r.kind === 'ssh')
                .map((r) => extractUserHostPort(r.path))
                .filter((s): s is string => s !== null),
            ),
          );
        } catch {
          // Recents IPC failed — fall back to an empty suggestion list
          // so the dialog still mounts. The user can still type a host.
          return [];
        }
      });
    const suggestions = await source();
    // Only update the host-entry state — a connect-during-fetch race
    // would otherwise clobber the freshly-rendered browsing view.
    if (state.kind === 'host-entry') {
      state = { kind: 'host-entry', suggestions };
      render();
    } else {
      // Stash the suggestions so a Back-from-error path can use them.
      state = { ...state, suggestions };
    }
  })();

  // Initial render before the autocomplete fetch resolves so the user
  // sees the host-input immediately (with an empty datalist).
  render();
  return { close };
}

// ---------------------------------------------------------------------------
// Helpers — kept module-private rather than exported. Each has a single
// caller inside this file; pulling them into a shared utils module would
// just spread the surface area for no gain.
// ---------------------------------------------------------------------------

/**
 * Pull the `user@host[:port]` substring out of a stored ssh:// URL. Returns
 * `null` when the string doesn't look like an ssh:// URL — defensive
 * because RecentEntry.kind === 'ssh' is the source of truth but the path
 * field is opaque. A malformed stored path is silently filtered out.
 */
function extractUserHostPort(sshUrl: string): string | null {
  const m = sshUrl.match(/^ssh:\/\/([^/]+)/);
  return m ? m[1] : null;
}

/**
 * Build the breadcrumb spine for a directory URL. The first segment is
 * the user@host[:port] (which navigates back to the host root); each
 * subsequent segment is a path component. Trailing slashes on the
 * descend URLs keep the wire format consistent with what the SSH
 * transport expects.
 */
function breadcrumbsForUrl(url: string): { label: string; url: string }[] {
  const match = url.match(/^ssh:\/\/([^/]+)(\/.*)$/);
  if (!match) return [];
  const [, hostport, path] = match;
  const segments = path.split('/').filter(Boolean);
  const result: { label: string; url: string }[] = [
    { label: hostport, url: `ssh://${hostport}/` },
  ];
  let acc = '';
  for (const seg of segments) {
    acc += '/' + seg;
    result.push({ label: seg, url: `ssh://${hostport}${acc}/` });
  }
  return result;
}

/**
 * Append a directory `name` to the current `ssh://` directory URL,
 * keeping the trailing slash convention so subsequent list_dir calls
 * keep their semantics.
 */
function joinSshDirPath(currentUrl: string, name: string): string {
  const base = currentUrl.endsWith('/') ? currentUrl : currentUrl + '/';
  return base + name + '/';
}

/**
 * Like joinSshDirPath but for a file `name` (no trailing slash). The two
 * are split rather than a single "append" so the difference between
 * directory navigation and file pick stays explicit at the call site.
 */
function joinSshFilePath(currentUrl: string, name: string): string {
  const base = currentUrl.endsWith('/') ? currentUrl : currentUrl + '/';
  return base + name;
}

function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
