package dev.mdviewer.e2e

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.MainActivity
import dev.mdviewer.e2e.helpers.DocumentTestHarness
import dev.mdviewer.e2e.helpers.ReloadFixtures
import dev.mdviewer.e2e.helpers.ResetState
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Covers "Manual reload picks up out-of-band edits"
 * (`wireframes/10-reload-toast.html`).
 *
 * Three scenarios:
 *  - reload imports the new desktop thread (`reload-with-extra-thread.md.comments.json`)
 *  - reload preserves a thread the user posted locally between the original
 *    open and the reload
 *  - the snackbar reports the count of newly imported threads
 *
 * RED until Phase E lands `ReloadAction` + `merge_stores` plumbing through
 * `DocumentRepository.reload(uri)`.
 */
@RunWith(AndroidJUnit4::class)
class ManualReloadTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun openSampleWithSidecar() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        DocumentTestHarness.openSampleWithExistingSidecar(composeRule)
    }

    @Test
    fun reload_imports_new_threads() {
        // Given: the doc is open with the original sidecar (one thread).
        composeRule.onNodeWithContentDescription("Anchored highlight", substring = true)
            .assertIsDisplayed()

        // When: a desktop edit replaces the sidecar with the extra-thread fixture
        // and the user taps Reload from the overflow.
        ReloadFixtures.replaceSidecarWithExtraThreadFixture()
        composeRule.onNodeWithContentDescription("More", substring = true).performClick()
        composeRule.onNodeWithText("Reload", substring = true).performClick()

        // Then: the second (desktop-added) thread is now anchored in the doc.
        composeRule.onNodeWithText(
            "Another paragraph for the second-thread fixture.",
            substring = true,
        ).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Anchored highlight: t-reload-2", substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun reload_preserves_local_threads() {
        // Given: between open and reload, the user posts a local thread.
        DocumentTestHarness.postLocalThread(
            composeRule,
            body = "Local thread that must survive reload.",
        )

        // When: the desktop sidecar gets a new thread out-of-band, then Reload runs.
        ReloadFixtures.replaceSidecarWithExtraThreadFixture()
        composeRule.onNodeWithContentDescription("More", substring = true).performClick()
        composeRule.onNodeWithText("Reload", substring = true).performClick()

        // Then: the local thread is still present (Automerge merge_stores preserves it).
        composeRule.onNodeWithText("Local thread that must survive reload.", substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun snackbar_reports_delta() {
        // Given: one new thread on the desktop side, no local edits.
        ReloadFixtures.replaceSidecarWithExtraThreadFixture()

        // When: the user taps Reload.
        composeRule.onNodeWithContentDescription("More", substring = true).performClick()
        composeRule.onNodeWithText("Reload", substring = true).performClick()

        // Then: the snackbar reports the number of newly imported threads.
        composeRule.onNodeWithText("1 new comment", substring = true).assertIsDisplayed()
    }
}
