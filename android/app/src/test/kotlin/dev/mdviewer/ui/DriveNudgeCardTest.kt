// ---------------------------------------------------------------------------
// DriveNudgeCardTest — host-JVM Compose coverage for the [DriveNudgeCard]
// empty-state nudge that explains the "Open with -> MDViewer" Drive
// flow per `wireframes/01-startup-empty.html`.
//
// Two pinned behaviors:
//   * The card itself contains the "Open with" + "MDViewer" instructional
//     copy — this is the load-bearing string the e2e
//     `empty_recents_after_profile_setup_shows_fab_and_drive_nudge` test
//     also asserts against. Wireframe drift here cascades into the e2e.
//   * RecentsScreen mounts the card *only* when recents is empty. The
//     populated-list path must hide it — clutter on a populated screen
//     is hostile per the E5 spec's "Avoid" section.
//
// Why Robolectric @Config(sdk = [33]): mirrors RecentsScreenTest +
// SafCapabilityBannerTest. createComposeRule() needs a host
// ComponentActivity which Robolectric stubs at SDK 33.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.data.SafTier
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

@OptIn(ExperimentalMaterial3Api::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class DriveNudgeCardTest {

    @get:Rule val composeRule = createComposeRule()

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() { Dispatchers.setMain(testDispatcher) }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun nudge_card_contains_open_with_mdviewer_copy() {
        composeRule.setContent { DriveNudgeCard() }
        // Wireframe-locked headline.
        composeRule.onNodeWithText("Reading from Drive?", substring = true)
            .assertIsDisplayed()
        // The canonical instruction the e2e suite also asserts against.
        composeRule.onNodeWithText("Open with", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithText("MDViewer", substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun recents_screen_renders_nudge_when_recents_empty() = runTest {
        val recents = FakeRecents()
        val vm = RecentsViewModel(recents)
        advanceUntilIdle()

        composeRule.setContent { RecentsScreen(vm = vm, onOpen = {}) }

        composeRule.onNodeWithText("Reading from Drive?", substring = true)
            .assertIsDisplayed()
        composeRule.onNodeWithText("Open with", substring = true)
            .assertIsDisplayed()
    }

    @Test
    fun recents_screen_hides_nudge_when_entries_present() = runTest {
        val recents = FakeRecents()
        recents.recordOpen("content://t/alpha", "alpha.md", SafTier.SingleUri)
        val vm = RecentsViewModel(recents)
        advanceUntilIdle()

        composeRule.setContent { RecentsScreen(vm = vm, onOpen = {}) }

        // Populated path must NOT mount the nudge — the headline is the
        // cleanest "is the card here?" probe because it doesn't collide
        // with any other RecentsScreen string.
        composeRule.onNodeWithText("Reading from Drive?", substring = true)
            .assertDoesNotExist()
    }
}
