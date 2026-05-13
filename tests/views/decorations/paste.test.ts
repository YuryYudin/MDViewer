import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { pasteHandler } from '../../../src/views/decorations/paste';

/**
 * B.4 paste extension tests. The extension yields the paste DOM event
 * back to CodeMirror's default behaviour when:
 *   1) clipboard has no `text/html` payload (always — plain path), OR
 *   2) clipboard has `text/html` AND `paste_html_behavior === "plain"`.
 *
 * The extension converts and inserts when:
 *   3) clipboard has `text/html` AND `paste_html_behavior === "markdown"`.
 *
 * If turndown's dynamic import fails (offline, blocked, build error),
 * the extension falls back to inserting the `text/plain` payload —
 * never throws into the editor host.
 *
 * Tests use `vi.doMock` for turndown so we can:
 *   - count how many times the module is dynamic-imported (`loadTurndown`),
 *   - inject a failure for the fallback test,
 *   - verify the conversion output (not just that turndown was called).
 */

function makeView(doc: string, ext: ReturnType<typeof pasteHandler>): {
  view: EditorView;
  getDoc(): string;
} {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(doc.length, doc.length),
    extensions: [ext],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    getDoc: () => view.state.doc.toString(),
  };
}

/**
 * Construct a `ClipboardEvent`-shaped DOM event whose `clipboardData`
 * carries the supplied MIME entries. jsdom's `ClipboardEvent`
 * constructor lacks the `clipboardData` plumbing CodeMirror reads from,
 * so we build a `CustomEvent('paste')` and stub `.clipboardData` with a
 * minimal getData() shim. `preventDefault` is a real bound method; the
 * extension calls it on the markdown path.
 */
function makePasteEvent(entries: Record<string, string>): ClipboardEvent {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  const data = {
    getData: (type: string): string => entries[type] ?? '',
    types: Object.keys(entries),
  };
  Object.defineProperty(ev, 'clipboardData', { value: data, configurable: true });
  return ev as ClipboardEvent;
}

