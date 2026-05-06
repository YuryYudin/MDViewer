// ---------------------------------------------------------------------------
// HighlightInjectorInstrumentedTest — D3 integration: prove that
// HighlightInjector.inject(...) -> highlight-injector.js end-to-end
// produces the expected `.anchored` wrappers in the live WebView DOM.
//
// Why this test must run on a real WebView (not Robolectric):
//   - `evaluateJavascript` and the DOM walker the JS code exercises are
//     unimplemented in Robolectric. The host-JVM HighlightInjectorTest
//     covers the JSON wire format in isolation; this test covers the
//     wire — JS file load, `applyAnchors` definition, JSON parse, DOM
//     walk, span wrapping, and the resolved-attribute styling hook.
//
// Why we drive `applyAnchors` indirectly via HighlightInjector.inject
// (rather than calling `evaluateJavascript("window.applyAnchors(...)")`
// directly):
//   - The Kotlin-side encoder + escaper is what production callers use.
//     Bypassing it here would leave a gap where the JSON document
//     produced by `kotlinx.serialization` could drift out of sync with
//     what `highlight-injector.js` expects, but the test would still
//     pass because we'd be hand-rolling a payload the JS happens to
//     accept. Using the public entry point pins the wire end-to-end.
//
// CI-only: the connectedDebugAndroidTest variant requires an emulator.
// The build environment in this worktree has no emulator; CI runs the
// connected variant per the precedent set by B5/B6 and the D2 test.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import android.webkit.WebView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class HighlightInjectorInstrumentedTest {

    @get:Rule val composeRule = createComposeRule()

    /**
     * Sample document with two annotated spans straddling distinct byte
     * ranges. The shape mirrors what `mdviewer-core::render_markdown`
     * emits for inline text events: a `data-src-offset` start + a
     * `data-src-end` exclusive end on every text-bearing carrier.
     *
     * Range layout (zero-indexed, half-open):
     *   - `[0, 11)`  — "Hello world"
     *   - `[12, 19)` — "Goodbye"
     *
     * Each range overlaps a distinct anchor in the test payloads below.
     */
    private val sampleHtml =
        """<p><span id="t1" data-src-offset="0" data-src-end="11">Hello world</span></p>
           <p><span id="t2" data-src-offset="12" data-src-end="19">Goodbye</span></p>"""

    @Test
    fun two_anchors_produce_two_anchored_spans() {
        val bridge = SelectionBridge()
        val webView = mountAndCapture(bridge)

        // Wait for the injector IIFE to install before driving applyAnchors.
        // Without this gate, the evaluateJavascript can race the
        // defer-loaded script and find `window.applyAnchors` undefined.
        waitForInjectorReady(webView)

        composeRule.runOnUiThread {
            HighlightInjector.inject(
                webView,
                listOf(
                    AnchorRange("th-1", srcStart = 0, srcEnd = 11, resolved = false),
                    AnchorRange("th-2", srcStart = 12, srcEnd = 19, resolved = false),
                ),
            )
        }

        val count = readJs(webView, "document.querySelectorAll('.anchored').length")
        assertEquals("2", count)

        val threadIds = readJs(
            webView,
            "Array.from(document.querySelectorAll('.anchored'))" +
                ".map(function(s){return s.getAttribute('data-thread-id');})" +
                ".sort().join(',')",
        )
        // evaluateJavascript stringifies primitives via JSON, so a JS
        // string comes back wrapped in double-quotes. Match against the
        // wrapped form to keep the assertion intent obvious.
        assertEquals("\"th-1,th-2\"", threadIds)
    }

    @Test
    fun resolved_anchor_gets_data_resolved_attr() {
        val bridge = SelectionBridge()
        val webView = mountAndCapture(bridge)
        waitForInjectorReady(webView)

        composeRule.runOnUiThread {
            HighlightInjector.inject(
                webView,
                listOf(
                    AnchorRange("th-r", srcStart = 0, srcEnd = 11, resolved = true),
                ),
            )
        }

        val resolvedCount = readJs(
            webView,
            "document.querySelectorAll('.anchored[data-resolved]').length",
        )
        assertEquals("1", resolvedCount)

        // Toggle off — re-injecting the same thread without `resolved`
        // must remove the data-resolved attribute. This is the dim-
        // toggling round-trip the spec calls out.
        composeRule.runOnUiThread {
            HighlightInjector.inject(
                webView,
                listOf(
                    AnchorRange("th-r", srcStart = 0, srcEnd = 11, resolved = false),
                ),
            )
        }
        val afterToggle = readJs(
            webView,
            "document.querySelectorAll('.anchored[data-resolved]').length",
        )
        assertEquals("0", afterToggle)
        // The wrapper itself still exists.
        val total = readJs(webView, "document.querySelectorAll('.anchored').length")
        assertEquals("1", total)
    }

    @Test
    fun re_inject_unwraps_previous() {
        val bridge = SelectionBridge()
        val webView = mountAndCapture(bridge)
        waitForInjectorReady(webView)

        composeRule.runOnUiThread {
            HighlightInjector.inject(
                webView,
                listOf(AnchorRange("th-1", srcStart = 0, srcEnd = 11, resolved = false)),
            )
        }
        assertEquals("1", readJs(webView, "document.querySelectorAll('.anchored').length"))

        composeRule.runOnUiThread {
            HighlightInjector.inject(webView, emptyList())
        }
        assertEquals("0", readJs(webView, "document.querySelectorAll('.anchored').length"))
        // The original carriers must still be present (only the wrapper
        // gets removed; the [data-src-offset] spans are untouched).
        assertEquals(
            "2",
            readJs(webView, "document.querySelectorAll('[data-src-offset]').length"),
        )
    }

    // ---------- helpers ---------------------------------------------------

    private fun mountAndCapture(bridge: SelectionBridge): WebView {
        var captured: WebView? = null
        composeRule.setContent {
            CaptureWebView(onCaptured = { captured = it }) {
                MarkdownWebView(
                    html = sampleHtml,
                    theme = HtmlTheme.Light,
                    bridge = bridge,
                )
            }
        }
        composeRule.waitForIdle()
        composeRule.waitUntil(timeoutMillis = 5_000) { captured != null }
        return captured!!
    }

    private fun waitForInjectorReady(webView: WebView) {
        composeRule.waitUntil(timeoutMillis = 5_000) {
            var settled = false
            composeRule.runOnUiThread {
                webView.evaluateJavascript(
                    "(typeof window.applyAnchors === 'function').toString()",
                ) { result -> settled = result?.contains("true") == true }
            }
            Thread.sleep(50)
            settled
        }
    }

    /**
     * Synchronous wrapper around `evaluateJavascript` for assertions.
     * The callback fires on the WebView's renderer thread; we shuttle
     * the result through an [AtomicReference] and poll on the test
     * thread until it's populated.
     */
    private fun readJs(webView: WebView, expr: String): String {
        val out = AtomicReference<String?>(null)
        composeRule.runOnUiThread {
            webView.evaluateJavascript("($expr).toString()") { result ->
                out.set(result)
            }
        }
        composeRule.waitUntil(timeoutMillis = 5_000) {
            Thread.sleep(20)
            out.get() != null
        }
        val raw = out.get() ?: error("evaluateJavascript timed out: $expr")
        // evaluateJavascript stringifies the JS expression's result via
        // JSON, so a number returns "2" and a string returns "\"x\"".
        // Strip the outer quotes for numeric/length assertions while
        // preserving them where the test expects the JSON form.
        return if (raw.length >= 2 && raw.first() == '"' && raw.last() == '"' &&
            // Heuristic: if the raw contains an inner unescaped quote
            // it's probably a numeric stringification we should leave
            // alone. Practically the only call sites are length() and
            // string maps, so the simple unwrap-quoted-numeric path is
            // safe enough.
            !raw.substring(1, raw.length - 1).contains('"')
        ) {
            // Numeric result — return without quotes.
            val inner = raw.substring(1, raw.length - 1)
            if (inner.toIntOrNull() != null) inner else raw
        } else {
            raw
        }
    }

}

/**
 * Compose helper: walks up from `LocalView` looking for the first
 * descendant [WebView] and reports it back to the test. Mirrors the
 * helper in SelectionBridgeInstrumentedTest (kept independent so a
 * future split of the two test files doesn't reach across packages).
 */
@Composable
private fun CaptureWebView(
    onCaptured: (WebView) -> Unit,
    content: @Composable () -> Unit,
) {
    val rootView = LocalView.current
    LaunchedEffect(rootView) {
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
        repeat(50) {
            walk(rootView)
            if (found != null) return@repeat
            kotlinx.coroutines.delay(100)
        }
        found?.let(onCaptured)
    }
    content()
}
