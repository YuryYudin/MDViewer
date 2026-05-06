// ---------------------------------------------------------------------------
// AuthorPaletteTest — host-JVM coverage for the eight-swatch palette pinned
// in [AuthorPalette]. This is a compile-time data table, but the table is
// load-bearing in two places:
//
//   1. ProfileSetupScreen renders one circle per entry — drift in the size
//      of this list silently changes the form.
//   2. The hex strings are persisted into [dev.mdviewer.data.Profile.color];
//      a casing change ("#f44336" vs "#F44336") would invalidate every
//      previously-saved profile because the persistence layer compares as
//      raw strings.
//
// We pin both: the count is exactly eight, every hex is the canonical
// "#RRGGBB" upper-case form, and the [AuthorSwatch.color] component matches
// the [AuthorSwatch.hex] string when both are reduced to a 6-digit hex.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.ui.graphics.toArgb
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class AuthorPaletteTest {

    @Test
    fun palette_has_exactly_eight_entries() {
        // Eight is the wireframe-locked count; see the wireframe stylesheet
        // (`--author-1`..`--author-8`) and the doc-block on AuthorPalette.kt.
        assertEquals(8, AuthorPalette.size)
    }

    @Test
    fun every_hex_is_canonical_upper_case_six_digit_form() {
        AuthorPalette.forEachIndexed { i, swatch ->
            assertTrue(
                swatch.hex.matches(Regex("#[0-9A-F]{6}")),
                "swatch[$i].hex must be '#RRGGBB' upper-case; got '${swatch.hex}'",
            )
        }
    }

    @Test
    fun color_argb_matches_declared_hex() {
        // Walk every entry and assert the Compose Color argb (low 24 bits)
        // matches the hex string. Catches a typo in either column the moment
        // it lands.
        AuthorPalette.forEach { swatch ->
            val rgbFromColor = swatch.color.toArgb() and 0x00FFFFFF
            val rgbFromHex = swatch.hex.removePrefix("#").toInt(16)
            assertEquals(
                rgbFromHex,
                rgbFromColor,
                "swatch hex ${swatch.hex} must match its Color argb",
            )
        }
    }

    @Test
    fun first_swatch_matches_wireframe_red() {
        // The wireframe's `--author-1` is #F44336. Pin the order so a
        // refactor that re-shuffles the list flips this red.
        assertEquals("#F44336", AuthorPalette.first().hex)
    }
}

