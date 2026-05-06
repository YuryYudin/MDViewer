// ---------------------------------------------------------------------------
// SafCapabilityBannerTest — host-JVM Compose coverage for the
// [SafCapabilityBanner] surface. The banner is a single clickable Text
// today (E3 wires the SaveSidecarToSource flow); we lock the wireframe
// copy and the tap dispatch so a future restyle keeps both reachable.
//
// Why Robolectric @Config(sdk = [33]): mirrors SelectionPopoverTest +
// CommentsListSheetTest. createComposeRule() needs a host activity which
// Robolectric stubs at SDK 33.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class SafCapabilityBannerTest {

    @get:Rule val composeRule = createComposeRule()

    @Test
    fun banner_renders_wireframe_copy() {
        composeRule.setContent { SafCapabilityBanner() }
        composeRule.onNodeWithText(
            "Comments saved on device — tap to share back",
            substring = true,
        ).assertIsDisplayed()
    }

    @Test
    fun tapping_the_banner_dispatches_on_tap_callback() {
        // Tap dispatch is the seam E3 wires to the SaveSidecarToSource
        // flow; locking the count here makes the future swap a one-liner.
        var taps = 0
        composeRule.setContent { SafCapabilityBanner(onTap = { taps += 1 }) }

        composeRule.onNodeWithText("Comments saved on device", substring = true)
            .performClick()

        assertEquals(1, taps, "tap must fire onTap exactly once")
    }
}
