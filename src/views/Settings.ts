import type { Ipc, Settings, BuildInfo } from '../ipc';
import { mountDriveSettings } from './DriveSettings';

/**
 * Mount the full Settings view (wireframe 11). Renders 7 sections:
 * Profile, Appearance, Editor & viewer, Comments, Shortcuts (read-only),
 * Advanced, About. Every control reads/writes via `getSettings`/`setSettings`.
 *
 * Whole-snapshot pattern: every change reads the live `settings` object,
 * mutates the relevant slice, then calls `setSettings(settings)` with the
 * full object. The Rust `set_settings` handler does
 * `update(|s| *s = settings)` — partial diffs would silently drop fields.
 *
 * Theme changes apply to the DOM immediately (toggling `body.theme-dark`
 * + writing the CSS font-size variable) so users see the effect without
 * waiting for the round-trip back from disk.
 *
 * Sync provider is rendered disabled with a "(planned)" pill — design
 * non-goal for v1. Shortcut remap is also a v1 non-goal: shortcuts render
 * as a read-only `<table>` so users can see the schema without an editor.
 */
export async function mountSettings(root: HTMLElement, ipc: Ipc): Promise<void> {
  const settings: Settings = await ipc.getSettings();
  const info: BuildInfo = await ipc.appInfo();
  root.replaceChildren();

  const view = document.createElement('section');
  view.setAttribute('data-view', 'settings');

  const close = document.createElement('button');
  close.setAttribute('data-action', 'close-settings');
  close.className = 'close-settings';
  close.textContent = 'Close';
  close.addEventListener('click', () => {
    view.dispatchEvent(new CustomEvent('mdviewer:close-settings', { bubbles: true }));
  });
  view.appendChild(close);

  view.appendChild(buildProfile(ipc, settings));
  view.appendChild(buildAppearance(ipc, settings));
  view.appendChild(buildEditor(ipc, settings));
  view.appendChild(buildComments(ipc, settings));
  view.appendChild(buildShortcuts(settings));
  view.appendChild(buildAdvanced(ipc, settings));
  // C5 (Phase 3): the Drive sub-section is now mounted unconditionally.
  // Phase 2's `if (settings.cloud?.drive?.feature_enabled)` guard kept
  // the half-built UI surface hidden while we built out OAuth, the
  // file-id resolver, the conflict diff, the CollabChip, and the detect
  // toast (A1–C4). With those landed and the default flipped to `true`
  // in `DriveSettings::default`, every fresh install sees the section.
  // The user-facing kill-switch lives in `src-tauri/src/main.rs` —
  // `drive_connect` and `drive_open_url` short-circuit when the user has
  // explicitly written `cloud.drive.feature_enabled = false` to their
  // settings.toml. The Settings UI stays visible in either state so the
  // user can flip the kill-switch back without hand-editing TOML.
  mountDriveSettings(view, settings, {
    saveSettings: (next) => ipc.setSettings(next),
  });
  view.appendChild(buildAbout(info));
  root.appendChild(view);
}

function section(id: string, title: string): HTMLElement {
  const s = document.createElement('section');
  s.setAttribute('data-section', id);
  s.id = id;
  const h = document.createElement('h2');
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let h: ReturnType<typeof setTimeout> | undefined;
  return ((...args: unknown[]) => {
    if (h) clearTimeout(h);
    h = setTimeout(() => fn(...args), ms);
  }) as T;
}

function labeledInput(
  labelText: string,
  attrs: Record<string, string>,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'row';
  const lbl = document.createElement('label');
  lbl.textContent = labelText;
  const inp = document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) inp.setAttribute(k, v);
  row.append(lbl, inp);
  return { row, input: inp };
}

function labeledSelect(
  labelText: string,
  options: ReadonlyArray<readonly [string, string]>,
  current: string,
  attrs: Record<string, string> = {},
): { row: HTMLElement; select: HTMLSelectElement } {
  const row = document.createElement('div');
  row.className = 'row';
  const lbl = document.createElement('label');
  lbl.textContent = labelText;
  const sel = document.createElement('select');
  for (const [k, v] of Object.entries(attrs)) sel.setAttribute(k, v);
  for (const [val, txt] of options) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = txt;
    if (val === current) opt.selected = true;
    sel.appendChild(opt);
  }
  // WebKit (the Tauri WebView on macOS) doesn't always honor
  // `option.selected = true` set BEFORE appendChild — `select.value`
  // can return '' even when an option's `selected` property is true.
  // Setting `sel.value` AFTER all options exist forces a deterministic
  // selectedness pass. Vitest/jsdom doesn't have this quirk, so the
  // existing unit tests would never catch the divergence; the e2e
  // render-raw-toggle:170 assertion does.
  sel.value = current;
  row.append(lbl, sel);
  return { row, select: sel };
}

