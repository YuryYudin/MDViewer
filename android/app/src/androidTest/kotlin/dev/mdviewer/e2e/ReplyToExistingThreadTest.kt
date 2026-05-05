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
 * Covers "Reply to existing thread": tapping a desktop-authored highlight
 * opens `wireframes/06-thread-detail.html`; a posted reply persists.
 *
 * RED until Phase D lands (HighlightInjector + ThreadSheet + sidecar
 * round-trip via DocumentRepository).
 */
@RunWith(AndroidJUnit4::class)
class ReplyToExistingThreadTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun openSampleWithSidecar() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        // Stages sample.md alongside sample.md.comments.json (the existing thread fixture).
        DocumentTestHarness.openSampleWithExistingSidecar(composeRule)
    }

    @Test
    fun tap_highlight_opens_existing_thread() {
        // Given: an open document with one desktop-authored thread.
        // When: the user taps the anchored highlight.
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .performClick()

        // Then: the thread sheet opens and shows the desktop-authored comment.
        composeRule.onNodeWithText("This thread came from desktop.", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithText("Desktop User", substring = true).assertIsDisplayed()
    }

    @Test
    fun post_reply_persists() {
        // Given: the existing thread sheet is open.
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .performClick()

        // When: the user types a reply and taps Post.
        composeRule.onNodeWithTag("thread-body-input").performTextInput("Replying from Android.")
        composeRule.onNodeWithText("Post", substring = true).performClick()

        // Then: the reply is rendered in-line with the desktop comment, and
        // re-opening the thread sheet (after dismiss) still shows the reply,
        // confirming it round-tripped through the sidecar writer.
        composeRule.onNodeWithText("Replying from Android.", substring = true).assertIsDisplayed()
        DocumentTestHarness.dismissThreadSheet(composeRule)
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .performClick()
        composeRule.onNodeWithText("Replying from Android.", substring = true).assertIsDisplayed()
    }
}
