// ---------------------------------------------------------------------------
// SelectionPopover — Compose surface for the Comment / Copy affordance that
// anchors above the user's text selection per `wireframes/06-thread-detail.html`.
//
// Why a `Modifier.offset { ... }` Surface (and NOT Compose's `Popup`):
//   - The default `Popup` clips against the host window's decoration
//     boundary. When the user selects text near the screen edge (a
//     common case on phones with edge-to-edge content) the popup is
//     silently clipped or pushed off-screen. The wireframe puts the
//     popover above-or-below the selection regardless of edge proximity,
//     so we use `Modifier.offset { ... }` against an absolutely-positioned
//     `Surface` instead. The hosting Box (in [ThreadOverlay]) stays inside
//     the activity content frame, so the popover never leaves the user's
//     reachable area.
//
// Pure presentation surface — no business logic:
//   - Receives the screen-space anchor [rect] and dispatches tap events
//     through [onComment] / [onCopy]. The wireframe-locked surface must be
//     trivially reskinnable; lifting the dispatch out into the consumer
//     ([ThreadOverlay]) keeps this composable testable in isolation.
//
// Why the rect arrives as `android.graphics.Rect`:
//   - That's the type the WebView's ActionMode `onGetContentRect` callback
//     hands us via [SelectionBridge.onActionModeContentRect]. Converting to
//     `androidx.compose.ui.geometry.Rect` here would force the bridge to
//     carry a Compose-shaped type just for this composable; instead we
//     keep the bridge platform-agnostic and convert at the consumer.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.graphics.Rect
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp

/**
 * The pixel offset (in dp) that lifts the popover above the selection
 * rect's top edge. Internal so [ThreadOverlay] (and, in D5, ThreadSheet)
 * can share the same lift constant when they need to anchor against the
 * same selection rect.
 */
internal const val POPOVER_LIFT_DP = 56

/**
 * Anchored Comment / Copy affordance that sits above the user's selection.
 *
 * Pure presentation: receives the screen-space anchor [rect] and dispatches
 * tap events through [onComment] / [onCopy]. No state of its own.
 *
 * Positioning: the popover is offset to (rect.left, rect.top - [POPOVER_LIFT_DP]).
 * The lift matches the wireframe's "popover sits one Material chip-height
 * above the highlighted span" rule and keeps the popover from overlapping
 * the user's caret.
 */
@Composable
fun SelectionPopover(
    rect: Rect,
    onComment: () -> Unit,
    onCopy: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val density = LocalDensity.current
    // Convert dp lift to pixels at the current density so the offset
    // tracks the system font scale and resolves identically on phones
    // and tablets. `IntOffset` consumes raw pixels.
    val liftPx = with(density) { POPOVER_LIFT_DP.dp.toPx().toInt() }

    Surface(
        modifier = modifier.offset { IntOffset(rect.left, rect.top - liftPx) },
        shadowElevation = 4.dp,
        tonalElevation = 1.dp,
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.padding(8.dp),
        ) {
            // No leading Icons here on purpose: `material-icons-extended`
            // ships ~3MB of vector assets we don't otherwise use and
            // pulling it in just for two glyphs would bloat the APK by
            // more than the entire :core AAR. The wireframe's Comment /
            // Copy text labels carry the affordance on their own.
            TextButton(onClick = onComment) { Text("Comment") }
            TextButton(onClick = onCopy) { Text("Copy") }
        }
    }
}
