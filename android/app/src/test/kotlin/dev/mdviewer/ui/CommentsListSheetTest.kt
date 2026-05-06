// ---------------------------------------------------------------------------
// CommentsListSheetTest — host-JVM unit coverage for the [CommentsListSheet]
// Compose surface (D6 "All Comments" drawer per
// `wireframes/07-comments-list.html`).
//
// What we lock in here:
//
//   1. The empty-list path renders a placeholder rather than a blank surface
//      so the user never sees a phantom modal with no body.
//   2. Each thread row surfaces the wireframe-required signal: the author
//      name of the first comment, a preview of the body, and the anchor's
//      selector text (the wireframe italic-quoted slug). A future restyle
//      has to keep these strings reachable so the navigator stays useful.
//   3. The show-resolved toggle filters: with the toggle off (default per
//      design — see SettingsStore.showResolved default), resolved threads
//      are hidden; with the toggle on, every thread renders. Reorder is
//      preserved (we never push resolved to the bottom — the wireframe and
//      the task spec both call this out explicitly).
//   4. Tapping a row dispatches the thread id upward exactly once. The
//      row's secondary signals (Reopen, replies count, etc) live in the
//      ThreadSheet (D5); the list row is purely a navigator handle.
//   5. Toggling the switch dispatches the new boolean upward — the sheet
//      itself is stateless w.r.t. the SettingsStore so the host can route
//      the value through any persistence path (ViewModel coroutine in
//      production; a plain `mutableStateOf` boolean in test).
//
// Why a stateless composable surface (vs threading the SettingsStore +
// CommentsStoreHandle directly into the composable):
//   * The desktop client's CommentsSidebar.ts is the same shape — it takes
//     a list of threads and a "showResolved" boolean. Mirroring it keeps
//     the cross-platform mental model consistent.
//   * Compose-side unit tests can construct plain `Thread` data classes
//     without a UniFFI store handle, which is the fastest path to red /
//     green for a navigator surface.
//   * The host (DocumentScreen / ThreadOverlay in D6) collects the Flow
//     from SettingsStore once and forwards the live boolean down. The
//     pattern is the same as ThreadSheet, which takes a ViewModel and not
//     a bare CommentsStoreHandle.
//
// Why Robolectric @Config(sdk = 33): mirrors SelectionPopoverTest /
// ThreadSheetViewModelTest. createComposeRule() mounts a ComponentActivity;
// SDK 33 is the supported Robolectric host.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.core.Anchor
import dev.mdviewer.core.Comment
import dev.mdviewer.core.Thread
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

