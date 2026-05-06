// ---------------------------------------------------------------------------
// ThreadOverlay — Compose container that subscribes to a [SelectionBridge]
// state flow and decides which sheet/popover surface (if any) to mount.
//
// What this container is for:
//   - Acts as the single staging point for every D-phase comment surface:
//       D4 hosts SelectionPopover.
//       D5 hosts ThreadSheet for SelectionEvent.HighlightTapped (wired by
//          the host alongside ThreadSheetViewModel).
//       D6 (this task) hosts CommentsListSheet (drawer affordance from
//          `wireframes/07-comments-list.html`) when the host opens it.
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
//   - Mutating thread state — the CommentsListSheet hosted here is a
//     navigator only; tapping a row delegates to the host (which closes
//     this drawer and opens the [ThreadSheet] for the chosen thread).
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import dev.mdviewer.core.Thread
import dev.mdviewer.render.Selection
import dev.mdviewer.render.SelectionBridge
import dev.mdviewer.render.SelectionEvent

/**
 * Compose container that subscribes to [bridge].state and mounts the
 * [SelectionPopover] only when there's an anchorable selection. Optionally
 * also mounts the [CommentsListSheet] drawer when [commentsListOpen] is
 * true.
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
 * The [CommentsListSheet] is independent of the bridge state — the host
 * opens it from a top-bar action regardless of the active selection. The
 * sheet is purely a navigator; tapping a row dispatches the chosen
 * thread id via [onCommentsListThreadClick] so the host can close the
 * drawer and open [ThreadSheet] for that id.
 *
 * Why we exhaust the sealed [SelectionEvent] without an `else` branch:
 *   - Kotlin's compiler enforces exhaustive `when` over a sealed
 *     interface in a `val` position, so the next phase that adds a new
 *     event variant breaks this `when` at compile time and forces the
 *     overlay to declare its policy explicitly.
 *
 * @param bridge selection event source — see SelectionBridge for the JS +
 *   ActionMode wiring.
 * @param onComment dispatched when the popover's "Comment" action is
 *   tapped, with the live [Selection] (text + offsets + rect).
 * @param commentsListOpen when `true`, the [CommentsListSheet] mounts on
 *   top of the bridge-driven popover surface. Default `false` so existing
 *   call sites that have not wired the drawer yet keep their old
 *   behaviour.
 * @param commentsListThreads thread snapshot rendered inside the drawer.
 *   The host reads this from `CommentsStoreHandle.threads()` and forwards
 *   the list down. Ignored when [commentsListOpen] is `false`.
 * @param showResolved when `false`, resolved threads are filtered out of
 *   the drawer. Wired by the host to
 *   [dev.mdviewer.data.SettingsStore.showResolved].
 * @param onShowResolvedChange dispatched when the drawer toggle flips;
 *   the host persists the new value through
 *   [dev.mdviewer.data.SettingsStore.setShowResolved].
 * @param onCommentsListThreadClick dispatched with the [Thread.id] of the
 *   tapped row. The host typically dismisses the drawer and opens the
 *   [ThreadSheet] for the same id.
 * @param onCommentsListDismiss dispatched when the user dismisses the
 *   drawer (back press, swipe-down, scrim tap).
 */
@Composable
fun ThreadOverlay(
    bridge: SelectionBridge,
    onComment: (Selection) -> Unit,
    modifier: Modifier = Modifier,
    commentsListOpen: Boolean = false,
    commentsListThreads: List<Thread> = emptyList(),
    showResolved: Boolean = false,
    onShowResolvedChange: (Boolean) -> Unit = {},
    onCommentsListThreadClick: (String) -> Unit = {},
    onCommentsListDismiss: () -> Unit = {},
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

        // D6: drawer with all comments. Mounted regardless of the bridge
        // state — the user reaches it from the top-bar action, not from a
        // selection. The sheet's own modal scrim takes over input
        // dispatch when it's open, so popover + drawer cannot be
        // simultaneously interactive.
        if (commentsListOpen) {
            CommentsListSheet(
                threads = commentsListThreads,
                showResolved = showResolved,
                onShowResolvedChange = onShowResolvedChange,
                onThreadClick = onCommentsListThreadClick,
                onDismiss = onCommentsListDismiss,
            )
        }
    }
}
