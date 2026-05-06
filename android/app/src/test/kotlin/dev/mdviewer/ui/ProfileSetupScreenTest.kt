// ---------------------------------------------------------------------------
// ProfileSetupScreenTest — host-JVM Compose coverage for the [ProfileSetupScreen]
// surface (E1, wireframe `wireframes/02-profile-setup.html`). The
// [ProfileSetupAndEmptyRecentsTest] e2e spec under `androidTest/` covers the
// emulator round-trip; this test fixes the wireframe-mandated copy + the
// Continue-disabled-until-both-set rule + the swatch-tap dispatch on every
// commit without an emulator hop.
//
// What we lock in here:
//   1. The wireframe-required heading copy ("Pick a display name") and the
//      Skip/Continue button labels render. The A1 e2e spec hard-targets
//      these strings; if a refactor renames any of them the spec goes red,
//      so the rule belongs on the surface itself.
//   2. The eight swatches each carry a stable "Color swatch N" (1-based)
//      content description so the e2e spec can target a specific swatch
//      without a positional query.
//   3. Continue is rendered disabled with a fresh form (no name, no color)
//      and flips to enabled once both fields are populated.
//   4. Tapping Skip routes through the ViewModel's `skip` path (which the
//      ViewModel test already pins to "writes anonymous + fires onDone")
//      and the screen's `onDone` callback fires. We don't re-assert the
//      anonymous-profile contract here — it's already pinned in
//      [ProfileSetupViewModelTest] and a duplicated assertion would couple
//      this test to the ViewModel's internal storage shape.
//   5. Tapping Continue with both fields filled fires `onDone` exactly once.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class ProfileSetupScreenTest {

    @get:Rule val composeRule = createComposeRule()

    private val testDispatcher = StandardTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(testDispatcher) }
    @After fun tearDown() { Dispatchers.resetMain() }

    private fun newVm(store: RecordingStore = RecordingStore()): ProfileSetupViewModel =
        ProfileSetupViewModel(store)

    @Test
    fun renders_wireframe_copy_and_disabled_continue_on_fresh_form() {
        composeRule.setContent { ProfileSetupScreen(newVm()) {} }

        // Heading + button copy must match the A1 e2e spec verbatim.
        composeRule.onNodeWithText("Pick a display name", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Skip for now", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Continue").assertIsDisplayed()
        composeRule.onNodeWithText("Continue").assertIsNotEnabled()
    }

    @Test
    fun all_eight_swatches_carry_one_based_content_descriptions() {
        composeRule.setContent { ProfileSetupScreen(newVm()) {} }

        for (i in 1..8) {
            // 1-based: the e2e spec targets "Color swatch 1" as the first
            // wireframe swatch. We assert all eight here so a future change
            // to the palette size flips the test red rather than silently
            // dropping a swatch.
            composeRule.onNodeWithContentDescription("Color swatch $i", substring = true)
                .assertExists()
        }
    }

    @Test
    fun continue_enables_once_both_fields_are_set() = runTest {
        composeRule.setContent { ProfileSetupScreen(newVm()) {} }

        composeRule.onNodeWithText("Continue").assertIsNotEnabled()

        composeRule.onNodeWithText("Display name", substring = true)
            .performTextInput("Reviewer")
        // The combine() flow that drives canContinue runs through
        // viewModelScope on the test dispatcher; pump it so the new
        // value lands in the StateFlow before we assert.
        advanceUntilIdle()
        composeRule.waitForIdle()
        // Name only — still disabled.
        composeRule.onNodeWithText("Continue").assertIsNotEnabled()

        composeRule.onNodeWithContentDescription("Color swatch 1", substring = true)
            .performClick()
        advanceUntilIdle()
        composeRule.waitForIdle()
        // Both set — enabled.
        composeRule.onNodeWithText("Continue").assertIsEnabled()
    }

    @Test
    fun tapping_skip_fires_on_done_callback() = runTest {
        var doneCount = 0
        composeRule.setContent { ProfileSetupScreen(newVm()) { doneCount += 1 } }

        composeRule.onNodeWithText("Skip for now", substring = true).performClick()
        // Skip dispatches via viewModelScope.launch on the Main dispatcher,
        // which we routed through StandardTestDispatcher. Pump the scheduler
        // so the launched coroutine completes (write -> onDone).
        advanceUntilIdle()
        composeRule.waitForIdle()

        assertEquals(1, doneCount, "tapping Skip must fire onDone exactly once")
    }

    @Test
    fun tapping_continue_with_full_form_fires_on_done_callback() = runTest {
        var doneCount = 0
        composeRule.setContent { ProfileSetupScreen(newVm()) { doneCount += 1 } }

        composeRule.onNodeWithText("Display name", substring = true)
            .performTextInput("Reviewer")
        composeRule.onNodeWithContentDescription("Color swatch 4", substring = true)
            .performClick()
        // Drive the canContinue update through the test dispatcher so the
        // Continue button is actually enabled by the time we click it.
        advanceUntilIdle()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Continue").performClick()
        advanceUntilIdle()
        composeRule.waitForIdle()

        assertEquals(1, doneCount, "tapping Continue must fire onDone exactly once")
    }
}

// ---------------------------------------------------------------------------
// File-private fakes — distinct name from
// [ProfileSetupViewModelTest.RecordingProfileStore] because Kotlin top-level
// declarations can't share simple names across the same package even when
// both are `private`.
// ---------------------------------------------------------------------------

/**
 * In-memory [ProfileStoreApi] for the screen-level test. Mirrors the recording
 * fake in [ProfileSetupViewModelTest] but lives under a different name to
 * avoid a same-package redeclaration; the screen test doesn't assert on the
 * persisted bytes so we keep the fake minimal.
 */
private class RecordingStore : ProfileStoreApi {
    val saved: MutableList<Profile> = mutableListOf()
    override suspend fun get(): Profile = saved.lastOrNull() ?: Profile.anonymous()
    override suspend fun save(profile: Profile) { saved += profile }
}
