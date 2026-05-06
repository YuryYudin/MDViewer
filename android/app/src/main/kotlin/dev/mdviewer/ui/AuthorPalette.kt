// ---------------------------------------------------------------------------
// AuthorPalette — the eight-swatch colour set the profile-setup screen
// (wireframes/02-profile-setup.html) and any future "change your colour"
// affordance offers. A user picking the same swatch on Android and on
// desktop reads as the same person at a glance, so the palette is a
// cross-platform contract — desktop pulls the same eight values from
// `wireframes/styles.css` (the `--author-N` custom properties).
//
// Why exactly these eight (and in this order):
//   * The wireframe pins them. The selected swatch in `02-profile-setup.html`
//     is `--author-4` (the 1-based green) — keeping the order means the
//     wireframe screenshot stays a useful visual reference for testers.
//   * Desktop's wireframe-shared CSS uses the same values; if the desktop
//     palette ever shifts (e.g. an accessibility audit drops yellow for
//     poor contrast on light surfaces), the change MUST land here in the
//     same PR so the cross-device read still works.
//   * Eight is the lowest common multiple of "enough variety to disambiguate
//     a small team" (4-6) and "fits a single row on the narrowest phone we
//     support" (the wireframe lays them out 4-up, two rows). More than eight
//     starts to wrap awkwardly on 360dp screens.
//
// Hex format note: the strings are upper-case, six-digit, leading-`#`. The
// `Profile.color` field is persisted with the same format so an equality
// check between a stored profile and a swatch in this list is a direct
// string compare. Do not normalise to lower-case — it would invalidate
// every previously-saved profile.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.ui.graphics.Color

/**
 * One swatch in the [AuthorPalette]. Carries both the [Color] used by the
 * Compose surface (rounded circle background) and the canonical [hex]
 * string that gets persisted to the [dev.mdviewer.data.Profile.color]
 * field. The two are kept in lock-step here so callers never have to
 * convert between formats inline (and so a future shifting of one without
 * the other surfaces as a compile-time edit, not a runtime mismatch).
 */
data class AuthorSwatch(
    val color: Color,
    val hex: String,
)

/**
 * The canonical eight-swatch palette. Order matches `wireframes/styles.css`'s
 * `--author-1`..`--author-8` custom properties and the wireframe's swatch-
 * grid order. Desktop reads from the same source — if you change anything
 * here, mirror it in the wireframe stylesheet AND in any desktop-side
 * palette table.
 *
 * Hex values mirror the wireframe:
 *   1: #F44336 — red
 *   2: #FF9800 — orange
 *   3: #FFEB3B — yellow
 *   4: #4CAF50 — green
 *   5: #00BCD4 — cyan
 *   6: #2196F3 — blue
 *   7: #9C27B0 — purple
 *   8: #E91E63 — pink
 */
val AuthorPalette: List<AuthorSwatch> = listOf(
    AuthorSwatch(Color(0xFFF44336), "#F44336"),
    AuthorSwatch(Color(0xFFFF9800), "#FF9800"),
    AuthorSwatch(Color(0xFFFFEB3B), "#FFEB3B"),
    AuthorSwatch(Color(0xFF4CAF50), "#4CAF50"),
    AuthorSwatch(Color(0xFF00BCD4), "#00BCD4"),
    AuthorSwatch(Color(0xFF2196F3), "#2196F3"),
    AuthorSwatch(Color(0xFF9C27B0), "#9C27B0"),
    AuthorSwatch(Color(0xFFE91E63), "#E91E63"),
)
