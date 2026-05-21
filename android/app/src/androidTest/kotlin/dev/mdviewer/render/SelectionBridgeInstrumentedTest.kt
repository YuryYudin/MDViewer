// ---------------------------------------------------------------------------
// SelectionBridgeInstrumentedTest — D2 integration: prove the JS bridge
// round-trips a JS-induced selection event into Kotlin with the correct
// canonical text + source offsets.
//
// Why this test must run on a real WebView (not Robolectric):
//   - `addJavascriptInterface` and the chrome-thread dispatch that
//     reflects on `@JavascriptInterface`-annotated methods are
//     unimplemented in Robolectric. The host-JVM SelectionBridgeTest
//     covers the parser and reconciler in isolation; this test covers
//     the wire — JS file load, listener attach, JSON.stringify, JNI
//     marshal, JVM parse, StateFlow publish.
//
// Why we drive the selection from JS rather than emulating a long-press:
//   - The test must remain deterministic across emulator densities and
//     OEM gesture-recognizer variants. `evaluateJavascript` lets us call
//     `window.getSelection().setBaseAndExtent(...)` and then dispatch a
//     synthetic `selectionchange` event, exercising the same code path
//     a real long-press would (modulo the ActionMode rect, which is
//     covered by the host-JVM unit test instead — see
//     `suppressing_action_mode_callback_forwards_rect_to_bridge`).
//
// CI-only: the connectedDebugAndroidTest variant requires an emulator.
// The build environment in this worktree has no emulator; CI runs the
// connected variant per the precedent set by B5/B6.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SelectionBridgeInstrumentedTest {

    @get:Rule val composeRule = createComposeRule()

    /**
     * Sample document with a single annotated span — pretends to be the
     * `<span data-src-offset="0" data-src-end="5">Hello</span>` shape
     * `mdviewer-core::render_markdown` emits for inline text events.
     */
    private val sampleHtml =
        """<p><span id="t" data-src-offset="0" data-src-end="5">Hello</span></p>"""

    @Test
    fun js_selection_event_reaches_kotlin_with_canonical_text_and_offsets() {
        val bridge = SelectionBridge()

        // Capture the WebView from the Compose tree so we can drive
        // evaluateJavascript() against it after the page settles.
        var webView: WebView? = null
        composeRule.setContent {
            CaptureWebView(onCaptured = { webView = it }) {
                MarkdownWebView(
                    html = sampleHtml,
                    theme = HtmlTheme.Light,
                    bridge = bridge,
                )
            }
        }
        composeRule.waitForIdle()

        // Wait for the WebView to mount + the page to load before driving
        // JS. The asset loader resolves selection-bridge.js asynchronously;
        // a too-early evaluateJavascript would race the IIFE.
        composeRule.waitUntil(timeoutMillis = 5_000) {
            webView != null
        }
        // Give the bridge IIFE a beat to attach its selectionchange
        // listener after the page's defer-loaded script executes.
        composeRule.waitUntil(timeoutMillis = 5_000) {
            // Ping the page: if the bridge has installed, the global flag
            // is set. We poll evaluateJavascript with a tiny timeout.
            var settled = false
            composeRule.runOnUiThread {
                webView?.evaluateJavascript(
                    "(window.__mdvSelectionBridgeInstalled === true).toString()",
                ) { result -> settled = result?.contains("true") == true }
            }
            // The result callback fires on a background thread; give it a
            // moment by yielding the test thread before the next poll.
            Thread.sleep(50)
            settled
        }

        // Drive a JS selection: stretch the Range across the annotated
        // span and dispatch the synthetic event. The bridge's IIFE listens
        // for `selectionchange` on the document, so dispatching it on the
        // document is the simulated long-press.
        composeRule.runOnUiThread {
            webView?.evaluateJavascript(
                """
                (function() {
                    var span = document.getElementById('t');
                    var range = document.createRange();
                    range.setStart(span.firstChild, 0);
                    range.setEnd(span.firstChild, 5);
                    var sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.dispatchEvent(new Event('selectionchange'));
                })();
                """.trimIndent(),
                null,
            )
        }

        // Wait for the bridge state to flip to Updated. 5s is generous;
        // the JNI hop typically completes in <50ms.
        val event = runBlocking {
            withTimeout(5_000) {
                bridge.state.first { it is SelectionEvent.Updated }
            }
        } as SelectionEvent.Updated

        assertEquals("Hello", event.selection.text)
        assertEquals(0, event.selection.srcStart)
        assertEquals(5, event.selection.srcEnd)
    }

    /**
     * v0.4.19 regression guard. A partial selection WITHIN a single
     * data-src-* span must produce precise source offsets — not the
     * span's own start/end. Reproduces the v0.4.18 anchor-coverage bug
     * where a comment posted on three selected words ended up anchored
     * to the entire enclosing sentence span because the JS bridge was
     * reading data-src-offset/data-src-end instead of combining them
     * with range.startOffset/range.endOffset.
     *
     * Setup: span covers source positions 100..122 with text
     * "InThisPostWellExplore!" (22 chars, matching the source range
     * 1:1 — text content length = data-src-end - data-src-offset).
     * Select chars 11..16 inside the text node, which is "ellEx"
     * (i.e. tail of "Well" + head of "Explore"). The selection's text
     * length distinguishes it from any whole-span result, and both
     * offsets (111 and 116) differ from the span boundaries (100 and
     * 122) — so the old whole-span arithmetic would have produced
     * 100/122 (or text "InThisPostWellExplore!") and this test would
     * have caught the regression.
     */
    @Test
    fun partial_selection_within_span_yields_precise_source_offsets() {
        val bridge = SelectionBridge()
        val partialHtml = """
            <p><span id="t" data-src-offset="100" data-src-end="122">InThisPostWellExplore!</span></p>
        """.trimIndent()

        var webView: WebView? = null
        composeRule.setContent {
            CaptureWebView(onCaptured = { webView = it }) {
                MarkdownWebView(
                    html = partialHtml,
                    theme = HtmlTheme.Light,
                    bridge = bridge,
                )
            }
        }
        composeRule.waitForIdle()
        composeRule.waitUntil(timeoutMillis = 5_000) { webView != null }
        composeRule.waitUntil(timeoutMillis = 5_000) {
            var settled = false
            composeRule.runOnUiThread {
                webView?.evaluateJavascript(
                    "(window.__mdvSelectionBridgeInstalled === true).toString()",
                ) { result -> settled = result?.contains("true") == true }
            }
            Thread.sleep(50)
            settled
        }

        composeRule.runOnUiThread {
            webView?.evaluateJavascript(
                """
                (function() {
                    var span = document.getElementById('t');
                    var range = document.createRange();
                    // Select chars 11..16 inside "InThisPostWellExplore!" —
                    // indices i=11..15 inclusive (end is exclusive) yield
                    // "ellEx" (the tail of "Well" + the head of "Explore").
                    range.setStart(span.firstChild, 11);
                    range.setEnd(span.firstChild, 16);
                    var sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    document.dispatchEvent(new Event('selectionchange'));
                })();
                """.trimIndent(),
                null,
            )
        }

        val event = runBlocking {
            withTimeout(5_000) {
                bridge.state.first { it is SelectionEvent.Updated }
            }
        } as SelectionEvent.Updated

        // The bridge should report the PRECISE source range, not the
        // span's full 100..122 envelope. Both offsets differ from the
        // span boundaries so the OLD whole-span arithmetic would have
        // produced 100/122 and this assertion would have failed.
        assertEquals(111, event.selection.srcStart)
        assertEquals(116, event.selection.srcEnd)
        assertEquals("ellEx", event.selection.text)
    }
}

/**
 * Compose helper: walks up from `LocalView` looking for the first
 * descendant [WebView] and reports it back to the test. We attach the
 * effect after the AndroidView mounts so the lookup runs once the
 * tree is laid out.
 */
@Composable
private fun CaptureWebView(
    onCaptured: (WebView) -> Unit,
    content: @Composable () -> Unit,
) {
    val rootView = LocalView.current
    LaunchedEffect(rootView) {
        // Crude tree walk; the test tree only has one WebView so the
        // first match is the right one.
        var found: WebView? = null
        fun walk(v: android.view.View) {
            if (found != null) return
            if (v is WebView) {
                found = v
                return
            }
            if (v is android.view.ViewGroup) {
                for (i in 0 until v.childCount) walk(v.getChildAt(i))
            }
        }
        // Loop until the WebView appears (AndroidView mounts async).
        repeat(50) {
            walk(rootView)
            if (found != null) return@repeat
            kotlinx.coroutines.delay(100)
        }
        found?.let(onCaptured)
    }
    content()
}
