package dev.mdviewer.e2e

import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.MainActivity
import dev.mdviewer.e2e.helpers.ResetState
import dev.mdviewer.e2e.helpers.SampleAssets
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Covers the Drive `ACTION_VIEW` -> document acceptance scenario.
 *
 * Per the A1 spec: do NOT use `androidx.test.espresso.intent.Intents` here —
 * the manifest filter only lands in B4. We launch a synthetic ACTION_VIEW
 * intent via [ActivityScenario] so the test only depends on Compose+JUnit4.
 *
 * RED until Phases B4 (manifest filter) + D (DocumentScreen) land.
 */
@RunWith(AndroidJUnit4::class)
class OpenFromDriveActionViewTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun resetState() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
    }

    @Test
    fun action_view_routes_to_document() {
        // Given: a `content://` URI for a sample.md staged from androidTest assets.
        val sampleUri = SampleAssets.stageSampleMarkdownAsContentUri()

        // When: the user taps a `.md` in Drive and chooses MDViewer
        // (modeled here as launching MainActivity with ACTION_VIEW + the URI).
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(sampleUri, "text/markdown")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ActivityScenario.launch<MainActivity>(intent).use {
            // Then: the rendered document appears (matches `wireframes/04-document-view.html`).
            composeRule.onNodeWithText("Sample Document", substring = true).assertIsDisplayed()
            composeRule.onNodeWithText(
                "This is a paragraph reviewers might highlight",
                substring = true,
            ).assertIsDisplayed()
        }
    }

    @Test
    fun action_view_adds_to_recents() {
        // Given: a sample.md content URI staged from androidTest assets.
        val sampleUri = SampleAssets.stageSampleMarkdownAsContentUri()

        // When: ACTION_VIEW opens the doc, then the user navigates back to recents.
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(sampleUri, "text/markdown")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }

            // Then: `wireframes/03-recents.html` lists the file just opened.
            composeRule.onNodeWithText("sample.md", substring = true).assertIsDisplayed()
        }
    }
}
