// selection-bridge.js — runs inside the Android WebView. Sole purpose:
// translate two browser events (`selectionchange` + click on a thread span)
// into typed JSON messages forwarded to the JVM via the
// `MdvSelection.onMessage` `@JavascriptInterface`.
//
// Why an IIFE with a "already installed" guard:
//   - The host loads the same template every recomposition (the
//     `loadDataWithBaseURL` in MarkdownWebView.update fires on every
//     `update` lambda invocation). Without the guard, each reload would
//     attach another listener on the document, multiplying outbound
//     messages by the recomposition count.
//
// Why `data-src-end` (not `data-src-offset` of the next element):
//   - `mdviewer-core::document::render_markdown` writes both attributes
//     on every text-bearing inline carrier, scoped to the carrier's own
//     byte range in the source. Treating the end offset as the carrier's
//     own `data-src-end` keeps the bridge agnostic of sibling layout.
//
// Why throttle at 50ms:
//   - The browser's selectionchange event fires per-pixel during a drag.
//     50ms (~20 Hz) is enough to keep the popover position responsive
//     while keeping JNI traffic low.
//
// Why we don't bridge mouse coordinates:
//   - The JVM uses ActionMode.Callback2.onGetContentRect to anchor the
//     popover. Re-deriving rects from JS would duplicate work and
//     desynchronize from the OS-supplied rect.
(function () {
    'use strict';
    if (window.__mdvSelectionBridgeInstalled) return;
    window.__mdvSelectionBridgeInstalled = true;

    var BRIDGE_NAME = 'MdvSelection';
    var THROTTLE_MS = 50;

    function post(msg) {
        var bridge = window[BRIDGE_NAME];
        if (bridge && typeof bridge.onMessage === 'function') {
            try {
                bridge.onMessage(JSON.stringify(msg));
            } catch (e) {
                // The JVM-side bridge never throws (see SelectionJsBridge),
                // but we still defend the renderer thread from a future
                // mistake on the JS side that could escape JSON.stringify
                // (cyclic refs, etc.).
            }
        }
    }

    function closestWithAttr(node, attr) {
        // `Range.startContainer` is often a Text node, which has no
        // `closest`. Walk up to the parent element and search from there.
        var el = node;
        if (el && el.nodeType === 3 /* TEXT_NODE */) el = el.parentElement;
        if (!el || typeof el.closest !== 'function') return null;
        return el.closest('[' + attr + ']');
    }

    var lastFire = 0;

    document.addEventListener('selectionchange', function () {
        var sel = window.getSelection && window.getSelection();
        if (!sel || sel.rangeCount === 0) {
            post({ kind: 'selectionCollapsed' });
            return;
        }
        if (sel.isCollapsed) {
            post({ kind: 'selectionCollapsed' });
            return;
        }

        // Throttle high-frequency selectionchange events. Run the throttle
        // BEFORE anchor lookup so we don't pay for closest() walks we'll
        // discard.
        var now = (window.performance && performance.now) ? performance.now() : Date.now();
        if (now - lastFire < THROTTLE_MS) return;
        lastFire = now;

        var range = sel.getRangeAt(0);
        var startSpan = closestWithAttr(range.startContainer, 'data-src-offset');
        // For the end of the selection prefer `data-src-end` (the exclusive
        // end byte offset emitted by mdviewer-core); fall back to
        // `data-src-offset` so a stray end-container outside an annotated
        // span still has *some* anchor before we declare the range
        // unanchorable.
        var endSpan = closestWithAttr(range.endContainer, 'data-src-end')
            || closestWithAttr(range.endContainer, 'data-src-offset');

        if (!startSpan || !endSpan) {
            post({ kind: 'selectionUnanchorable' });
            return;
        }

        // v0.4.19: combine the carrier span's data-src-offset with the
        // Range's intra-text-node offset to get the PRECISE source
        // position of the selection. The previous code used only the
        // span's data-src-offset / data-src-end, which expanded the
        // anchor to the entire span — visible to the user as a
        // highlight covering the whole sentence/paragraph instead of
        // the words they actually selected (reported on v0.4.18).
        //
        // The arithmetic is safe because mdviewer-core emits one
        // <span data-src-offset=S data-src-end=E> per pulldown-cmark
        // Text event, and that event's source range (S..E) covers the
        // text content 1:1 (formatting markers like ** or _ live
        // outside this span). So an N-char offset into the rendered
        // text node corresponds to source position S+N. For non-text
        // start/end containers (rare — usually only with image
        // captions or empty paragraphs) we fall back to the span
        // boundaries since startOffset is then a child index, not a
        // character index.
        var startSpanOffset = parseInt(startSpan.getAttribute('data-src-offset'), 10);
        var srcStart;
        if (range.startContainer.nodeType === 3 /* TEXT_NODE */) {
            srcStart = startSpanOffset + range.startOffset;
        } else {
            srcStart = startSpanOffset;
        }

        var srcEnd;
        if (range.endContainer.nodeType === 3 /* TEXT_NODE */) {
            var endSpanOffset = parseInt(endSpan.getAttribute('data-src-offset'), 10);
            srcEnd = endSpanOffset + range.endOffset;
        } else {
            var endAttr = endSpan.getAttribute('data-src-end');
            srcEnd = endAttr !== null
                ? parseInt(endAttr, 10)
                : parseInt(endSpan.getAttribute('data-src-offset'), 10);
        }

        if (isNaN(srcStart) || isNaN(srcEnd)) {
            post({ kind: 'selectionUnanchorable' });
            return;
        }

        // Bridge the selection's bounding-rect to the JVM in device pixels.
        // The original v0.4.x design relied on
        // ActionMode.Callback2.onGetContentRect, but our
        // SuppressingActionModeCallback returns false from
        // onCreateActionMode (to kill the system Copy/Share menu), which
        // prevents the action mode from starting at all — so
        // onGetContentRect never fires and the popover anchor stayed null.
        // getBoundingClientRect() runs against the live Range here, so the
        // rect is current with the throttled selectionchange event.
        // CSS pixels × devicePixelRatio = device pixels, matching the
        // coordinate space Compose uses for IntOffset on the overlay Box
        // that fills the same WebView bounds.
        var r = range.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;

        post({
            kind: 'selectionchange',
            text: sel.toString(),
            srcStart: srcStart,
            srcEnd: srcEnd,
            rectLeft: Math.round(r.left * dpr),
            rectTop: Math.round(r.top * dpr),
            rectWidth: Math.round(r.width * dpr),
            rectHeight: Math.round(r.height * dpr),
        });
    });

    // Capture-phase click listener so the highlight tap fires before any
    // page-level handler that might call stopPropagation(). The thread-id
    // span is emitted by mdviewer-core whenever the user has resolved a
    // comment thread to a particular range.
    document.addEventListener('click', function (e) {
        var target = e && e.target;
        if (!target || typeof target.closest !== 'function') return;
        var span = target.closest('[data-thread-id]');
        if (!span) return;
        var tid = span.getAttribute('data-thread-id');
        if (tid) post({ kind: 'highlightTap', threadId: tid });
    }, /* useCapture = */ true);
})();
