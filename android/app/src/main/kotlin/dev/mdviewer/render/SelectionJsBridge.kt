// ---------------------------------------------------------------------------
// SelectionJsBridge — the typed inbox between `selection-bridge.js` and the
// JVM-side [SelectionBridge].
//
// Why this class is split from [SelectionBridge]:
//   - `addJavascriptInterface` requires the receiver class to expose a
//     `@JavascriptInterface`-annotated public method whose parameter types
//     are JNI-marshalable primitives or `String`. The reconciler uses
//     `kotlinx.coroutines.flow.MutableStateFlow` and value classes that are
//     not JNI-friendly. Splitting the JS adapter into its own class keeps
//     the marshaling code near the wire and lets the reconciler stay free
//     of `@JavascriptInterface` concerns.
//   - The JS callback runs on the WebView's chrome thread, NOT the JVM main
//     thread. We need a clean place to choose how to forward to the
//     SelectionBridge (here: a synchronous lambda that posts to whichever
//     dispatcher the caller wants).
//
// Why hand-rolled JSON parsing (and not @Serializable polymorphism):
//   - The JS payload is tagged-union JSON keyed by `kind`. kotlinx-
//     serialization's polymorphic codec wraps the value in a second envelope
//     (`{type: "...", value: {...}}`) that differs from what a JS engineer
//     would naturally write. Hand-parsing the four shapes by `kind` keeps the
//     wire format obvious from both sides.
//   - The four shapes are tiny (text, srcStart, srcEnd, threadId), so the
//     parsing surface is small and the failure modes are exhaustive.
//
// Failure-mode contract:
//   - Malformed JSON, unknown `kind`, missing required keys → drop silently.
//     The JS bridge is one-way (no acknowledge channel) and an exception
//     thrown out of `@JavascriptInterface` propagates to the WebView's
//     chrome thread where it crashes the renderer process. Dropping is the
//     only safe failure mode for a pure-input boundary.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import android.webkit.JavascriptInterface
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Adapter that the WebView calls into via `addJavascriptInterface`. Each
 * incoming JSON string is parsed into a [JsMessage] and forwarded to
 * [onMessageParsed]; malformed payloads are dropped silently to keep the
 * JNI boundary safe.
 *
 * @param onMessageParsed Called once per recognized message. The lambda
 *                        runs on the WebView's chrome thread (the thread
 *                        that owns `@JavascriptInterface` dispatch); the
 *                        SelectionBridge implementation must therefore be
 *                        thread-safe (it is — see the StateFlow rationale).
 */
class SelectionJsBridge(
    private val onMessageParsed: (JsMessage) -> Unit,
) {

    /**
     * Called from the WebView with the JSON string posted by
     * `selection-bridge.js`. Public + annotated so Android's JS bridge can
     * reflect on it; not part of the Kotlin-side intentional API.
     */
    @JavascriptInterface
    fun onMessage(json: String) {
        val msg = parse(json) ?: return
        onMessageParsed(msg)
    }

    /**
     * Hand-rolled parser. Returns null for any failure mode (malformed JSON,
     * missing discriminator, unknown discriminator, missing required field,
     * wrong field type — e.g. `text` arriving as an object instead of a
     * string). The whole body runs inside `runCatching` so per-field accessors
     * like `jsonPrimitive` (which throws `IllegalArgumentException` when the
     * underlying element is a JsonObject/JsonArray/JsonNull) cannot escape
     * past the `@JavascriptInterface` boundary and crash the WebView
     * renderer thread.
     */
    private fun parse(json: String): JsMessage? = runCatching {
        val obj = JSON.parseToJsonElement(json).jsonObject
        val kind = (obj["kind"] as? JsonPrimitive)?.contentOrNull
            ?: return@runCatching null
        when (kind) {
            "selectionCollapsed" -> JsMessage.SelectionCollapsed
            "selectionUnanchorable" -> JsMessage.SelectionUnanchorable
            "selectionchange" -> {
                val text = (obj["text"] as? JsonPrimitive)?.contentOrNull
                    ?: return@runCatching null
                val srcStart = (obj["srcStart"] as? JsonPrimitive)?.intOrNull
                    ?: return@runCatching null
                val srcEnd = (obj["srcEnd"] as? JsonPrimitive)?.intOrNull
                    ?: return@runCatching null
                // Optional rect (added in v0.4.17). Older bridge.js builds
                // omit the four rect* keys; treat null as "no rect from JS"
                // and let the JVM fall back to ActionMode.onGetContentRect
                // if that ever fires again.
                val rectLeft = (obj["rectLeft"] as? JsonPrimitive)?.intOrNull
                val rectTop = (obj["rectTop"] as? JsonPrimitive)?.intOrNull
                val rectWidth = (obj["rectWidth"] as? JsonPrimitive)?.intOrNull
                val rectHeight = (obj["rectHeight"] as? JsonPrimitive)?.intOrNull
                val rect = if (
                    rectLeft != null && rectTop != null &&
                    rectWidth != null && rectHeight != null
                ) {
                    android.graphics.Rect(
                        rectLeft,
                        rectTop,
                        rectLeft + rectWidth,
                        rectTop + rectHeight,
                    )
                } else null
                JsMessage.SelectionChanged(
                    text = text,
                    srcStart = srcStart,
                    srcEnd = srcEnd,
                    rect = rect,
                )
            }
            "highlightTap" -> {
                val tid = (obj["threadId"] as? JsonPrimitive)?.contentOrNull
                    ?: return@runCatching null
                JsMessage.HighlightTap(threadId = tid)
            }
            else -> null
        }
    }.getOrNull()

    private companion object {
        // Lenient JSON: tolerate trailing commas / unquoted keys that future
        // JS engines might emit. Doesn't loosen the type contract — the
        // per-field accessors above still require correct primitive types.
        private val JSON = Json { ignoreUnknownKeys = true; isLenient = true }
    }
}
