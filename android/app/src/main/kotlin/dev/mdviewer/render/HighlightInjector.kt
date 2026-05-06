// ---------------------------------------------------------------------------
// HighlightInjector — JVM-side adapter that posts anchor ranges to the
// in-document JavaScript wrapper installed by `highlight-injector.js`.
//
// What the injector does:
//   - Encodes a list of [AnchorRange] entries into a canonical JSON array.
//   - Wraps that JSON document in a JS string literal so we can hand the
//     pair `(JSON.parse(<literal>), applyAnchors(...))` to
//     `WebView.evaluateJavascript`. The `evaluateJavascript` API takes a
//     raw JS source string — the JSON has to ride inside a string literal
//     because we cannot stream the parsed object directly.
//   - Hands that script to the WebView. The JS side walks every
//     `[data-src-offset]` carrier emitted by `mdviewer-core::render_markdown`,
//     finds the spans whose offset overlaps each range, and wraps them
//     in `<span class="anchored" data-thread-id=... [data-resolved]>`.
//
// Why we keep the wire format on this side:
//   - The Android UniFFI binding ships its own `Anchor`/`Thread` data
//     classes whose field names mirror the Rust UDL. The JS wrapper
//     wants a flatter, JS-idiomatic shape (`threadId`, `srcStart`,
//     `srcEnd`, `resolved`). Defining [AnchorRange] here keeps the
//     translation explicit and lets callers project from the UDL types
//     in one place (E-phase will add the projection helpers).
//
// Why we don't `addJavascriptInterface` for the inbound direction:
//   - The selection bridge already owns the `MdvSelection` JS interface
//     for click-on-highlight events. That covers JS -> JVM. The JVM ->
//     JS direction has no chrome-thread inbox; `evaluateJavascript` is
//     the supported API.
//
// Idempotency contract:
//   - The JS side unwraps every previous `.anchored` wrapper before re-
//     applying. That means callers can pass the full thread list on
//     every change (resolved toggled, new thread created) without
//     having to diff against the prior payload — the JS will compute
//     the new DOM from the source spans every time.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import android.webkit.WebView
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * One anchor range in the canonical wire shape that
 * `highlight-injector.js` reads.
 *
 * @property threadId Stable thread identifier the JS wrapper writes onto
 *                    `data-thread-id` so the click-bridge can translate
 *                    a tap back into the same thread.
 * @property srcStart Inclusive byte offset into the original Markdown
 *                    source where the highlight begins (matches the
 *                    selection-bridge's `srcStart` semantics).
 * @property srcEnd   Exclusive byte offset where the highlight ends.
 * @property resolved If true, the JS side adds `data-resolved="true"`
 *                    to the wrapper so the document.css `.anchored
 *                    [data-resolved]` rule dims and strikes through.
 */
@Serializable
data class AnchorRange(
    val threadId: String,
    val srcStart: Int,
    val srcEnd: Int,
    val resolved: Boolean,
)

/**
 * Pure functions over the wire format plus a single side-effecting
 * entry point that pushes the script into a [WebView].
 *
 * Splitting the encode/wrap helpers out of [inject] lets the host-JVM
 * unit tests pin the JSON contract without spinning up a WebView (which
 * Robolectric cannot host — see coverageExcludes in build.gradle).
 */
object HighlightInjector {

    /**
     * Stable JSON config — explicit-defaults ensures `resolved=false`
     * still appears in the encoded document so the JS-side reader
     * doesn't have to handle the absent-key case.
     */
    private val JSON = Json {
        encodeDefaults = true
    }

    private val LIST_SERIALIZER = ListSerializer(AnchorRange.serializer())

    /**
     * Serialize a list of ranges to the JSON document the JS bridge
     * expects. Public so the host-JVM unit test can pin the wire format
     * independently of the WebView path.
     */
    fun encodeRanges(ranges: List<AnchorRange>): String =
        JSON.encodeToString(LIST_SERIALIZER, ranges)

    /**
     * Build the JS source string we hand to `evaluateJavascript`. The
     * shape is `window.applyAnchors("<json>")` — the JSON document is
     * embedded as a JS string literal that the JS wrapper passes
     * through `JSON.parse`.
     *
     * Public so the host-JVM unit test can verify the escape rules
     * without a WebView in the loop.
     */
    fun buildEvalScript(ranges: List<AnchorRange>): String {
        val json = encodeRanges(ranges)
        return "window.applyAnchors(\"${jsEscape(json)}\")"
    }

    /**
     * Apply the given anchor ranges to the rendered document by calling
     * `window.applyAnchors` inside the WebView.
     *
     * The call is fire-and-forget: the JS function returns nothing and
     * we have no use for an evaluation result (`null` callback). The
     * WebView dispatches the script on its renderer thread; this method
     * is safe to call from any thread the WebView is otherwise touched
     * from.
     */
    fun inject(webView: WebView, ranges: List<AnchorRange>) {
        webView.evaluateJavascript(buildEvalScript(ranges), null)
    }

    /**
     * Escape a JSON document so it can ride inside a double-quoted JS
     * string literal. Three characters need handling:
     *   - backslash (`\`) — must double so the JS lexer doesn't consume
     *     the following character as part of an escape sequence.
     *   - double-quote (`"`) — must be backslash-prefixed so it doesn't
     *     terminate the literal early.
     *   - line-feed (`\n`) — JS string literals cannot contain raw
     *     newlines; convert to the two-char sequence `\` + `n` so the
     *     literal stays on one line and the JSON document round-trips
     *     intact through `JSON.parse`.
     *
     * Carriage return + tab + form-feed are not produced by
     * `Json.encodeToString` for the field types we use (Int, String,
     * Boolean) so we don't escape them here. Adding them later if a
     * field type widens is straightforward.
     *
     * Order matters: the backslash replacement runs FIRST so the
     * subsequent quote/newline replacements don't double-escape the
     * backslashes they introduce.
     */
    private fun jsEscape(s: String): String =
        s
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
}
