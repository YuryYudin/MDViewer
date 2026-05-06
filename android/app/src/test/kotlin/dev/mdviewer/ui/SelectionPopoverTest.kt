// ---------------------------------------------------------------------------
// SelectionPopoverTest — host-JVM unit coverage for the [SelectionPopover]
// Compose surface and the [ThreadOverlay] container that drives it from a
// [SelectionBridge] event flow.
//
// What we lock in here:
//
//   1. The popover renders both wireframe-locked actions (Comment, Copy)
//      whenever a selection rect is supplied. The wireframe in
//      `wireframes/06-thread-detail.html` is the source-of-truth surface,
//      so any future restyle has to keep these two strings reachable by
//      `onNodeWithText`.
//   2. Tapping each action dispatches the corresponding callback exactly
//      once. The popover holds zero business logic — its only contract
//      is "translate user taps into the right callback" — so a missed
//      dispatch is a regression even if the UI looks unchanged.
//   3. ThreadOverlay maps `SelectionBridge` state to popover visibility:
//        - SelectionEvent.Collapsed         -> popover hidden
//        - SelectionEvent.Updated(rect=null) -> popover hidden (no anchor)
//        - SelectionEvent.Updated(rect=Rect)  -> popover visible
//        - SelectionEvent.HighlightTapped     -> popover hidden (D5 owns
//          the thread-sheet surface; D4 only mounts the popover)
//      These four cases are all the states the bridge can publish, so we
//      cover every branch the overlay's `when` exhausts.
//
// Why Robolectric + AndroidJUnit4: `createComposeRule()` instantiates a
// `ComponentActivity` to host the composition. Robolectric provides the
// activity lifecycle stubs the rule needs without firing up an emulator.
// SDK 33 mirrors the rest of the host-JVM tests in this module.
//
// Why we don't assert popover screen position: the spec deliberately keeps
// positioning logic (`Modifier.offset { ... }` derived from the source
// `Rect`) inside the production composable. Asserting the resolved IntOffset
// here would require pumping a layout pass + reading
// `LocalDensity.current.density`, which under Robolectric defaults to 1.0
// — the resulting test would pin a host-JVM-specific number that has no
// bearing on real devices. The instrumented MarkdownWebView coverage path
// (D2) is the right surface for screen-coordinate assertions.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.graphics.Rect
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.render.JsMessage
import dev.mdviewer.render.SelectionBridge
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class SelectionPopoverTest {

    @get:Rule val composeRule = createComposeRule()

    @Test
    fun popover_renders_comment_and_copy_actions() {
        composeRule.setContent {
            SelectionPopover(
                rect = Rect(100, 200, 300, 240),
                onComment = {},
                onCopy = {},
            )
        }
        composeRule.onNodeWithText("Comment").assertExists()
        composeRule.onNodeWithText("Copy").assertExists()
    }

    @Test
    fun popover_dispatches_comment_callback_on_tap() {
        var commentClicks = 0
        var copyClicks = 0
        composeRule.setContent {
            SelectionPopover(
                rect = Rect(0, 0, 0, 0),
                onComment = { commentClicks++ },
                onCopy = { copyClicks++ },
            )
        }

        composeRule.onNodeWithText("Comment").performClick()

        assertEquals(1, commentClicks, "Comment tap must fire onComment exactly once")
        assertEquals(0, copyClicks, "Comment tap must not fire onCopy")
    }

    @Test
    fun popover_dispatches_copy_callback_on_tap() {
        var commentClicks = 0
        var copyClicks = 0
        composeRule.setContent {
            SelectionPopover(
                rect = Rect(0, 0, 0, 0),
                onComment = { commentClicks++ },
                onCopy = { copyClicks++ },
            )
        }

        composeRule.onNodeWithText("Copy").performClick()

        assertEquals(0, commentClicks, "Copy tap must not fire onComment")
        assertEquals(1, copyClicks, "Copy tap must fire onCopy exactly once")
    }

    @Test
    fun thread_overlay_hides_popover_when_selection_is_collapsed() {
        val bridge = SelectionBridge()  // initial state == Collapsed

        composeRule.setContent {
            ThreadOverlay(bridge = bridge, onComment = {})
        }

        composeRule.onNodeWithText("Comment").assertDoesNotExist()
        composeRule.onNodeWithText("Copy").assertDoesNotExist()
    }

    @Test
    fun thread_overlay_hides_popover_when_selection_has_no_rect() {
        val bridge = SelectionBridge()
        // Selection-without-rect is the initial bridge state right after
        // the JS `selectionchange` event fires but before ActionMode's
        // `onGetContentRect` arrives. The popover has no anchor in this
        // state and must stay hidden until the rect lands.
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "hi", srcStart = 0, srcEnd = 2))

        composeRule.setContent {
            ThreadOverlay(bridge = bridge, onComment = {})
        }

        composeRule.onNodeWithText("Comment").assertDoesNotExist()
        composeRule.onNodeWithText("Copy").assertDoesNotExist()
    }

    @Test
    fun thread_overlay_shows_popover_when_selection_has_rect() {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "hi", srcStart = 0, srcEnd = 2))
        bridge.onActionModeContentRect(Rect(10, 20, 30, 40))

        composeRule.setContent {
            ThreadOverlay(bridge = bridge, onComment = {})
        }

        composeRule.onNodeWithText("Comment").assertExists()
        composeRule.onNodeWithText("Copy").assertExists()
    }

    @Test
    fun thread_overlay_dispatches_selection_to_on_comment_callback() {
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.SelectionChanged(text = "hello world", srcStart = 7, srcEnd = 18))
        bridge.onActionModeContentRect(Rect(10, 20, 30, 40))

        var captured: dev.mdviewer.render.Selection? = null
        composeRule.setContent {
            ThreadOverlay(bridge = bridge, onComment = { captured = it })
        }

        composeRule.onNodeWithText("Comment").performClick()

        val sel = captured
        assertTrue(sel != null, "Comment tap must dispatch the active Selection upward")
        assertEquals("hello world", sel.text)
        assertEquals(7, sel.srcStart)
        assertEquals(18, sel.srcEnd)
        assertEquals(Rect(10, 20, 30, 40), sel.rect)
    }

    @Test
    fun thread_overlay_hides_popover_on_highlight_tap() {
        // HighlightTap is owned by D5's ThreadSheet surface; the overlay's
        // popover branch must not render for tapped highlights.
        val bridge = SelectionBridge()
        bridge.onJsMessage(JsMessage.HighlightTap(threadId = "thr-1"))

        composeRule.setContent {
            ThreadOverlay(bridge = bridge, onComment = {})
        }

        composeRule.onNodeWithText("Comment").assertDoesNotExist()
        composeRule.onNodeWithText("Copy").assertDoesNotExist()
    }
}