function labeledCheckbox(
  labelText: string,
  checked: boolean,
  attrs: Record<string, string> = {},
): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = 'row';
  const lbl = document.createElement('label');
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.checked = checked;
  for (const [k, v] of Object.entries(attrs)) inp.setAttribute(k, v);
  lbl.append(inp, document.createTextNode(' ' + labelText));
  row.appendChild(lbl);
  return { row, input: inp };
}

function buildProfile(ipc: Ipc, settings: Settings): HTMLElement {
  const s = section('profile', 'Profile');
  const name = labeledInput('Display name ', {
    type: 'text',
    'data-test': 'profile-name',
    value: settings.profile.display_name,
  });
  const color = labeledInput('Color ', {
    type: 'color',
    'data-test': 'profile-color',
    value: settings.profile.color || '#888888',
  });
  s.append(name.row, color.row);

  const persist = debounce(() => {
    settings.profile.display_name = name.input.value;
    settings.profile.color = color.input.value;
    void ipc.setSettings(settings);
  }, 250);
  name.input.addEventListener('input', persist);
  color.input.addEventListener('input', persist);
  // On blur, flush immediately (don't wait for the debounce trailing edge).
  const flush = (): void => {
    settings.profile.display_name = name.input.value;
    settings.profile.color = color.input.value;
    void ipc.setSettings(settings);
  };
  name.input.addEventListener('blur', flush);
  color.input.addEventListener('change', flush);
  return s;
}

