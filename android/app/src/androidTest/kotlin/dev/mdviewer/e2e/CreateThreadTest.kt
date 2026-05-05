package dev.mdviewer.e2e

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.MainActivity
import dev.mdviewer.e2e.helpers.DocumentTestHarness
import dev.mdviewer.e2e.helpers.ResetState
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Covers "Create a thread": long-press selects a span, the popover offers
 * `Comment`, and Post anchors a new thread.
 *
 * Wireframes: `wireframes/05-selection-popover.html` and
 * `wireframes/06-thread-detail.html`.
 *
 * RED until Phase D (SelectionBridge + ThreadSheet + popover) lands.
 */
@RunWith(AndroidJUnit4::class)
class CreateThreadTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun openSampleDocument() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        DocumentTestHarness.openSampleWithoutSidecar(composeRule)
    }

    @Test
    fun long_press_shows_popover() {
        // Given: an open document with no existing threads.
        composeRule.onNodeWithText("Sample Document", substring = true).assertIsDisplayed()

        // When: the user long-presses to select a span of body text.
        DocumentTestHarness.longPressSelectFirstParagraph(composeRule)

        // Then: the selection popover from `wireframes/05-selection-popover.html` appears.
        composeRule.onNodeWithText("Comment", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Copy", substring = true).assertIsDisplayed()
    }

    @Test
    fun post_creates_anchored_thread() {
        // Given: a selection popover is showing over a selected span.
        DocumentTestHarness.longPressSelectFirstParagraph(composeRule)
        composeRule.onNodeWithText("Comment", substring = true).performClick()

        // When: the user types a body and taps Post.
        composeRule.onNodeWithTag("thread-body-input").performTextInput("Looks good to me.")
        composeRule.onNodeWithText("Post", substring = true).performClick()

        // Then: the thread sheet shows the posted comment, and the underlying
        // span in the document is rendered with the anchored highlight.
        composeRule.onNodeWithText("Looks good to me.", substring = true).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .assertIsDisplayed()
    }
}
