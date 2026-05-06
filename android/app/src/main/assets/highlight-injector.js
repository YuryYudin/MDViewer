// highlight-injector.js — runs inside the Android WebView. Sole purpose:
// translate a JSON array of anchor ranges (posted by HighlightInjector
// via `evaluateJavascript`) into in-document `<span class="anchored">`
// wrappers around the matching `[data-src-offset]` carriers.
//
// Why an IIFE with an "already installed" guard:
//   - The host loads the same template every recomposition (the
//     `loadDataWithBaseURL` in MarkdownWebView.update fires on every
//     `update` lambda invocation). Without the guard, each reload would
//     redefine `window.applyAnchors` — usually harmless but a recipe
//     for confusing debugging if the next Phase D iteration changes
//     the JS contract underneath a stale page.
//
// Why we wrap by overlap (not by exact equality of offsets):
//   - `mdviewer-core::document::render_markdown` emits `data-src-offset`
//     spans whose ranges are syntax-tree-driven (one per inline emit).
//     A user's selection — and therefore the anchor we're highlighting
//     — is unrelated to the carrier boundaries, so the resolved range
//     [srcStart, srcEnd) typically straddles multiple carriers. Wrapping
//     every carrier whose own range overlaps the anchor range is the
//     simplest correct strategy; the v1 wrapper is allowed to be
//     slightly wider than the user's pixel-perfect selection.
//
// Why we don't use `Range.surroundContents`:
//   - It throws `InvalidStateError` when the start and end of the
//     selection are in different elements — exactly the case we hit
//     whenever the highlight straddles a span boundary. Walking the
//     `[data-src-offset]` carriers and wrapping each one in turn
//     sidesteps that limitation entirely.
//
// Idempotency contract:
//   - Every call unwraps every existing `.anchored` wrapper before
//     applying the new payload. JVM callers therefore can resend the
//     full thread list on each change (resolved toggle, new thread,
//     etc.) without diffing — the JS recomputes the DOM from the
//     source spans every time.
//
// Failure mode:
//   - The function tolerates a malformed payload by catching the
//     JSON.parse exception and clearing existing wrappers without
//     installing new ones. Throwing out of `applyAnchors` would
//     bubble back to the JVM as an `evaluateJavascript` runtime error
//     swallowed by the WebView; clearing-on-error keeps the document
//     in a consistent state.
(function () {
    'use strict';
    if (window.__mdvHighlightInjectorInstalled) return;
    window.__mdvHighlightInjectorInstalled = true;

    /**
     * Remove every existing `.anchored` wrapper from the document,
     * leaving the inner spans (the `[data-src-offset]` carriers) in
     * place exactly where they were before the previous applyAnchors
     * call inserted the wrappers around them.
     *
     * Why parent.normalize() at the end:
     *   - Unwrapping leaves potentially adjacent text nodes; normalize
     *     merges them so a subsequent re-wrap starts from a tidy DOM.
     *     Skipping the normalize is harmless functionally but causes
     *     the DOM to grow a fragmentation factor over many cycles.
     */
    function unwrapPrevious() {
        var wraps = document.querySelectorAll('span.anchored');
        for (var i = 0; i < wraps.length; i++) {
            var wrap = wraps[i];
            var parent = wrap.parentNode;
            if (!parent) continue;
            while (wrap.firstChild) {
                parent.insertBefore(wrap.firstChild, wrap);
            }
            parent.removeChild(wrap);
            parent.normalize();
        }
    }

    /**
     * Wrap every `[data-src-offset]` carrier whose own [start, end)
     * range overlaps the anchor's [srcStart, srcEnd) range in a fresh
     * `<span class="anchored" data-thread-id=... [data-resolved]>`.
     *
     * The carrier's own end offset is preferred from `data-src-end`;
     * if the carrier doesn't carry that attribute (older renderer or
     * edge case in the syntax-tree walker), fall back to the
     * carrier's text length added to its start offset. This mirrors
     * the resilience strategy in selection-bridge.js.
     */
    function wrapOverlapping(range) {
        var spans = document.querySelectorAll('[data-src-offset]');
        for (var i = 0; i < spans.length; i++) {
            var span = spans[i];
            var start = parseInt(span.getAttribute('data-src-offset'), 10);
            if (isNaN(start)) continue;
            var endAttr = span.getAttribute('data-src-end');
            var end = endAttr !== null ? parseInt(endAttr, 10) : NaN;
            if (isNaN(end)) {
                // Fall back to text-content length so the wrapper still
                // covers the carrier even when the renderer skipped
                // emitting data-src-end (defensive — current renderer
                // always emits both).
                var text = span.textContent || '';
                end = start + text.length;
            }
            // Half-open interval overlap test.
            if (end > range.srcStart && start < range.srcEnd) {
                var wrap = document.createElement('span');
                wrap.className = 'anchored';
                wrap.setAttribute('data-thread-id', range.threadId);
                if (range.resolved) {
                    wrap.setAttribute('data-resolved', 'true');
                }
                var parent = span.parentNode;
                if (parent) {
                    parent.insertBefore(wrap, span);
                    wrap.appendChild(span);
                }
            }
        }
    }

    /**
     * Public entry point invoked by HighlightInjector.inject from the
     * JVM via `WebView.evaluateJavascript`. The argument is a JSON
     * string (NOT a parsed object) because evaluateJavascript can only
     * pass primitives across the boundary.
     */
    window.applyAnchors = function (rangesJson) {
        unwrapPrevious();
        var ranges;
        try {
            ranges = JSON.parse(rangesJson);
        } catch (e) {
            // Malformed payload — leave the document with the cleared
            // wrappers and bail. Throwing here would surface as an
            // `evaluateJavascript` runtime error swallowed by the
            // WebView's renderer thread.
            return;
        }
        if (!Array.isArray(ranges)) return;
        for (var i = 0; i < ranges.length; i++) {
            wrapOverlapping(ranges[i]);
        }
    };
})();
