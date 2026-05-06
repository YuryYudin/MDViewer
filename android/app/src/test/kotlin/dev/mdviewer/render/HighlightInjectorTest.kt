// ---------------------------------------------------------------------------
// HighlightInjectorTest — host-JVM coverage for the JSON serialization
// surface the [HighlightInjector] uses to ferry anchor ranges over the
// `evaluateJavascript` boundary. The actual WebView span-wrapping is
// exercised by the instrumented test under `androidTest/`; this file
// pins the wire format independently so a regression on the JSON shape
// or escape rules trips the host-JVM run before the slow emulator phase.
//
// Why test the JS string escaping in isolation:
//   - `evaluateJavascript` accepts an arbitrary JS string; we call
//     `window.applyAnchors(<json-as-js-literal>)`. The JSON we hand to JS
//     therefore travels through TWO escape layers: kotlinx-serialization
//     emits JSON-escaped text, then the outer JS wrapper has to escape
//     backslashes, double-quotes, and newlines so the final
//     `JSON.parse(string)` invocation receives an intact JSON document.
//   - Forgetting either escape produces silent data loss (the parse
//     simply returns a truncated payload) or a JS parse error swallowed
//     by the WebView's renderer thread. Pinning the contract here keeps
//     the failure visible at unit-test latency.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HighlightInjectorTest {

    @Test
    fun encode_ranges_produces_array_of_thread_id_src_offsets_resolved() {
        val json = HighlightInjector.encodeRanges(
            listOf(
                AnchorRange("t1", srcStart = 0, srcEnd = 5, resolved = false),
                AnchorRange("t2", srcStart = 6, srcEnd = 11, resolved = true),
            ),
        )
        // The exact JSON shape is part of the contract with
        // `highlight-injector.js`; pin both keys and order so a future
        // refactor of AnchorRange's field order doesn't silently break
        // the JS-side reader.
        assertEquals(
            """[{"threadId":"t1","srcStart":0,"srcEnd":5,"resolved":false},""" +
                """{"threadId":"t2","srcStart":6,"srcEnd":11,"resolved":true}]""",
            json,
        )
    }

    @Test
    fun encode_empty_list_produces_empty_array() {
        // The "unwrap previous" path on the JS side runs unconditionally,
        // so passing an empty list is the canonical way to clear all
        // highlights. Serializing must produce a parseable empty array,
        // not "null" or "".
        assertEquals("[]", HighlightInjector.encodeRanges(emptyList()))
    }

    @Test
    fun build_eval_script_wraps_json_as_js_string_literal() {
        val script = HighlightInjector.buildEvalScript(
            listOf(AnchorRange("t1", srcStart = 0, srcEnd = 5, resolved = false)),
        )
        // The script must call window.applyAnchors with a JS string
        // literal that, when parsed with JSON.parse on the JS side,
        // yields the canonical JSON document. We assert both halves —
        // the function call shape and the embedded literal — so a
        // future refactor that switches to passing the parsed object
        // directly (which would skip the escape layer entirely) shows
        // up here, not as a runtime parse error in production.
        assertTrue(
            script.startsWith("window.applyAnchors(\""),
            "expected JS string literal wrapping; got: $script",
        )
        assertTrue(script.endsWith("\")"), "expected closing paren+quote; got: $script")
    }

    @Test
    fun build_eval_script_escapes_backslashes_quotes_and_newlines() {
        // Construct an AnchorRange whose threadId carries every escape-
        // sensitive character we have to handle. None of these are
        // expected in real thread IDs, but `selection-bridge.js` already
        // round-trips arbitrary user-typed strings through the
        // highlightTap path; the symmetric inbound channel must be just
        // as resilient.
        val script = HighlightInjector.buildEvalScript(
            listOf(
                AnchorRange(
                    threadId = """t"\1\n2""",
                    srcStart = 0,
                    srcEnd = 1,
                    resolved = false,
                ),
            ),
        )
        // The JS literal must round-trip through `JSON.parse(...)`
        // unchanged. Easiest way to assert: verify the literal contains
        // the escape sequences in their JS-string form (each backslash
        // doubled, each quote and newline backslash-prefixed).
        // The original threadId was: t"\1\n2 (5 chars).
        // After JSON encoding (kotlinx-serialization): t\"\\1\\n2 (in
        // the JSON document) — quote becomes \" , backslash becomes \\,
        // and \n becomes \\n (the text-level newline is now an escape
        // sequence, not a literal LF).
        // After JS-literal escaping (jsEscape) the JSON document's
        // backslashes get doubled again and its quotes get backslash-
        // prefixed, so the final substring inside the eval script is
        // the doubly-escaped form.
        assertTrue(
            script.contains("""\"threadId\":\"t\\\"\\\\1\\\\n2\""""),
            "expected double-escaped threadId; got: $script",
        )
    }

    @Test
    fun build_eval_script_escapes_literal_newline_in_threadId() {
        // A literal LF in the threadId would, if unescaped, terminate
        // the JS string literal and hand the WebView a syntactically
        // invalid statement. The escape layer must turn LF into the
        // two-char sequence backslash-n.
        val script = HighlightInjector.buildEvalScript(
            listOf(
                AnchorRange(
                    threadId = "a\nb",
                    srcStart = 0,
                    srcEnd = 1,
                    resolved = false,
                ),
            ),
        )
        // No raw newline can appear inside the JS string literal
        // portion (everything between the opening and closing
        // double-quote).
        val open = script.indexOf('"')
        val close = script.lastIndexOf('"')
        val literal = script.substring(open + 1, close)
        assertTrue(
            !literal.contains('\n'),
            "JS string literal must not contain raw newline; got: $literal",
        )
    }
}
