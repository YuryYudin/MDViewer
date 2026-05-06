// ---------------------------------------------------------------------------
// SelectionBridgeTest — host-JVM unit coverage for the [SelectionBridge]
// reconciler and the [SelectionJsBridge] JSON inbox.
//
// The bridge fuses two asynchronous streams into one [SelectionEvent]:
//   1. JS-originated `selectionchange` / `highlightTap` / `selectionCollapsed`
//      / `selectionUnanchorable` messages that arrive through
//      `addJavascriptInterface` as JSON strings.
//   2. ActionMode rect updates that the [SuppressingActionModeCallback]
//      forwards from `onGetContentRect` (the only menu-callback method we
//      keep alive after suppressing the system menu).
//
// Why we test all four JS shapes here:
//   - The JSON parser sits at the WebView/JVM boundary; a mishandled key
//     name silently drops user-visible selection events. Each shape pins
//     the contract independently so a regression goes red on the closest
//     surface, not at instrumentation time on a real emulator.
//
// Why Robolectric + @Config(sdk=33): [SelectionBridge] keeps an
// `android.graphics.Rect` field. The unit-tests target's
// `unitTests.isReturnDefaultValues = true` covers framework-stub access on
// fields, but constructing a `Rect` requires a real implementation —
// Robolectric provides one through the `AndroidJUnit4` runner. SDK 33 mirrors
// the rest of the C-phase host-JVM tests (AssetLoaderFactoryTest, etc.) for
// classpath consistency.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import android.graphics.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class SelectionBridgeTest {

    @Test
    fun selectionchange_then_rect_publishes_combined_selection() = runTest {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "hi", srcStart = 0, srcEnd = 2))
        bridge.onActionModeContentRect(Rect(10, 20, 30, 40))

        val event = bridge.state.first { it is SelectionEvent.Updated }
        val sel = (event as SelectionEvent.Updated).selection
        assertEquals("hi", sel.text)
        assertEquals(0, sel.srcStart)
        assertEquals(2, sel.srcEnd)
        assertEquals(Rect(10, 20, 30, 40), sel.rect)
    }

    @Test
    fun rect_before_selection_does_not_publish_until_selection_arrives() = runTest {
        val bridge = SelectionBridge()
        // Rect arriving before any JS selection must not synthesize a
        // bogus Updated event with empty text — it would fire a "select
        // 0..0 with this rect" event that the popover would render.
        bridge.onActionModeContentRect(Rect(10, 20, 30, 40))
        assertTrue(
            bridge.state.first() is SelectionEvent.Collapsed,
            "rect alone must not flip state to Updated",
        )
    }

    @Test
    fun collapse_clears_state() = runTest {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "hi", srcStart = 0, srcEnd = 2))
        bridge.onJsMessage(JsMessage.SelectionCollapsed)

        assertTrue(bridge.state.first() is SelectionEvent.Collapsed)
    }

    @Test
    fun unanchorable_selection_falls_back_to_collapsed() = runTest {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "hi", srcStart = 0, srcEnd = 2))
        bridge.onJsMessage(JsMessage.SelectionUnanchorable)

        assertTrue(bridge.state.first() is SelectionEvent.Collapsed)
    }

    @Test
    fun highlight_tap_publishes_thread_id() = runTest {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.HighlightTap(threadId = "t1"))

        val event = bridge.state.first { it is SelectionEvent.HighlightTapped }
        assertEquals("t1", (event as SelectionEvent.HighlightTapped).threadId)
    }

    @Test
    fun js_bridge_parses_selectionchange_json() = runTest {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        js.onMessage(
            """{"kind":"selectionchange","text":"abc","srcStart":3,"srcEnd":6}""",
        )
        val expected: List<JsMessage> =
            listOf(JsMessage.SelectionChanged(text = "abc", srcStart = 3, srcEnd = 6))
        assertEquals(expected, received)
    }

    @Test
    fun js_bridge_parses_highlight_tap_json() = runTest {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        js.onMessage("""{"kind":"highlightTap","threadId":"thr-42"}""")
        val expected: List<JsMessage> = listOf(JsMessage.HighlightTap("thr-42"))
        assertEquals(expected, received)
    }

    @Test
    fun js_bridge_parses_collapsed_and_unanchorable() = runTest {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        js.onMessage("""{"kind":"selectionCollapsed"}""")
        js.onMessage("""{"kind":"selectionUnanchorable"}""")
        val expected: List<JsMessage> =
            listOf(JsMessage.SelectionCollapsed, JsMessage.SelectionUnanchorable)
        assertEquals(expected, received)
    }

    @Test
    fun js_bridge_drops_unknown_kind_silently() = runTest {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        js.onMessage("""{"kind":"future-event","payload":42}""")
        // An unknown kind must NOT throw across the JNI boundary — that
        // would crash the WebView render thread. It also must not be
        // smuggled into the channel as a sentinel value.
        assertTrue(received.isEmpty())
    }

    @Test
    fun js_bridge_drops_malformed_json_silently() = runTest {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        js.onMessage("not-json-at-all")
        js.onMessage("")
        assertTrue(received.isEmpty())
    }

    @Test
    fun js_bridge_drops_wrong_typed_payload_silently() = runTest {
        // Regression: kotlinx-serialization's `jsonPrimitive` extension throws
        // IllegalArgumentException when the underlying element is a
        // JsonObject/JsonArray/JsonNull — without a runCatching around the
        // whole parse body, the exception escapes onMessage and crashes the
        // WebView renderer thread. Lock in the silent-drop contract for each
        // shape that takes a typed field.
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        // selectionchange.text arrives as an object instead of a string.
        js.onMessage("""{"kind":"selectionchange","text":{},"srcStart":0,"srcEnd":1}""")
        // selectionchange.srcStart arrives as an array.
        js.onMessage("""{"kind":"selectionchange","text":"x","srcStart":[1,2],"srcEnd":3}""")
        // highlightTap.threadId arrives as an object.
        js.onMessage("""{"kind":"highlightTap","threadId":{}}""")
        // kind itself is the wrong shape (object, not string).
        js.onMessage("""{"kind":{},"x":1}""")
        // Mixed JSON-element types in one payload.
        js.onMessage("""{"kind":"selectionchange","text":null,"srcStart":null,"srcEnd":null}""")
        assertTrue(received.isEmpty())
    }

    @Test
    fun suppressing_action_mode_callback_returns_false_on_create() {
        val bridge = SelectionBridge()
        val cb = SuppressingActionModeCallback(bridge)

        // The whole point of Callback2 here is to suppress the system menu
        // by short-circuiting onCreateActionMode + onPrepareActionMode so
        // the WebView never gets to populate Copy / Share / Web Search.
        assertEquals(false, cb.onCreateActionMode(null, null))
        assertEquals(false, cb.onPrepareActionMode(null, null))
        assertEquals(false, cb.onActionItemClicked(null, null))
    }

    @Test
    fun suppressing_action_mode_callback_forwards_rect_to_bridge() = runTest {
        val bridge = SelectionBridge()
        val cb = SuppressingActionModeCallback(bridge)
        // Seed a JS selection so publish() has something to combine with.
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "x", srcStart = 0, srcEnd = 1))

        val rect = Rect(1, 2, 3, 4)
        cb.onGetContentRect(null, null, rect)

        val ev = bridge.state.first { it is SelectionEvent.Updated }
        assertEquals(rect, (ev as SelectionEvent.Updated).selection.rect)
    }

    @Test
    fun selection_without_rect_is_published_with_null_rect() = runTest {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "x", srcStart = 0, srcEnd = 1))

        val event = bridge.state.first { it is SelectionEvent.Updated }
        // The popover positioner uses null as "no anchor known yet".
        assertNull((event as SelectionEvent.Updated).selection.rect)
    }
}
