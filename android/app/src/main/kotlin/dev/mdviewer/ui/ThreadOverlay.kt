// ---------------------------------------------------------------------------
// ThreadOverlay — Compose container that subscribes to a [SelectionBridge]
// state flow and decides which sheet/popover surface (if any) to mount.
//
// What this container is for:
//   - Acts as the single staging point for every D-phase comment surface:
//       D4 (this task) hosts SelectionPopover.
//       D5 will host ThreadSheet for SelectionEvent.HighlightTapped.
//       D6 will host CommentsListSheet (drawer affordance from the
//       wireframes/07-comments-list.html surface).
//   - Translates the raw bridge events into composable visibility decisions.
//     The popover, the sheet, and the drawer are themselves pure presentation;
//     only this container looks at the active SelectionEvent variant.
//
// What this container is NOT for:
//   - Painting highlights — those live INSIDE the WebView's DOM (D3 owns
//     the `<span class="anchored">` injection). Painting an overlay on top
//     of the WebView would double-render and miss the document's scroll
//     position. ThreadOverlay's job is anchoring affordances, not decorating
//     the document text.
//   - Owning the system clipboard — Android's ActionMode default-Copy path
//     handles primary-clip writes when D5 wires its sheet. The `onCopy`
//     stub here is intentional and documented.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import dev.mdviewer.render.Selection
import dev.mdviewer.render.SelectionBridge
import dev.mdviewer.render.SelectionEvent

/**
 * Compose container that subscribes to [bridge].state and mounts the
 * [SelectionPopover] only when there's an anchorable selection.
 *
 * Visibility table:
 *
 * | bridge state                              | popover    | rationale            |
 * | ---                                       | ---        | ---                  |
 * | Collapsed                                 | hidden     | no selection         |
 * | Updated(rect = null)                      | hidden     | no anchor yet        |
 * | Updated(rect = Rect)                      | shown      | anchor known         |
 * | HighlightTapped                           | hidden     | D5's surface         |
 *
 * Why we exhaust the sealed [SelectionEvent] without an `else` branch:
 *   - Kotlin's compiler enforces exhaustive `when` over a sealed
 *     interface in a `val` position, so the next phase that adds a new
 *     event variant breaks this `when` at compile time and forces the
 *     overlay to declare its policy explicitly.
 */
@Composable
fun ThreadOverlay(
    bridge: SelectionBridge,
    onComment: (Selection) -> Unit,
    modifier: Modifier = Modifier,
) {
    val event by bridge.state.collectAsState()
    Box(modifier = modifier.fillMaxSize()) {
        when (val e = event) {
            is SelectionEvent.Updated -> {
                val rect = e.selection.rect
                if (rect != null) {
                    SelectionPopover(
                        rect = rect,
                        onComment = { onComment(e.selection) },
                        // The system clipboard is owned by Android's
                        // ActionMode default-Copy path; once D5 wires the
                        // sheet, the overlay will route Copy through
                        // `ClipboardManager.setPrimaryClip` here. For now
                        // the callback is a no-op so the popover stays
                        // visually consistent with the wireframe.
                        onCopy = { /* clipboard wiring lands in D5 */ },
                    )
                }
            }
            // D5 owns the ThreadSheet for tapped highlights; D4 deliberately
            // does nothing here so the popover doesn't flicker open while
            // the user is engaging with an existing thread.
            is SelectionEvent.HighlightTapped -> Unit
            SelectionEvent.Collapsed -> Unit
        }
    }
}
