import type { Ipc, Settings, BuildInfo } from '../ipc';

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
  view.appendChild(buildProfile(ipc, settings));
  view.appendChild(buildAppearance(ipc, settings));
  view.appendChild(buildEditor(ipc, settings));
  view.appendChild(buildComments(ipc, settings));
  view.appendChild(buildShortcuts(settings));
  view.appendChild(buildAdvanced(ipc, settings));
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

  return s;
}

function buildEditor(ipc: Ipc, settings: Settings): HTMLElement {
  const s = section('editor', 'Editor & viewer');

  const mode = labeledSelect(
    'Default open mode ',
    [
      ['view', 'View'],
      ['edit', 'Edit'],
    ],
    settings.editor.default_open_mode,
    { 'data-test': 'default-open-mode' },
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
    settings.editor.auto_save_debounce_ms = parseInt(debounceMs.input.value, 10);
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

  // Sync provider — disabled in v1 (design non-goal). The pill makes the
  // deferral visible inline so users don't think it's a bug.
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

function buildAbout(info: BuildInfo): HTMLElement {
  const s = section('about', 'About');
  const version = document.createElement('p');
  version.setAttribute('data-test', 'about-version');
  version.textContent = `MDViewer ${info.version}`;
  const commit = document.createElement('p');
  commit.setAttribute('data-test', 'about-commit');
  commit.textContent = `Build ${info.commit_hash}`;
  s.append(version, commit);
  return s;
}
