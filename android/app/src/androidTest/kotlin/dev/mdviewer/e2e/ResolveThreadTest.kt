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
 * Covers "Resolve a thread": tapping Resolve in `wireframes/06-thread-detail.html`
 * marks the thread resolved and dims the in-document highlight, matching
 * `wireframes/04-document-view.html`'s resolved-anchored span styling.
 *
 * RED until Phase D lands the resolve action and the dimmed-highlight CSS
 * the WebView renders for resolved spans.
 */
@RunWith(AndroidJUnit4::class)
class ResolveThreadTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun openSampleWithSidecar() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        DocumentTestHarness.openSampleWithExistingSidecar(composeRule)
    }

    @Test
    fun resolve_dims_highlight() {
        // Given: an open thread with a desktop-authored comment.
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .performClick()
        composeRule.onNodeWithText("This thread came from desktop.", substring = true)
            .assertIsDisplayed()

        // When: the user taps Resolve.
        composeRule.onNodeWithText("Resolve", substring = true).performClick()

        // Then: the thread is marked resolved (status indicator visible) and
        // the in-document highlight is rendered as the dimmed/resolved variant.
        composeRule.onNodeWithText("Resolved", substring = true).assertIsDisplayed()
        DocumentTestHarness.dismissThreadSheet(composeRule)
        composeRule.onNodeWithContentDescription("Anchored highlight (resolved)", substring = true)
            .assertIsDisplayed()
    }
}