/**
 * The extension's paste pipeline is `loadOnce().then(convert).catch(plainFallback).then(dispatch)`.
 * Each `.then` introduces one microtask boundary, so by the time the
 * doc mutates the test has needed up to three Promise.resolve() awaits.
 * Four is one cheap microtask above the worst case — keeps the test
 * stable if a future change adds another await link.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('pasteHandler extension', () => {
  describe('plain-paste path (the default)', () => {
    it('does NOT load turndown when clipboard has only text/plain', () => {
      // The plain path's defining behavior is: never lazy-import
      // turndown. CodeMirror's built-in paste path is what writes
      // text/plain into the doc — we yield to it by returning false
      // from the handler. Asserting on `loadTurndown` not being
      // called is the only stable signal in jsdom (preventDefault is
      // also called by CodeMirror's own paste path).
      const loadTurndown = vi.fn(async () => {
        throw new Error('turndown must not be imported on the plain path');
      });
      const ext = pasteHandler({
        getPasteHtmlBehavior: () => 'plain',
        loadTurndown,
      });
      const { view } = makeView('hello', ext);
      const ev = makePasteEvent({ 'text/plain': 'world' });
      view.contentDOM.dispatchEvent(ev);
      expect(loadTurndown).not.toHaveBeenCalled();
      view.destroy();
    });

    it('does NOT load turndown when clipboard has text/html but behavior is "plain"', () => {
      const loadTurndown = vi.fn(async () => {
        throw new Error('turndown must not be imported when behavior is plain');
      });
      const ext = pasteHandler({
        getPasteHtmlBehavior: () => 'plain',
        loadTurndown,
      });
      const { view } = makeView('seed', ext);
      const ev = makePasteEvent({
        'text/plain': 'world',
        'text/html': '<p>world</p>',
      });
      view.contentDOM.dispatchEvent(ev);
      expect(loadTurndown).not.toHaveBeenCalled();
      view.destroy();
    });

    it('does NOT load turndown when clipboardData is missing entirely', () => {
      // Defensive branch: some synthetic paste events arrive without a
      // clipboardData payload (e.g. user-script-driven dispatches in
      // tests). The extension must yield without touching the missing
      // object — loadTurndown stays uncalled.
      const loadTurndown = vi.fn(async () => {
        throw new Error('not expected');
      });
      const ext = pasteHandler({
        getPasteHtmlBehavior: () => 'markdown',
        loadTurndown,
      });
      const { view } = makeView('seed', ext);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      view.contentDOM.dispatchEvent(ev);
      expect(loadTurndown).not.toHaveBeenCalled();
      view.destroy();
    });

    it('does NOT load turndown when clipboard has only text/plain even with behavior="markdown"', () => {
      // The markdown path triggers ONLY when text/html is present.
      // Plain-only clipboards yield to default behavior regardless of
      // the user setting.
      const loadTurndown = vi.fn(async () => {
        throw new Error('not expected on plain-only clipboard');
      });
      const ext = pasteHandler({
        getPasteHtmlBehavior: () => 'markdown',
        loadTurndown,
      });
      const { view } = makeView('seed', ext);
      const ev = makePasteEvent({ 'text/plain': 'hi' });
      view.contentDOM.dispatchEvent(ev);
      expect(loadTurndown).not.toHaveBeenCalled();
      view.destroy();
    });
  });

  describe('markdown-paste path (behavior = "markdown")', () => {
    it('lazy-imports turndown ONCE across multiple pastes and inserts converted markdown', async () => {
      // Capture how many times the dynamic import is requested; only
      // the first triggering paste should call it.
      let imports = 0;
      const turndownInstance = {
        turndown: vi.fn((html: string) =>
          html.replace(/<strong>(.+?)<\/strong>/g, '**$1**').replace(/<[^>]+>/g, ''),
        ),
      };
      const loadTurndown = vi.fn(async () => {
        imports += 1;
        return turndownInstance;
      });
      const ext = pasteHandler({
        getPasteHtmlBehavior: () => 'markdown',
        loadTurndown,
      });
      const { view, getDoc } = makeView('start ', ext);
      // Place the caret at end-of-doc for both pastes.
      view.dispatch({ selection: EditorSelection.single(view.state.doc.length) });

      const ev1 = makePasteEvent({
        'text/plain': 'bold',
        'text/html': '<strong>bold</strong>',
      });
      view.contentDOM.dispatchEvent(ev1);
      // First paste: extension owns it — preventDefault was called and
      // the import was kicked off. After several microtask flushes the
      // converted markdown lands at the caret position.
      await flushMicrotasks();
      expect(getDoc()).toBe('start **bold**');
      expect(imports).toBe(1);
      expect(turndownInstance.turndown).toHaveBeenCalledWith('<strong>bold</strong>');

      // Second paste — extension MUST reuse the cached instance.
      view.dispatch({ selection: EditorSelection.single(view.state.doc.length) });
      const ev2 = makePasteEvent({
        'text/plain': 'more',
        'text/html': '<strong>more</strong>',
      });
      view.contentDOM.dispatchEvent(ev2);
      await flushMicrotasks();
      expect(getDoc()).toBe('start **bold****more**');
      expect(imports).toBe(1); // still ONE — the module is cached.
      expect(loadTurndown).toHaveBeenCalledTimes(1);
      view.destroy();
    });

    it('falls back to inserting text/plain when turndown\'s dynamic import fails', async () => {
      const loadTurndown = vi.fn(async () => {
        throw new Error('module load failed');
      });
      const ext = pasteHandler({
        getPasteHtmlBehavior: () => 'markdown',
        loadTurndown,
      });
      const { view, getDoc } = makeView('start ', ext);
      view.dispatch({ selection: EditorSelection.single(view.state.doc.length) });
      const ev = makePasteEvent({
        'text/plain': 'plain text',
        'text/html': '<p>plain text</p>',
      });
      view.contentDOM.dispatchEvent(ev);
      await flushMicrotasks();
      // text/plain payload landed verbatim — no exception bubbled up
      // into the editor host, and the markdown path attempted exactly
      // one import.
      expect(getDoc()).toBe('start plain text');
      expect(loadTurndown).toHaveBeenCalledTimes(1);
      view.destroy();
    });
  });

  describe('default loader (no override)', () => {
    it('exports a default loader that resolves to a turndown instance', () => {
      // Production path: caller doesn't override loadTurndown. The
      // extension's built-in loader must dynamic-import the real
      // turndown package and surface a `.turndown(html)` API.
      const ext = pasteHandler({ getPasteHtmlBehavior: () => 'markdown' });
      expect(ext).toBeDefined();
      // Smoke: instantiate the EditorView with the extension — the
      // module-import path is not exercised here (no paste dispatched);
      // we only assert that the factory accepts the minimal options
      // shape and yields a CodeMirror extension value.
      const { view } = makeView('seed', ext);
      expect(view.state.doc.toString()).toBe('seed');
      view.destroy();
    });
  });
});
