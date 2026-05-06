// ---------------------------------------------------------------------------
// ThreadSheet — Compose `ModalBottomSheet` that surfaces the D5 read + post
// + reply UX defined in `wireframes/06-thread-detail.html`.
//
// Two visible modes (driven by [ThreadSheetState]):
//
//   * NewThread — anchor preview + comment composer + Post button. The
//     identity badge ("as <displayName>") sits below the post button so
//     a user who skipped profile setup notices their Anonymous identity
//     before they tap Post (the design's "first-comment-with-default-
//     identity" prompt arrives in E2; the badge here is the in-the-
//     moment cue).
//   * ExistingThread — anchor preview, the existing comments list,
//     a reply composer, and a Resolve / Reopen button.
//
// Why a `ModalBottomSheet` (and not a docked side sheet or a separate
// destination):
//   * The wireframe pins the surface to the bottom edge. ModalBottomSheet
//     gives us the right Material 3 motion + scrim out of the box.
//   * Compose Navigation pushes/pops a destination on cold-start; the
//     thread surface is intrinsically stateful relative to the doc the
//     user is reading, and re-routing through Navigation would lose the
//     current scroll + draft on every cold-start.
//
// Pure presentation surface — no business logic:
//   * Every action (close, draft edit, post, reply, resolve) dispatches
//     through the [ThreadSheetViewModel] method bound to the call site.
//     The composable holds zero state of its own beyond the
//     `rememberModalBottomSheetState` Material handle.
//
// Why the composer enables Post only when the draft is non-blank:
//   * Mirrors the desktop's Post button. The ViewModel guards the path
//     too (see `ThreadSheetViewModelTest.post_*_with_blank_draft_*`) so
//     this is purely a UX cue, not a correctness gate.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.mdviewer.core.Comment
import dev.mdviewer.core.Thread

/**
 * The top-level sheet. The composable is a no-op when [ThreadSheetState]
 * is [ThreadSheetState.Hidden] — Compose unmounts the modal entirely
 * rather than render an empty surface, so the scrim doesn't briefly
 * flicker on close.
 *
 * @param vm the ViewModel driving the sheet's state.
 * @param onPosted dispatched after a successful post / reply / resolve so
 *        the host (`DocumentScreen`) can re-pull anchors and refresh
 *        injected highlights. The ViewModel calls this back exactly once
 *        per user action.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadSheet(
    vm: ThreadSheetViewModel,
    onPosted: () -> Unit,
) {
    val state by vm.state.collectAsState()
    if (state == ThreadSheetState.Hidden) return

    // skipPartiallyExpanded = true matches the wireframe — the sheet
    // either fills the available height or it's gone. The intermediate
    // half-expanded state would cut off the comments list mid-scroll on
    // tall threads.
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    ModalBottomSheet(
        onDismissRequest = { vm.close() },
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
        ) {
            when (val s = state) {
                is ThreadSheetState.NewThread -> NewThreadBody(
                    state = s,
                    onDraftChange = vm::updateDraft,
                    onPost = { vm.postNewThread(onPosted) },
                )
                is ThreadSheetState.ExistingThread -> ExistingThreadBody(
                    state = s,
                    onDraftChange = vm::updateDraft,
                    onReply = { vm.postReply(onPosted) },
                    onResolve = { vm.resolveCurrent(onPosted) },
                )
                ThreadSheetState.Hidden -> {
                    // Unreachable: the early-return above bails on Hidden
                    // before Compose ever recomposes this when. We exhaust
                    // the sealed interface to keep the compiler honest if
                    // a future variant lands.
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// New-thread body — anchor preview + composer + Post button.
// ---------------------------------------------------------------------------

@Composable
private fun NewThreadBody(
    state: ThreadSheetState.NewThread,
    onDraftChange: (String) -> Unit,
    onPost: () -> Unit,
) {
    Text("New comment", style = MaterialTheme.typography.titleMedium)
    Spacer(Modifier.height(8.dp))

    // Truncate the preview to 80 chars: long selections would expand the
    // sheet header arbitrarily; the user already sees the full selection
    // highlighted in the document underneath.
    Text(
        text = "\"" + state.selection.text.take(80) + "\"",
        style = MaterialTheme.typography.bodySmall,
    )
    Spacer(Modifier.height(12.dp))

    OutlinedTextField(
        value = state.draft,
        onValueChange = onDraftChange,
        label = { Text("Comment") },
        modifier = Modifier.fillMaxWidth(),
        minLines = 3,
    )
    Spacer(Modifier.height(8.dp))

    // Identity badge — see file header for why this lives next to the
    // composer rather than at the top.
    Text(
        text = "as ${state.profile.displayName}",
        style = MaterialTheme.typography.labelSmall,
    )
    Spacer(Modifier.height(12.dp))

    Button(
        onClick = onPost,
        enabled = state.draft.isNotBlank(),
    ) {
        Text("Post")
    }
}

// ---------------------------------------------------------------------------
// Existing-thread body — anchor + comment list + reply composer + Resolve.
// ---------------------------------------------------------------------------

@Composable
private fun ExistingThreadBody(
    state: ThreadSheetState.ExistingThread,
    onDraftChange: (String) -> Unit,
    onReply: () -> Unit,
    onResolve: () -> Unit,
) {
    Text(
        text = state.thread.anchor.selectorText.take(80),
        style = MaterialTheme.typography.titleSmall,
    )
    Spacer(Modifier.height(8.dp))

    // LazyColumn so long threads don't force a measure pass over every
    // comment on every recomposition. Capped via Modifier.height in the
    // caller? No — Material's ModalBottomSheet handles the scroll
    // container; the LazyColumn just lets the list virtualise inside it.
    LazyColumn(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(state.thread.comments) { comment ->
            CommentRow(comment)
        }
    }
    Spacer(Modifier.height(12.dp))

    OutlinedTextField(
        value = state.draftReply,
        onValueChange = onDraftChange,
        label = { Text("Reply") },
        modifier = Modifier.fillMaxWidth(),
        minLines = 2,
    )
    Spacer(Modifier.height(8.dp))

    // Two actions side-by-side: Reply + Resolve / Reopen. The Reopen
    // label flips when the thread is already resolved (the ViewModel
    // currently exposes resolveCurrent only; the symmetric unresolve
    // path lands in D6 once the comments drawer surfaces a Reopen
    // affordance from outside the sheet).
    androidx.compose.foundation.layout.Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Button(
            onClick = onReply,
            enabled = state.draftReply.isNotBlank(),
        ) {
            Text("Reply")
        }
        OutlinedButton(onClick = onResolve) {
            Text(if (state.thread.resolved) "Reopen" else "Resolve")
        }
    }
}

@Composable
private fun CommentRow(comment: Comment) {
    Column {
        // Author + timestamp on the same row keeps the row height the
        // same as the wireframe (1.5 lines + body); a separate timestamp
        // line would push every comment down by ~20dp.
        Text(
            text = "${comment.authorName} • ${comment.createdAt}",
            style = MaterialTheme.typography.labelSmall,
        )
        Text(comment.body)
    }
}