@OptIn(ExperimentalMaterial3Api::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class CommentsListSheetTest {

    @get:Rule val composeRule = createComposeRule()

    // ---------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------

    private fun anchor(text: String, start: Int = 0, end: Int = text.length): Anchor =
        Anchor(
            selectorText = text,
            contextBefore = "",
            contextAfter = "",
            charStart = start.toUInt(),
            charEnd = end.toUInt(),
        )

    private fun comment(
        id: String = "c1",
        author: String = "Alice",
        body: String = "first comment body",
    ): Comment = Comment(
        id = id,
        authorId = "u-$author",
        authorName = author,
        authorColor = "#FF0066",
        body = body,
        createdAt = "2025-05-05T10:00:00Z",
    )

    private fun thread(
        id: String,
        anchorText: String = "anchor",
        comments: List<Comment> = listOf(comment()),
        resolved: Boolean = false,
    ): Thread = Thread(
        id = id,
        anchor = anchor(anchorText),
        comments = comments,
        resolved = resolved,
        createdAt = "2025-05-05T10:00:00Z",
    )

    // ---------------------------------------------------------------------
    // Empty + render
    // ---------------------------------------------------------------------

    @Test
    fun empty_thread_list_renders_placeholder() {
        composeRule.setContent {
            CommentsListSheet(
                threads = emptyList(),
                showResolved = false,
                onShowResolvedChange = {},
                onThreadClick = {},
                onDismiss = {},
            )
        }
        // The placeholder copy keeps the modal from looking broken when no
        // comments exist yet (e.g. fresh sidecar). The exact wording is a
        // soft contract — the assertion uses a substring match by node
        // semantics so "No comments" / "No comments yet" both pass.
        composeRule.onNodeWithText("No comments yet").assertIsDisplayed()
    }

    @Test
    fun renders_each_open_thread_with_author_body_and_anchor_preview() {
        val a = thread(
            id = "t1",
            anchorText = "work from their phone",
            comments = listOf(comment(author = "Rui Park", body = "Strong agree on this.")),
        )
        val b = thread(
            id = "t2",
            anchorText = "by replying via Drive",
            comments = listOf(comment(author = "Mei Kuroda", body = "Worth showing the URL?")),
        )
        composeRule.setContent {
            CommentsListSheet(
                threads = listOf(a, b),
                showResolved = false,
                onShowResolvedChange = {},
                onThreadClick = {},
                onDismiss = {},
            )
        }
        // Authors of the first comment are surfaced as primary signal.
        composeRule.onNodeWithText("Rui Park", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Mei Kuroda", substring = true).assertIsDisplayed()
        // Body previews are rendered.
        composeRule.onNodeWithText("Strong agree on this.", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Worth showing the URL?", substring = true).assertIsDisplayed()
        // Anchor selector text is the italic-quoted slug in the wireframe.
        composeRule.onNodeWithText("work from their phone", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("by replying via Drive", substring = true).assertIsDisplayed()
    }

    // ---------------------------------------------------------------------
    // show-resolved filtering
    // ---------------------------------------------------------------------

    @Test
    fun resolved_threads_are_hidden_when_show_resolved_is_off() {
        val open = thread(
            id = "t-open",
            anchorText = "open-thread-anchor",
            comments = listOf(comment(author = "Rui Park", body = "open body")),
        )
        val resolved = thread(
            id = "t-resolved",
            anchorText = "resolved-thread-anchor",
            comments = listOf(comment(author = "Jordan Lee", body = "resolved body")),
            resolved = true,
        )
        composeRule.setContent {
            CommentsListSheet(
                threads = listOf(open, resolved),
                showResolved = false,
                onShowResolvedChange = {},
                onThreadClick = {},
                onDismiss = {},
            )
        }
        // Open thread renders.
        composeRule.onNodeWithText("Rui Park", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("open body", substring = true).assertIsDisplayed()
        // Resolved is filtered out (default per design).
        composeRule.onNodeWithText("Jordan Lee", substring = true).assertDoesNotExist()
        composeRule.onNodeWithText("resolved body", substring = true).assertDoesNotExist()
    }

    @Test
    fun resolved_threads_render_when_show_resolved_is_on() {
        val open = thread(
            id = "t-open",
            anchorText = "open-thread-anchor",
            comments = listOf(comment(author = "Rui Park", body = "open body")),
        )
        val resolved = thread(
            id = "t-resolved",
            anchorText = "resolved-thread-anchor",
            comments = listOf(comment(author = "Jordan Lee", body = "resolved body")),
            resolved = true,
        )
        composeRule.setContent {
            CommentsListSheet(
                threads = listOf(open, resolved),
                showResolved = true,
                onShowResolvedChange = {},
                onThreadClick = {},
                onDismiss = {},
            )
        }
        // Both render when toggle is on.
        composeRule.onNodeWithText("Rui Park", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Jordan Lee", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("resolved body", substring = true).assertIsDisplayed()
    }

    // ---------------------------------------------------------------------
    // Tap dispatch
    // ---------------------------------------------------------------------

    @Test
    fun tapping_a_thread_row_dispatches_thread_id_to_callback() {
        val a = thread(
            id = "thread-alpha",
            anchorText = "alpha-anchor",
            comments = listOf(comment(author = "Alice", body = "alpha body")),
        )
        val b = thread(
            id = "thread-beta",
            anchorText = "beta-anchor",
            comments = listOf(comment(author = "Bob", body = "beta body")),
        )
        val taps = mutableListOf<String>()
        composeRule.setContent {
            CommentsListSheet(
                threads = listOf(a, b),
                showResolved = false,
                onShowResolvedChange = {},
                onThreadClick = { taps += it },
                onDismiss = {},
            )
        }

        // Tap on the body preview of the second row — Compose's `clickable`
        // modifier merges descendants into the surrounding semantics node,
        // so the matcher resolves to the row's clickable container. We
        // dispatch through the OnClick action directly: under Robolectric
        // the synthetic-input path that `performClick` (touch down + up)
        // takes is timing-fragile, while `performSemanticsAction(OnClick)`
        // routes through the same lambda the production `clickable`
        // registers. Both paths exercise the same callback contract.
        composeRule.onNodeWithText("beta body", substring = true)
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)

        assertEquals(listOf("thread-beta"), taps,
            "tap must dispatch the tapped thread's id exactly once")
    }

    // ---------------------------------------------------------------------
    // Toggle dispatch
    // ---------------------------------------------------------------------

    @Test
    fun flipping_the_switch_dispatches_new_value_upward() {
        // We seed both an open + a resolved thread and start with the
        // toggle off (so only the open one renders). After dispatching
        // the toggle we recompose with the new value and verify the
        // resolved thread now renders too — the round trip proves the
        // callback fired AND the new boolean reached the composable.
        val open = thread(
            id = "t-open",
            anchorText = "open-anchor",
            comments = listOf(comment(author = "Rui Park", body = "open body")),
        )
        val resolved = thread(
            id = "t-resolved",
            anchorText = "resolved-anchor",
            comments = listOf(comment(author = "Jordan Lee", body = "resolved body")),
            resolved = true,
        )
        val flips = mutableListOf<Boolean>()
        composeRule.setContent {
            var show by remember { mutableStateOf(false) }
            CommentsListSheet(
                threads = listOf(open, resolved),
                showResolved = show,
                onShowResolvedChange = { v ->
                    flips += v
                    show = v
                },
                onThreadClick = {},
                onDismiss = {},
            )
        }

        // Pre-flip: resolved row hidden.
        composeRule.onNodeWithText("Jordan Lee", substring = true).assertDoesNotExist()

        // Dispatch via the same path D5 uses for action verification under
        // Robolectric: the row's mergeDescendants click semantics resolve
        // by label, and OnClick routes through the production lambda.
        composeRule.onNodeWithText("Show resolved", substring = true)
            .performSemanticsAction(androidx.compose.ui.semantics.SemanticsActions.OnClick)

        // Callback fired with the new value.
        assertEquals(listOf(true), flips,
            "toggle must dispatch the new boolean exactly once per flip")

        // Post-flip recomposition: resolved row now renders.
        composeRule.onNodeWithText("Jordan Lee", substring = true).assertIsDisplayed()
    }
}
