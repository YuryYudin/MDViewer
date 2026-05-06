// ---------------------------------------------------------------------------
// CommentsListSheet — D6 "All Comments" drawer per
// `wireframes/07-comments-list.html`.
//
// The composable is the navigator equivalent of the desktop client's
// CommentsSidebar.ts: every thread in the live document, ordered by the
// store's iteration order (which preserves creation order), with each row
// surfacing the first comment's author + body preview + the anchor's
// quoted slug. Tapping a row hands the thread id back to the host so the
// host can close this sheet and open the [ThreadSheet] for that id.
//
// Why a stateless surface (vs threading the SettingsStore +
// CommentsStoreHandle directly into the composable):
//
//   * Mirrors the desktop client's CommentsSidebar — `(threads, showResolved)`
//     in, `(threadId, newShowResolved)` out. The cross-platform mental
//     model stays consistent so a contributor reading both clients does
//     not have to context-switch.
//   * Compose-side unit tests can construct plain `Thread` data classes
//     without a UniFFI store handle, which is the fastest path to red /
//     green for what is essentially a navigator surface.
//   * The host (`ThreadOverlay` in D6) collects the [SettingsStore.showResolved]
//     Flow once and forwards the live boolean down + writes back through
//     [SettingsStore.setShowResolved] inside a coroutine. Same pattern as
//     [ThreadSheet], which takes a ViewModel and not a bare
//     [CommentsStoreHandle].
//
// What this composable is NOT for:
//
//   * Mutating the threads list — every reorder / resolve / reply is owned
//     by the [ThreadSheet] surface. The list is purely a navigator.
//   * Reading from the store on every row composition — the host snapshots
//     `store.threads()` once and re-reads only when a mutation completes
//     (D8 wires this; D6 just consumes the snapshot).
//   * Reordering resolved threads to the bottom — the wireframe and the
//     task spec both call out that the list preserves creation order.
//     Resolved threads dim via colour; they don't move.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.mdviewer.core.Thread

/**
 * Stateless drawer that lists every thread in [threads] (filtered by
 * [showResolved]) with a tap-to-open affordance per row.
 *
 * The composable is a [ModalBottomSheet] so the wireframe's bottom-anchored
 * drawer comes for free; positioning + scrim + dismiss-on-back are handled
 * by Material 3.
 *
 * @param threads the snapshot of threads to render. Order is preserved
 *   (the host pulls these from `CommentsStoreHandle.threads()` which
 *   returns creation order).
 * @param showResolved when `false`, resolved threads are filtered out
 *   client-side. When `true`, they render with a dim foreground colour.
 *   The host wires this to [dev.mdviewer.data.SettingsStore.showResolved].
 * @param onShowResolvedChange dispatched when the user flips the toggle
 *   in the header. The host persists the new value through
 *   [dev.mdviewer.data.SettingsStore.setShowResolved] inside a coroutine.
 * @param onThreadClick dispatched with the [Thread.id] of the tapped row.
 *   The host typically closes this sheet and opens the [ThreadSheet] for
 *   the same id.
 * @param onDismiss dispatched when the user taps outside the sheet, swipes
 *   it down, or presses Back. The host should remove the sheet from the
 *   composition.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommentsListSheet(
    threads: List<Thread>,
    showResolved: Boolean,
    onShowResolvedChange: (Boolean) -> Unit,
    onThreadClick: (String) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // skipPartiallyExpanded = true matches the wireframe — the drawer
    // either fills the available height or it's gone. The intermediate
    // half-expanded state would cut off the comments list mid-scroll on
    // tall threads. Same shape as the D5 [ThreadSheet].
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    val visible = threads.filter { showResolved || !it.resolved }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = modifier,
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
            HeaderRow(
                count = visible.size,
                showResolved = showResolved,
                onShowResolvedChange = onShowResolvedChange,
            )
            Spacer(Modifier.height(8.dp))
            HorizontalDivider()
            Spacer(Modifier.height(8.dp))

            if (visible.isEmpty()) {
                EmptyPlaceholder()
            } else {
                // LazyColumn so long thread sets don't force a measure
                // pass over every row on every recomposition. The Modal
                // sheet handles scroll coordination.
                LazyColumn(modifier = Modifier.fillMaxWidth()) {
                    items(visible, key = { it.id }) { thread ->
                        ThreadRow(
                            thread = thread,
                            onClick = { onThreadClick(thread.id) },
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Header — title (with count) + show-resolved toggle.
// ---------------------------------------------------------------------------

@Composable
private fun HeaderRow(
    count: Int,
    showResolved: Boolean,
    onShowResolvedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "Comments ($count)",
            style = MaterialTheme.typography.titleMedium,
        )
        // The label is part of the toggle row — tapping the label is
        // equivalent to flipping the switch. Material 3's Switch already
        // provides the touch target; the label is purely visual.
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.clickable { onShowResolvedChange(!showResolved) },
        ) {
            Text(
                text = "Show resolved",
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(end = 8.dp),
            )
            Switch(
                checked = showResolved,
                onCheckedChange = onShowResolvedChange,
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Empty placeholder — the drawer must not look broken when no comments
// exist yet (e.g. brand-new sidecar). The exact wording mirrors the
// desktop client's empty state.
// ---------------------------------------------------------------------------

@Composable
private fun EmptyPlaceholder() {
    Box(
        modifier = Modifier.fillMaxWidth().padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "No comments yet",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ---------------------------------------------------------------------------
// Thread row — author + body preview + anchor slug. The whole row is
// clickable; the LazyColumn item key is the thread id so a re-render
// after a mutation does not flicker.
// ---------------------------------------------------------------------------

@Composable
private fun ThreadRow(
    thread: Thread,
    onClick: () -> Unit,
) {
    val first = thread.comments.firstOrNull()
    val authorName = first?.authorName ?: "Anonymous"
    // Truncate the body preview to keep row height bounded; long comments
    // would expand the row arbitrarily and break the scroll. 120 chars
    // matches the wireframe's `-webkit-line-clamp: 2` height.
    val bodyPreview = first?.body?.take(120) ?: ""

    // Resolved rows render with a dim foreground colour so the toggle-on
    // state still distinguishes them. Order is preserved (resolved are
    // not pushed to the bottom) — the wireframe and the task spec both
    // call this out explicitly.
    val foreground =
        if (thread.resolved) MaterialTheme.colorScheme.onSurfaceVariant
        else MaterialTheme.colorScheme.onSurface

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 12.dp, horizontal = 4.dp),
    ) {
        // Top line: author name + (optional) resolved chip. The chip is a
        // text label rather than a Material `AssistChip` so the row stays
        // compact and the test can match it by string.
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = authorName,
                style = MaterialTheme.typography.titleSmall,
                color = foreground,
            )
            if (thread.resolved) {
                Text(
                    text = "resolved",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(2.dp))
        // Anchor slug — the italic-quoted selector text from the
        // wireframe. Truncated to 60 chars to keep the row tidy on long
        // anchor selections.
        Text(
            text = "“" + thread.anchor.selectorText.take(60) + "”",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))
        Text(
            text = bodyPreview,
            style = MaterialTheme.typography.bodyMedium,
            color = foreground,
        )
    }
}
