package dev.mdviewer.e2e

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.MainActivity
import dev.mdviewer.e2e.helpers.DocumentTestHarness
import dev.mdviewer.e2e.helpers.ResetState
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Covers "Sidebar review of all threads": the comments drawer
 * (`wireframes/07-comments-list.html`) lists every thread in the document
 * and the show-resolved toggle filters resolved threads in/out.
 *
 * RED until Phase D lands `CommentsListSheet` plus the resolved toggle.
 */
@RunWith(AndroidJUnit4::class)
class CommentsListSidebarTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun openDocumentWithMixedThreads() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        // Stages the sample doc with one open thread and one resolved thread,
        // so the toggle has something to filter.
        DocumentTestHarness.openSampleWithMixedOpenAndResolvedThreads(composeRule)
    }

    @Test
    fun drawer_lists_threads() {
        // Given: the document is open with multiple threads.
        // When: the user opens the comments drawer.
        composeRule.onNodeWithContentDescription("Comments", substring = true).performClick()

        // Then: the drawer lists every thread (default: open + resolved both visible
        // when show-resolved is on, matching `wireframes/07-comments-list.html`).
        composeRule.onNodeWithText("This thread came from desktop.", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithText("Already addressed.", substring = true).assertIsDisplayed()
    }

    @Test
    fun show_resolved_toggle_filters() {
        // Given: the comments drawer is open with both open and resolved threads listed.
        composeRule.onNodeWithContentDescription("Comments", substring = true).performClick()
        composeRule.onNodeWithText("Already addressed.", substring = true).assertIsDisplayed()

        // When: the user turns off "Show resolved".
        composeRule.onNodeWithText("Show resolved", substring = true).performClick()

        // Then: only the open thread remains; the resolved one is hidden.
        composeRule.onNodeWithText("This thread came from desktop.", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithText("Already addressed.", substring = true).assertIsNotDisplayed()
    }
}
