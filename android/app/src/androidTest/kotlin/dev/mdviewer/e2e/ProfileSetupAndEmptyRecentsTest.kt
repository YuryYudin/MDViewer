package dev.mdviewer.e2e

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.MainActivity
import dev.mdviewer.e2e.helpers.ResetState
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Covers the profile-setup wireframe (`wireframes/02-profile-setup.html`)
 * and the empty-state recents wireframe (`wireframes/01-startup-empty.html`).
 *
 * RED until Phase C lands `ProfileSetupScreen` + `RecentsScreen`.
 */
@RunWith(AndroidJUnit4::class)
class ProfileSetupAndEmptyRecentsTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Before
    fun resetProfileAndRecents() {
        // Given: fresh install — clear profile + recents DataStore.
        ResetState.clearProfileAndRecents()
    }

    @Test
    fun profile_setup_continue_disabled_until_name_and_color_chosen() {
        // Given: fresh install, app launches into profile setup.
        // When: no name and no color have been provided yet.
        // Then: the Continue button is rendered but disabled.
        composeRule.onNodeWithText("Pick a display name", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Continue").assertIsNotEnabled()

        // When: the user types a display name and picks a swatch.
        composeRule.onNodeWithText("Display name", substring = true).performTextInput("Reviewer")
        composeRule.onNodeWithContentDescription("Color swatch 1", substring = true).performClick()

        // Then: Continue becomes enabled.
        composeRule.onNodeWithText("Continue").assertIsEnabled()
    }

    @Test
    fun profile_setup_skip_path_yields_default_identity() {
        // Given: fresh install, profile setup is shown.
        // When: the user taps "Skip for now".
        composeRule.onNodeWithText("Skip for now", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Skip for now", substring = true).performClick()

        // Then: navigation lands on Recents (default identity is assigned).
        composeRule.onNodeWithContentDescription("Open file").assertIsDisplayed()
    }

    @Test
    fun empty_recents_after_profile_setup_shows_fab_and_drive_nudge() {
        // Given: profile setup completed (name + color chosen, Continue tapped).
        composeRule.onNodeWithText("Display name", substring = true).performTextInput("Reviewer")
        composeRule.onNodeWithContentDescription("Color swatch 1", substring = true).performClick()
        composeRule.onNodeWithText("Continue").performClick()

        // When: navigation lands on the empty Recents screen.
        // Then: the "Open file" FAB and the Drive nudge card are visible.
        composeRule.onNodeWithContentDescription("Open file").assertIsDisplayed()
        composeRule.onNodeWithText("Open with", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("MDViewer", substring = true).assertIsDisplayed()
    }
}
