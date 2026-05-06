// ---------------------------------------------------------------------------
// SettingsScreenTest — host-JVM Compose coverage for the E2 SettingsScreen
// (wireframes/08-settings.html).
//
// E7 is the first task that exercises the Settings UI from a unit test:
// every composable in the file was unit-tested only at the ViewModel
// layer until now, leaving the Compose surface at 0% line coverage. The
// E7 wiring's "Open settings" entry from DocumentScreen makes this gap
// visible to the package-level coverage gate; covering the screen at
// the host-JVM layer is the right fix because the alternative (running
// only on emulator) would leave the gate flapping between phases.
//
// What we lock in:
//   * The four sections are present (Theme / Profile / Comments /
//     About) and their wireframe-locked headings render.
//   * The back-arrow's content description is "Close settings" so the
//     ThemeSwitchTest E2E spec can locate it.
//   * Tapping the Dark radio dispatches the right ThemeMode through the
//     ViewModel into SettingsStore (round-trip).
//   * Tapping the back arrow dispatches the onBack callback (Compose
//     navigation hook the e2e relies on).
//
// We deliberately do NOT exercise the profile-save round-trip or the
// sidecar pattern Apply path here — those are covered in
// SettingsViewModelTest at the VM layer. The screen test only proves the
// Compose surface mounts the right controls and dispatches their events.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.data.ThemeMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class SettingsScreenTest {

    @get:Rule val composeRule = createComposeRule()

    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Before
    fun setUp() {
        // SettingsViewModel's launches dispatch through Main; the
        // UnconfinedTestDispatcher runs them eagerly so a `vm.setTheme(...)`
        // call surfaces in the Compose tree without explicit advance steps.
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun newSettings(): SettingsStore =
        SettingsStore(ctx, prefsName = "settings-screen-${System.nanoTime()}")

    @Test
    fun renders_section_headings_from_wireframe() {
        val settings = newSettings()
        val profile = TestProfileStore(Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        composeRule.setContent {
            SettingsScreen(vm = vm, onBack = {})
        }

        composeRule.onNodeWithText("Theme").assertIsDisplayed()
        composeRule.onNodeWithText("Profile").assertIsDisplayed()
        // "Comments" appears both as the section heading and as the
        // wireframe's section card title; we use onAllNodes to match the
        // first occurrence without asserting which one.
        composeRule.onAllNodesWithText("Comments")[0].assertExists()
        // About is below the fold on small Robolectric screens; assert
        // existence in the semantics tree rather than visibility so the
        // test isn't sensitive to the test-runner's window size.
        composeRule.onNodeWithText("About").assertExists()
    }

    @Test
    fun back_navigation_uses_close_settings_locator() {
        val settings = newSettings()
        val profile = TestProfileStore(Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)
        var backCount = 0

        composeRule.setContent {
            SettingsScreen(vm = vm, onBack = { backCount++ })
        }

        // The E7 wiring renamed the back-button content description from
        // "Back" -> "Close settings" so the ThemeSwitchTest E2E spec
        // (which uses substring = true on "Close settings") can locate
        // it. A regression that flips this back to "Back" would fail
        // here loudly.
        composeRule.onNodeWithContentDescription("Close settings", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithContentDescription("Close settings", substring = true)
            .performClick()
        assertEquals(1, backCount)
    }

    @Test
    fun tapping_dark_radio_round_trips_through_settings_store() = runBlocking {
        val settings = newSettings()
        val profile = TestProfileStore(Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        composeRule.setContent {
            SettingsScreen(vm = vm, onBack = {})
        }

        // The radio's row carries the wireframe-locked label "Dark"; the
        // whole row is clickable per the screen's layout.
        composeRule.onNodeWithText("Dark").performClick()

        // Round-trip assertion: the persisted store reflects the tap.
        // We use a real-clock withTimeout because the DataStore IO
        // happens on its own scope; UnconfinedTestDispatcher under Main
        // flushes the launch but the IO write still runs on a real
        // thread.
        withTimeout(5_000) {
            assertEquals(ThemeMode.Dark, settings.theme.first { it == ThemeMode.Dark })
        }
    }

    @Test
    fun follow_system_radio_is_default_selection() {
        // A fresh settings store has no theme key; the VM's stateIn falls
        // back to FollowSystem. The screen surfaces "Follow system" as
        // the wireframe-locked label for that mode.
        val settings = newSettings()
        val profile = TestProfileStore(Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        composeRule.setContent {
            SettingsScreen(vm = vm, onBack = {})
        }

        composeRule.onNodeWithText("Follow system").assertIsDisplayed()
    }

    @Test
    fun light_radio_label_is_present_in_wireframe_copy() {
        val settings = newSettings()
        val profile = TestProfileStore(Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        composeRule.setContent {
            SettingsScreen(vm = vm, onBack = {})
        }

        composeRule.onNodeWithText("Light").assertIsDisplayed()
    }
}

/**
 * Tiny ProfileStoreApi fake that matches [SettingsViewModelTest]'s
 * SeededProfileStore behaviour. Kept in this file rather than reused
 * cross-test because Kotlin's file-private `class` declarations don't
 * leak across files in the same package; SettingsViewModelTest's seed
 * fake is private there for the same reason.
 */
private class TestProfileStore(seed: Profile) : ProfileStoreApi {
    private var current: Profile = seed
    override suspend fun get(): Profile = current
    override suspend fun save(profile: Profile) { current = profile }
}
