/**
 * B.4 paste extension.
 *
 * Overrides the paste DOM event handler on the CodeMirror content
 * element so the editor can offer two paste modes, selected by the
 * `editor.paste_html_behavior` user setting:
 *
 *   - `"plain"` (default) — the extension yields to CodeMirror's
 *     built-in paste path, which inserts the `text/plain` payload
 *     verbatim. This is the historical behavior; no observable
 *     change for users who never flip the setting.
 *
 *   - `"markdown"` — when the clipboard offers a `text/html` payload,
 *     the extension lazy-imports turndown (only on the first triggering
 *     paste of a session — the module is cached afterwards), converts
 *     HTML → markdown, and inserts the result at the current selection.
 *     If the dynamic import fails (offline / blocked / build error), the
 *     extension silently falls back to inserting the `text/plain`
 *     payload — it must never throw into the editor host.
 *
 * The factory takes an `options.getPasteHtmlBehavior()` getter (callers
 * read live from the settings object so the user can flip the toggle
 * mid-session without remounting the extension) plus an optional
 * `options.loadTurndown()` override used by tests to inject a stub and
 * count how many times the import is requested.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

/**
 * Narrow type alias for the bit of turndown's API the extension uses.
 * Avoids pulling in the package's typings (turndown ships no .d.ts
 * file at the time of writing) and keeps the loader pluggable from
 * tests.
 */
export interface TurndownLike {
  turndown(html: string): string;
}

export interface PasteHandlerOptions {
  /**
   * Returns the currently-effective `editor.paste_html_behavior`.
   * Callers re-read from the live settings object inside the getter so
   * a flipped toggle takes effect on the very next paste without an
   * editor remount.
   */
  getPasteHtmlBehavior(): string;
  /**
   * Test-only override for the turndown loader. Production code omits
   * this and falls back to the default dynamic import below. The
   * `loadTurndown()` Promise is cached after its first resolution; a
   * cached failure is also remembered so we don't re-attempt the
   * import on every paste.
   */
  loadTurndown?(): Promise<TurndownLike>;
}

/**
 * Default loader: dynamic-import turndown and instantiate a singleton.
 * Errors propagate to the caller's catch block (which falls back to
 * text/plain).
 */
async function defaultLoadTurndown(): Promise<TurndownLike> {
  // The `@ts-expect-error` is load-bearing: turndown ships no .d.ts,
  // so TS rightfully complains about the missing module declaration.
  // We only consume `.turndown(html)`, which the narrow `TurndownLike`
  // alias above pins.
  // @ts-expect-error - turndown has no bundled type declarations
  const mod = await import('turndown');
  // turndown's ESM export shape is `{ default: TurndownService }`; the
  // CJS shape resolves to the constructor directly. Cover both.
  const Ctor = (mod.default ?? mod) as new (opts?: unknown) => TurndownLike;
  return new Ctor();
}

/**
 * The exported factory. Returns a CodeMirror `Extension` value that
 * wires a single `paste` DOM event handler onto the content element.
 *
 * Return semantics on the handler:
 *   - `false` (yield) — CodeMirror's built-in paste path runs, which
 *     inserts the `text/plain` payload verbatim. We yield whenever
 *     the html branch doesn't apply.
 *   - `true` (handled) — CodeMirror skips its built-in path. We use
 *     this on the markdown branch and call `preventDefault()` so the
 *     browser's contenteditable doesn't also paste the html into the
 *     DOM behind our back.
 */
export function pasteHandler(options: PasteHandlerOptions): Extension {
  const loader = options.loadTurndown ?? defaultLoadTurndown;
  // Cached Promise — second paste hits the cache and resolves
  // synchronously. A rejected cache means we tried and failed once;
  // we deliberately keep it (don't retry) to match the spec's
  // "lazy-imports turndown ONCE" expectation.
  let turndownPromise: Promise<TurndownLike> | undefined;

  function loadOnce(): Promise<TurndownLike> {
    if (!turndownPromise) {
      turndownPromise = loader();
    }
    return turndownPromise;
  }

  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView): boolean {
      const data = event.clipboardData;
      if (!data) return false;
      const html = data.getData('text/html');
      const plain = data.getData('text/plain');

      // Yield to default when:
      //   - clipboard has no html payload, OR
      //   - user setting selects the plain path.
      if (!html || options.getPasteHtmlBehavior() !== 'markdown') {
        return false;
      }

      // Markdown path: we own this paste. Prevent the browser from
      // also dropping the html into the contenteditable.
      event.preventDefault();
      // Snapshot the selection at dispatch time. If the user moves
      // the caret between now and the loader resolving, we still
      // replace the selection that triggered the paste.
      const ranges = view.state.selection.ranges.map((r) => ({
        from: r.from,
        to: r.to,
      }));

      void loadOnce()
        .then((td) => td.turndown(html))
        .catch(() => plain)
        .then((insert) => {
          // Replace each selection range with the converted text.
          // Multi-cursor support: the first range receives the
          // converted markdown; additional cursors collapse to
          // insertion points at the converted text's end (same shape
          // CodeMirror's default paste path uses).
          const changes = ranges.map((r) => ({
            from: r.from,
            to: r.to,
            insert,
          }));
          view.dispatch({
            changes,
            selection: {
              anchor: (ranges[0]?.from ?? 0) + insert.length,
            },
            scrollIntoView: true,
          });
        });

      return true;
    },
  });
}
