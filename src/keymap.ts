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
  | 'open_settings'
  | 'font_increase'
  | 'font_decrease'
  | 'font_reset'
  | 'print';

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

/**
 * Top-row shifted-symbol fold table.
 *
 * On a US Mac keyboard the user physically presses `Cmd+Shift+=` to send
 * "+" — the raw KeyboardEvent is `{shiftKey: true, key: "+"}`. Without
 * folding, that canonicalizes to `mod+shift++` and never matches the
 * `Mod+=` binding the user typed in Settings. The fix: when `ev.key` is one
 * of the shifted partners listed here, replace it with the unshifted
 * partner AND drop the `shift` token. The user's `Mod+=` binding then
 * matches both physical keypresses.
 *
 * Only the top-row symbol set is folded. Letter keys (`Mod+Shift+A`) and
 * symbols not in this table (e.g. arrow keys) keep their `shift` token so
 * users can still bind explicit `Mod+Shift+M` for actions like
 * resolve_thread.
 */
const SHIFTED_SYMBOL_FOLD: Readonly<Record<string, string>> = Object.freeze({
  '+': '=',
  _: '-',
  ')': '0',
  '(': '9',
  '*': '8',
  '&': '7',
  '^': '6',
  '%': '5',
  $: '4',
  '#': '3',
  '@': '2',
  '!': '1',
  '~': '`',
  '}': ']',
  '{': '[',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '|': '\\',
});

export function canonicalFromEvent(ev: KeyboardEvent): string {
  const parts: string[] = [];
  if (ev.metaKey || ev.ctrlKey) parts.push('mod');
  let shifted = ev.shiftKey;
  let key = ev.key;
  // Fold shifted top-row symbols back to their unshifted partners. The
  // shift token is dropped so `Cmd+Shift+=` (key="+") and the rare
  // `Cmd+=` (key="=", no shift) collapse onto the same canonical form.
  const folded = SHIFTED_SYMBOL_FOLD[key];
  if (folded !== undefined) {
    key = folded;
    shifted = false;
  }
  if (shifted) parts.push('shift');
  if (ev.altKey) parts.push('alt');
  parts.push(key.toLowerCase());
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
