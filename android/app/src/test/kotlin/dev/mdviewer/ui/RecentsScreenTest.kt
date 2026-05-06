// ---------------------------------------------------------------------------
// RecentsScreenTest — host-JVM Compose coverage for the [RecentsScreen]
// landing destination. We pin two visible states + the FAB:
//
//   * Empty list -> wireframe-locked "No documents yet" copy + onboarding
//     hint string.
//   * Populated list -> each row shows the displayName headline + URI
//     supporting text. Tapping a row dispatches the parsed Uri up to the
//     `onOpen` callback.
//   * The FAB is mounted with the [Placeholders.FAB_OPEN_FILE_TAG] tag and
//     contains the "Open file" content-description so the e2e suite + the
//     production tests can target it identically.
//
// Why Robolectric @Config(sdk = [33]): mirrors CommentsListSheetTest +
// SelectionPopoverTest. createComposeRule() needs a host
// ComponentActivity which Robolectric stubs at SDK 33; the FAB's
// `rememberLauncherForActivityResult` resolves through the activity's
// [ActivityResultRegistry] which the same stub satisfies.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import android.net.Uri
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.Placeholders
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
import kotlin.test.assertEquals

@OptIn(ExperimentalMaterial3Api::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class RecentsScreenTest {

    @get:Rule val composeRule = createComposeRule()

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() { Dispatchers.setMain(testDispatcher) }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun empty_recents_renders_onboarding_copy() = runTest {
        val recents = FakeRecents()
        val vm = RecentsViewModel(recents)
        advanceUntilIdle()

        composeRule.setContent {
            RecentsScreen(vm = vm, onOpen = {})
        }

        // Wireframe-locked empty-state copy.
        composeRule.onNodeWithText("No documents yet").assertIsDisplayed()
        composeRule.onNodeWithText(
            "Open a .md from Drive or your file manager to get started.",
            substring = true,
        ).assertIsDisplayed()
    }

    @Test
    fun fab_renders_with_test_tag_and_open_file_description() = runTest {
        val recents = FakeRecents()
        val vm = RecentsViewModel(recents)
        advanceUntilIdle()

        composeRule.setContent {
            RecentsScreen(vm = vm, onOpen = {})
        }

        // The e2e suite locates the FAB by tag; the production composable
        // applies the same constant.
        composeRule.onNodeWithTag(Placeholders.FAB_OPEN_FILE_TAG).assertIsDisplayed()
        // The Icon's content-description is the accessibility hook the
        // future TalkBack flow will read.
        composeRule.onNodeWithContentDescription("Open file").assertIsDisplayed()
    }

    @Test
    fun populated_list_renders_display_name_and_uri_for_each_entry() = runTest {
        val recents = FakeRecents()
        recents.recordOpen("content://t/alpha", "alpha.md", SafTier.SingleUri)
        recents.recordOpen("content://t/bravo", "bravo.md", SafTier.TreeAccess)
        val vm = RecentsViewModel(recents)
        advanceUntilIdle()

        composeRule.setContent {
            RecentsScreen(vm = vm, onOpen = {})
        }

        // Both display names land as headline content.
        composeRule.onNodeWithText("alpha.md").assertIsDisplayed()
        composeRule.onNodeWithText("bravo.md").assertIsDisplayed()
        // Both URIs land as supporting content.
        composeRule.onNodeWithText("content://t/alpha").assertIsDisplayed()
        composeRule.onNodeWithText("content://t/bravo").assertIsDisplayed()
    }

    @Test
    fun tapping_a_row_dispatches_parsed_uri_to_on_open() = runTest {
        val recents = FakeRecents()
        recents.recordOpen("content://t/alpha", "alpha.md", SafTier.SingleUri)
        val vm = RecentsViewModel(recents)
        advanceUntilIdle()

        val opens = mutableListOf<Uri>()
        composeRule.setContent {
            RecentsScreen(vm = vm, onOpen = { opens += it })
        }

        // The headline is the cleanest stable target for the row click;
        // Compose's clickable modifier merges descendants so the tap
        // propagates to the row container.
        composeRule.onNodeWithText("alpha.md").performClick()

        assertEquals(1, opens.size, "tap must fire onOpen exactly once")
        assertEquals(Uri.parse("content://t/alpha"), opens.single())
    }
}
