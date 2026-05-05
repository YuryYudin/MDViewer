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
 * Covers "Theme switching": picking Dark in `wireframes/08-settings.html`
 * applies dark theme without restart, matching `wireframes/09-dark-document.html`.
 *
 * RED until Phase E lands SettingsScreen + the theme controller wiring
 * (Compose `MaterialTheme` reacts to the `SettingsStore.theme` flow).
 */
@RunWith(AndroidJUnit4::class)
class ThemeSwitchTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun openSampleDocument() {
        ResetState.clearProfileAndRecents()
        ResetState.completeProfileSetupWithDefaults()
        ResetState.setLightTheme()
        DocumentTestHarness.openSampleWithoutSidecar(composeRule)
    }

    @Test
    fun dark_theme_applies_without_restart() {
        // Given: a document is open in light theme.
        composeRule.onNodeWithText("Sample Document", substring = true).assertIsDisplayed()

        // When: the user opens Settings and picks Dark.
        composeRule.onNodeWithContentDescription("Open settings", substring = true).performClick()
        composeRule.onNodeWithText("Dark", substring = true).performClick()
        composeRule.onNodeWithContentDescription("Close settings", substring = true).performClick()

        // Then: the document re-renders in dark theme without an Activity restart
        // (the test rule never re-launched MainActivity), matching wireframe 09.
        composeRule.onNodeWithText("Sample Document", substring = true).assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Theme: dark", substring = true)
            .assertIsDisplayed()
    }
}
