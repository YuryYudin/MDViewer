import { mountLiveEditor } from '../../src/views/LiveEditor';
import type { ResolveOutcome, SaveOutcome, Thread } from '../../src/types-generated';
import { defaultSettings } from './defaultSettings';

// Path inside the served publicDir. We co-located the gallery sidecar
// in e2e/fixtures/ so both the .md and the .comments.json sit one
// fetch hop away.
const GALLERY_URL = '/render-gallery.md';
const SIDECAR_URL = '/render-gallery.md.comments.json';

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} failed: ${r.status}`);
  return r.text();
}

async function main() {
  const [source, sidecarText] = await Promise.all([
    fetchText(GALLERY_URL),
    fetchText(SIDECAR_URL),
  ]);
  const sidecar = JSON.parse(sidecarText) as { threads: Thread[] };

  const ipc = {
    async saveDocument(_tabId: string, _contents: string): Promise<SaveOutcome> {
      // Returns a benign `ok` outcome. auto_save is disabled in the
      // settings below, so this should never actually fire — but
      // returning `undefined` here would break callers that read
      // `outcome.kind`.
      return { kind: 'ok', etag: null };
    },
    async setDirty(_path: string, _dirty: boolean): Promise<void> {},
    async resolveAnchor(_tabId: string, anchor: Thread['anchor']): Promise<ResolveOutcome> {
      // Deterministic: echo the sidecar's stored offsets back.
      return { kind: 'resolved', start: anchor.start, end: anchor.end };
    },
  };

  const host = document.getElementById('editor-host')!;
  mountLiveEditor(host, ipc, {
    tabId: 'gallery',
    path: '/fixtures/render-gallery.md',
    source,
    settings: defaultSettings(),
    threads: sidecar.threads,
    // Design doc lists `initialMode: 'edit'`, but the live-editor type
    // `LiveEditorMode` is the post-Phase-1 union `'render' | 'raw'`.
    // The mount-args table elsewhere specifies
    // `settings.editor.default_open_mode = 'render'`, so the matching
    // typed value here is `'render'`. Deviation documented in C1's
    // completion notes (Rule 3 — design-doc typo from pre-WYSIWYG era).
    initialMode: 'render',
  });

  // Flip data-ready AFTER mountLiveEditor returns AND one rAF tick so
  // CSS has had one paint cycle to settle. Playwright awaits this flag
  // before any screenshot.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  document.body.setAttribute('data-ready', 'true');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('gallery boot failed', err);
});
