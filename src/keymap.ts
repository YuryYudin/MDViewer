import type { Settings } from './ipc';

// Action union must match A3's `default_shortcuts()` keys exactly.
export type Action =
  | 'open_file'
  | 'save_file'
  | 'toggle_edit'
  | 'close_tab'
  | 'comment_on_selection'
  | 'toggle_sidebar'
  | 'resolve_thread'
  | 'toggle_dark'
  | 'open_settings';

export type ActionHandler = (a: Action) => void;

/**
 * Install a global keydown listener that maps Settings.shortcuts entries to
 * action invocations. Returns a cleanup function that detaches the listener.
 */
export function installKeymap(settings: Settings, handler: ActionHandler): () => void {
  const lookup = new Map<string, Action>();
  for (const [action, combo] of Object.entries(settings.shortcuts)) {
    lookup.set(canonical(combo), action as Action);
  }
  const onKeyDown = (ev: KeyboardEvent) => {
    const key = canonicalFromEvent(ev);
    const action = lookup.get(key);
    if (action) {
      ev.preventDefault();
      handler(action);
    }
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/**
 * Both sides — the user-visible combo string from settings AND the
 * KeyboardEvent — are normalised to the SAME canonical form so lookups hit.
 *
 * Form: lowercase tokens, sorted alphabetically, joined by '+'.
 *
 * The platform-meta token "mod" maps to Cmd on macOS, Ctrl elsewhere; the
 * settings string uses "Mod" / "CmdOrCtrl" / "Cmd" / "Ctrl" / "Meta"
 * interchangeably and all resolve to the same canonical "mod".
 */
export function canonical(combo: string): string {
  return tokenize(combo)
    .map((t) => mapModToken(t))
    .sort()
    .join('+');
}

export function canonicalFromEvent(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.metaKey || ev.ctrlKey) parts.push('mod');
  if (ev.shiftKey) parts.push('shift');
  if (ev.altKey) parts.push('alt');
  parts.push(ev.key.toLowerCase());
  return parts.sort().join('+');
}

function tokenize(combo: string): string[] {
  return combo
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapModToken(t: string): string {
  if (t === 'cmdorctrl' || t === 'cmd' || t === 'ctrl' || t === 'meta') return 'mod';
  return t;
}
