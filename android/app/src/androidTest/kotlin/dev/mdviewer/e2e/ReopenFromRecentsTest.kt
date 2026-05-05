package dev.mdviewer.e2e

import androidx.compose.ui.test.assertIsDisplayed
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
 * Covers "Re-open from recents": tapping a previously opened doc on
 * `wireframes/03-recents.html` reopens DocumentScreen with all prior
 * threads still anchored.
 *
 * RED until Phases C (Recents) + D (DocumentScreen + HighlightInjector) land.
 */
@RunWith(AndroidJUnit4::class)
class ReopenFromRecentsTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun seedRecentsWithOpenedDoc() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        // Open the sample once so it shows up in recents, then back out.
        DocumentTestHarness.openSampleWithExistingSidecar(composeRule)
        DocumentTestHarness.navigateBackToRecents(composeRule)
    }

    @Test
    fun recents_tap_reopens_doc() {
        // Given: recents now lists `sample.md`.
        composeRule.onNodeWithText("sample.md", substring = true).assertIsDisplayed()

        // When: the user taps the recents row.
        composeRule.onNodeWithText("sample.md", substring = true).performClick()

        // Then: DocumentScreen is shown with the rendered sample document.
        composeRule.onNodeWithText("Sample Document", substring = true).assertIsDisplayed()
    }

    @Test
    fun threads_re_anchor_on_reopen() {
        // Given: the user re-opens a document that previously had an anchored
        // thread from desktop.
        composeRule.onNodeWithText("sample.md", substring = true).performClick()

        // Then: the same anchored highlight is visible (re-anchored against
        // the freshly-loaded document text via the same Bitap selector path
        // desktop uses).
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .performClick()
        composeRule.onNodeWithText("This thread came from desktop.", substring = true)
            .assertIsDisplayed()
    }
}
