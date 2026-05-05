package dev.mdviewer.e2e

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.MainActivity
import dev.mdviewer.e2e.helpers.ResetState
import dev.mdviewer.e2e.helpers.SampleAssets
import org.hamcrest.CoreMatchers.allOf
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Covers "Open via in-app picker": tapping the Recents FAB launches
 * `ACTION_OPEN_DOCUMENT` and a `.md` selection routes to DocumentScreen.
 *
 * Note: A1's "do not import Intents" guard refers specifically to ACTION_VIEW
 * inbound assertions (which need the manifest filter from B4). Stubbing the
 * outbound chooser here is fine — it does not depend on the manifest at all.
 *
 * RED until Phases B5 (Compose entry points) + D (DocumentScreen) land.
 */
@RunWith(AndroidJUnit4::class)
class OpenViaInAppPickerTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun resetState() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        Intents.init()
    }

    @After
    fun tearDownIntents() {
        Intents.release()
    }

    @Test
    fun fab_launches_open_document() {
        // Given: the Recents screen.
        composeRule.onNodeWithContentDescription("Open file").assertIsDisplayed()

        // When: the user taps the Open file FAB.
        composeRule.onNodeWithContentDescription("Open file").performClick()

        // Then: the system file picker is launched (ACTION_OPEN_DOCUMENT).
        Intents.intended(allOf(hasAction(Intent.ACTION_OPEN_DOCUMENT)))
    }

    @Test
    fun picker_returns_md_routes_to_document() {
        // Given: a stub picker result returning a `.md` content URI.
        val sampleUri = SampleAssets.stageSampleMarkdownAsContentUri()
        val resultData = Intent().apply { data = sampleUri }
        val result = Instrumentation.ActivityResult(Activity.RESULT_OK, resultData)
        Intents.intending(hasAction(Intent.ACTION_OPEN_DOCUMENT)).respondWith(result)

        // When: the user taps the FAB and the picker "returns" the URI.
        composeRule.onNodeWithContentDescription("Open file").performClick()

        // Then: navigation lands on DocumentScreen with the rendered sample.
        composeRule.onNodeWithText("Sample Document", substring = true).assertIsDisplayed()
    }
}