function buildAppearance(ipc: Ipc, settings: Settings): HTMLElement {
  const s = section('appearance', 'Appearance');

  const theme = labeledSelect(
    'Theme ',
    [
      ['light', 'Light'],
      ['dark', 'Dark'],
      ['follow_system', 'Follow system'],
    ],
    settings.appearance.theme,
    { 'data-test': 'theme-select' },
  );
  s.appendChild(theme.row);
  theme.select.addEventListener('change', () => {
    const value = theme.select.value as Settings['appearance']['theme'];
    settings.appearance.theme = value;
    const dark =
      value === 'dark' ||
      (value === 'follow_system' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.body.classList.toggle('theme-dark', dark);
    document.body.classList.toggle('theme-follow-system', value === 'follow_system');
    void ipc.setSettings(settings);
  });

  // Dark variant — inert when Theme is "light", but always visible so
  // the user can preview the choice. Pure (default) = near-black warm
  // grey panels; Cool = slightly bluish neutral palette. Body class
  // `theme-cool` is what activates the override in theme.css.
  const darkVariant = labeledSelect(
    'Dark variant ',
    [
      ['pure', 'Pure black (default)'],
      ['cool', 'Cool neutral'],
    ],
    settings.appearance.dark_variant,
    { 'data-test': 'dark-variant' },
  );
  s.appendChild(darkVariant.row);
  darkVariant.select.addEventListener('change', () => {
    const value = darkVariant.select.value as Settings['appearance']['dark_variant'];
    settings.appearance.dark_variant = value;
    document.body.classList.toggle('theme-cool', value === 'cool');
    void ipc.setSettings(settings);
  });

  const font = labeledInput('Font size ', {
    type: 'range',
    min: '10',
    max: '24',
    'data-test': 'font-size',
    value: String(settings.appearance.font_size_px),
  });
  s.appendChild(font.row);
  font.input.addEventListener('input', () => {
    const px = parseInt(font.input.value, 10);
    settings.appearance.font_size_px = px;
    document.documentElement.style.setProperty('--font-size', `${px}px`);
    void ipc.setSettings(settings);
  });

  const lineHeight = labeledInput('Line height ', {
    type: 'range',
    min: '100',
    max: '200',
    'data-test': 'line-height',
    value: String(settings.appearance.line_height),
  });
  s.appendChild(lineHeight.row);
  lineHeight.input.addEventListener('input', () => {
    settings.appearance.line_height = parseInt(lineHeight.input.value, 10);
    void ipc.setSettings(settings);
  });

  const density = labeledSelect(
    'Density ',
    [
      ['comfortable', 'Comfortable'],
      ['compact', 'Compact'],
    ],
    settings.appearance.density,
    { 'data-test': 'density' },
  );
  s.appendChild(density.row);
  density.select.addEventListener('change', () => {
    settings.appearance.density = density.select.value;
    void ipc.setSettings(settings);
  });

  // On startup: clean (boot empty — current behavior, the safe default)
  // or restore (re-open the tabs that were open at last shutdown). The
  // restore path is backed by <data_dir>/session.json which Workspace
  // updates on every open/close, so the saved state survives crashes.
  const startup = labeledSelect(
    'On startup ',
    [
      ['clean', 'Start clean'],
      ['restore', 'Restore previous session'],
    ],
    settings.appearance.startup_mode,
    { 'data-test': 'startup-mode' },
  );
  s.appendChild(startup.row);
  startup.select.addEventListener('change', () => {
    settings.appearance.startup_mode = startup.select.value as Settings['appearance']['startup_mode'];
    void ipc.setSettings(settings);
  });

  return s;
}

function buildEditor(ipc: Ipc, settings: Settings): HTMLElement {
  const s = section('editor', 'Editor & viewer');

  // A.3 (Phase-A correction): the default-open-mode surface ships as a
  // real `<select data-testid="default-mode-select">` with the new
  // `{ "render" | "raw" }` value space (the post-WYSIWYG vocabulary).
  // The Rust-side deserializer rewrites legacy `"view" -> "render"` and
  // `"edit" -> "raw"` in-memory on read (see EditorSettings doc-comment
  // in types-generated.ts) so the value reaching us here is already in
  // the new space; we just pass it straight through to the rendered
  // <option selected>. The `data-testid` is load-bearing: the e2e spec
  // at render-raw-toggle.spec.ts:170 queries
  // `[data-testid="default-mode-select"]`.getValue(), and WebDriver
  // `.getValue()` only resolves against a real <select>/<input>/<textarea>.
  // The legacy `data-test="default-open-mode"` alias stays for additive
  // backwards-compat with the existing Vitest suite.
  const mode = labeledSelect(
    'Default open mode ',
    [
      ['render', 'Render'],
      ['raw', 'Raw'],
    ],
    settings.editor.default_open_mode,
    { 'data-test': 'default-open-mode', 'data-testid': 'default-mode-select' },
  );
  s.appendChild(mode.row);
  mode.select.addEventListener('change', () => {
    settings.editor.default_open_mode = mode.select.value;
    void ipc.setSettings(settings);
  });

  const auto = labeledCheckbox('Auto-save', settings.editor.auto_save, {
    'data-test': 'auto-save',
  });
  s.appendChild(auto.row);
  auto.input.addEventListener('change', () => {
    settings.editor.auto_save = auto.input.checked;
    void ipc.setSettings(settings);
  });

  const debounceMs = labeledInput('Auto-save debounce (ms) ', {
    type: 'number',
    min: '0',
    'data-test': 'auto-save-debounce',
    value: String(settings.editor.auto_save_debounce_ms),
  });
  s.appendChild(debounceMs.row);
  debounceMs.input.addEventListener('change', () => {
    // Guard against an empty input (NaN), which TOML serialization rejects.
    const ms = parseInt(debounceMs.input.value, 10);
    if (!Number.isFinite(ms)) return; // leave previous value
    settings.editor.auto_save_debounce_ms = ms;
    void ipc.setSettings(settings);
  });

  const ext = labeledSelect(
    'External change behavior ',
    [
      ['ask', 'Ask'],
      ['reload', 'Reload'],
      ['ignore', 'Ignore'],
    ],
    settings.editor.external_change_behavior,
    { 'data-test': 'external-change' },
  );
  s.appendChild(ext.row);
  ext.select.addEventListener('change', () => {
    settings.editor.external_change_behavior = ext.select
      .value as Settings['editor']['external_change_behavior'];
    void ipc.setSettings(settings);
  });

  const sh = labeledCheckbox('Syntax highlighting', settings.editor.syntax_highlighting, {
    'data-test': 'syntax-highlighting',
  });
  s.appendChild(sh.row);
  sh.input.addEventListener('change', () => {
    settings.editor.syntax_highlighting = sh.input.checked;
    void ipc.setSettings(settings);
  });

  const me = labeledCheckbox('Mermaid diagrams', settings.editor.mermaid_enabled, {
    'data-test': 'mermaid-enabled',
  });
  s.appendChild(me.row);
  me.input.addEventListener('change', () => {
    settings.editor.mermaid_enabled = me.input.checked;
    void ipc.setSettings(settings);
  });

  const ws = labeledCheckbox('Show whitespace', settings.editor.show_whitespace, {
    'data-test': 'show-whitespace',
  });
  s.appendChild(ws.row);
  ws.input.addEventListener('change', () => {
    settings.editor.show_whitespace = ws.input.checked;
    void ipc.setSettings(settings);
  });

  const wrap = labeledCheckbox('Word wrap', settings.editor.word_wrap, {
    'data-test': 'word-wrap',
  });
  s.appendChild(wrap.row);
  wrap.input.addEventListener('change', () => {
    settings.editor.word_wrap = wrap.input.checked;
    void ipc.setSettings(settings);
  });

  // A.9: Phase-1 render-readonly toggle. Bound to
  // `settings.editor.render_readonly`. The row description below is
  // copied VERBATIM from the Phase-1 release-notes line — do not
  // paraphrase. Tests assert the exact string so a copy edit here will
  // trip them.
  //
  // A.3 (Phase-A correction): the checkbox carries `id="render-readonly"`
  // because the e2e spec at render-raw-toggle.spec.ts:158 queries
  // `browser.$('#render-readonly').isSelected()`. WebDriver `.isSelected()`
  // resolves only against actual checkbox / radio / option semantics on
  // an element matched by a real CSS id selector — both the `id` AND
  // the `type="checkbox"` are load-bearing. The existing
  // `data-test="render-readonly"` alias on the row remains for the
  // Vitest suite (additive, optional per the design).
  const renderReadonly = labeledCheckbox(
    'Render documents read-only. Toggle off to enable in-place editing.',
    settings.editor.render_readonly,
    { 'data-test': 'render-readonly', id: 'render-readonly' },
  );
  s.appendChild(renderReadonly.row);
  renderReadonly.input.addEventListener('change', () => {
    settings.editor.render_readonly = renderReadonly.input.checked;
    void ipc.setSettings(settings);
  });

  // B.4: Phase-2 polish — three new EditorSettings keys surfaced as
  // controls in the Editor & Viewer card. The select/input shape
  // mirrors the pattern used by the default-open-mode and
  // external-change-behavior controls above.
  //
  // caret_in_block_behavior governs what happens when the caret lands
  // inside an atomic block widget (a code block, math block, image,
  // etc.). `collapse-widget` (default) collapses the widget to its
  // underlying source so the caret has somewhere to land; `always-raw`
  // auto-switches the whole tab to raw mode instead.
  const caretInBlock = labeledSelect(
    'Caret in block widgets ',
    [
      ['collapse-widget', 'Collapse widget to raw source'],
      ['always-raw', 'Switch tab to raw mode'],
    ],
    settings.editor.caret_in_block_behavior,
    { 'data-test': 'caret-in-block-behavior' },
  );
  s.appendChild(caretInBlock.row);
  caretInBlock.select.addEventListener('change', () => {
    settings.editor.caret_in_block_behavior = caretInBlock.select.value;
    void ipc.setSettings(settings);
  });

  // paste_html_behavior decides how a paste that carries `text/html` is
  // handled. `plain` (default) inserts the text/plain payload verbatim;
  // `markdown` lazy-loads turndown and converts HTML→markdown on the
  // first triggering paste of a session (see `decorations/paste.ts`).
  const pasteHtml = labeledSelect(
    'Paste from web ',
    [
      ['plain', 'Plain text (default)'],
      ['markdown', 'Convert HTML to markdown'],
    ],
    settings.editor.paste_html_behavior,
    { 'data-test': 'paste-html-behavior' },
  );
  s.appendChild(pasteHtml.row);
  pasteHtml.select.addEventListener('change', () => {
    settings.editor.paste_html_behavior = pasteHtml.select.value;
    void ipc.setSettings(settings);
  });

  // idle_reanchor_ms — the live editor re-anchors comment highlights
  // this often while the user is editing without saving. Lower = more
  // CPU churn but tighter caret-following; higher = visible drift.
  // The default (1500ms) was tuned on the wireframe-driven design
  // round. NaN input (empty field while the user is mid-edit) is
  // skipped — same pattern as auto_save_debounce_ms above.
  const idleReanchor = labeledInput('Idle re-anchor (ms) ', {
    type: 'number',
    min: '0',
    'data-test': 'idle-reanchor-ms',
    value: String(settings.editor.idle_reanchor_ms),
  });
  s.appendChild(idleReanchor.row);
  idleReanchor.input.addEventListener('change', () => {
    const ms = parseInt(idleReanchor.input.value, 10);
    if (!Number.isFinite(ms)) return;
    settings.editor.idle_reanchor_ms = ms;
    void ipc.setSettings(settings);
  });

  return s;
}

function buildComments(ipc: Ipc, settings: Settings): HTMLElement {
  const s = section('comments', 'Comments');

  const sr = labeledCheckbox('Show resolved threads', settings.comments.show_resolved, {
    'data-test': 'show-resolved',
  });
  s.appendChild(sr.row);
  sr.input.addEventListener('change', () => {
    settings.comments.show_resolved = sr.input.checked;
    void ipc.setSettings(settings);
  });

  const sp = labeledInput('Sidecar pattern ', {
    type: 'text',
    'data-test': 'sidecar-pattern',
    value: settings.comments.sidecar_pattern,
  });
  s.appendChild(sp.row);
  const persistSidecar = debounce(() => {
    settings.comments.sidecar_pattern = sp.input.value;
    void ipc.setSettings(settings);
  }, 250);
  sp.input.addEventListener('input', persistSidecar);

  const rc = labeledInput('Reattachment confidence ', {
    type: 'range',
    min: '0',
    max: '100',
    'data-test': 'reattachment-confidence',
    value: String(settings.comments.reattachment_confidence),
  });
  s.appendChild(rc.row);
  rc.input.addEventListener('input', () => {
    settings.comments.reattachment_confidence = parseInt(rc.input.value, 10);
    void ipc.setSettings(settings);
  });

  const am = labeledSelect(
    'Auto-merge ',
    [
      ['always', 'Always'],
      ['ask', 'Ask'],
      ['manual', 'Manual'],
    ],
    settings.comments.auto_merge,
    { 'data-test': 'auto-merge' },
  );
  s.appendChild(am.row);
  am.select.addEventListener('change', () => {
    settings.comments.auto_merge = am.select.value as Settings['comments']['auto_merge'];
    void ipc.setSettings(settings);
  });

  return s;
}

function buildShortcuts(settings: Settings): HTMLElement {
  // Read-only display — interactive remap is a v1 non-goal. The schema
  // ships in `settings.shortcuts` so users can see / edit it via TOML.
  const s = section('shortcuts', 'Shortcuts');
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Edit shortcuts in your settings.toml; in-app remap arrives in a later release.';
  s.appendChild(note);

  const table = document.createElement('table');
  table.setAttribute('data-test', 'shortcuts-table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const h of ['Action', 'Shortcut']) {
    const th = document.createElement('th');
    th.textContent = h;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const [action, combo] of Object.entries(settings.shortcuts)) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    td1.textContent = action;
    const td2 = document.createElement('td');
    const kbd = document.createElement('kbd');
    kbd.textContent = combo;
    td2.appendChild(kbd);
    tr.append(td1, td2);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  s.appendChild(table);
  return s;
}

function buildAdvanced(ipc: Ipc, settings: Settings): HTMLElement {
  const s = section('advanced', 'Advanced');

  // Sync provider lives in AdvancedSettings on the Rust side and the wireframe
  // groups it with the other inert/diagnostic controls. v1 non-goal — control
  // is rendered disabled with a (planned) pill so users see the deferral.
  const syncRow = document.createElement('div');
  syncRow.className = 'row';
  const syncLabel = document.createElement('label');
  syncLabel.textContent = 'Sync provider ';
  const syncSelect = document.createElement('select');
  syncSelect.setAttribute('data-test', 'sync-provider');
  syncSelect.disabled = true;
  const opt = document.createElement('option');
  opt.textContent = 'None — cloud sync ships in a later release';
  syncSelect.appendChild(opt);
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.setAttribute('data-test', 'sync-planned-pill');
  pill.textContent = '(planned)';
  syncLabel.append(syncSelect, pill);
  syncRow.appendChild(syncLabel);
  s.appendChild(syncRow);

  const verbose = labeledCheckbox('Verbose logs', settings.advanced.verbose_logs, {
    'data-test': 'verbose-logs',
  });
  s.appendChild(verbose.row);
  verbose.input.addEventListener('change', () => {
    settings.advanced.verbose_logs = verbose.input.checked;
    void ipc.setSettings(settings);
  });

  const devtools = document.createElement('button');
  devtools.setAttribute('data-test', 'open-devtools');
  devtools.textContent = 'Open DevTools';
  devtools.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:open-devtools'));
  });
  s.appendChild(devtools);

  const reset = document.createElement('button');
  reset.setAttribute('data-test', 'reset-defaults');
  reset.textContent = 'Reset to Defaults';
  reset.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:reset-settings'));
  });
  s.appendChild(reset);

  return s;
}

function buildAbout(info: BuildInfo | undefined): HTMLElement {
  const s = section('about', 'About');
  const version = document.createElement('p');
  version.setAttribute('data-test', 'about-version');
  version.textContent = `MDViewer ${info?.version ?? 'unknown'}`;
  const commit = document.createElement('p');
  commit.setAttribute('data-test', 'about-commit');
  commit.textContent = `Build ${info?.commit_hash ?? 'unknown'}`;
  s.append(version, commit);
  return s;
}
