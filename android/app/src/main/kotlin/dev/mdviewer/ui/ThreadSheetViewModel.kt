// ---------------------------------------------------------------------------
// ThreadSheetViewModel — drives the D5 [ThreadSheet] composable through a
// three-state UI machine: Hidden | NewThread | ExistingThread.
//
// What the ViewModel owns:
//   * The visibility / mode of the sheet (open for new vs open for existing).
//   * The draft body the user is composing (one field per mode so switching
//     modes can never bleed a partial draft into a thread it does not
//     belong to).
//   * The mutation pipeline: every Post / Reply / Resolve action calls a
//     UniFFI `MdviewerCore.*` mutator on a [CommentsStoreHandle], then
//     persists the entire snapshot through [SidecarApi.save] so the
//     change is durable as soon as the sheet closes.
//
// Why mutations dispatch on `Dispatchers.IO`:
//   * `createThread` / `postReply` / `resolveThread` themselves are fast
//     (in-memory CRDT ops on the handle's mutex), but [SidecarApi.save]
//     serialises the store to bytes and writes them through SAF — which on
//     a Drive-backed sibling URI is a network IO. Keeping the whole
//     "mutate + persist" coroutine on IO means we never block the UI
//     thread on a sync; the alternative (mutate on Main, persist on IO)
//     would still block whoever was waiting on a fresh `state` read after
//     the IO completed.
//
// Why blank-draft posts are no-ops in the ViewModel (and not just disabled
// in the UI):
//   * The disabled-button check in the composable is a UX nicety, not a
//     correctness gate: if a future call site (a keyboard shortcut, a
//     test) bypasses the disabled state, the ViewModel must still refuse
//     to write an empty comment. The sheet stays open so the user can
//     correct rather than silently dropping their typed prefix.
//
// State machine (Hidden = initial):
//
//   Hidden -- openForNewThread(sel) ---> NewThread(sel, draft="", profile)
//   Hidden -- openForExisting(id)   ---> ExistingThread(thread, replyDraft="", profile)
//                                  | (id missing in store) ---> stays Hidden
//   * -- close()                    ---> Hidden
//   NewThread       -- updateDraft(t)  ---> NewThread with draft=t
//   ExistingThread  -- updateDraft(t)  ---> ExistingThread with draftReply=t
//   NewThread       -- postNewThread() ---> Hidden (after IO + sidecar.save)
//   ExistingThread  -- postReply()     ---> Hidden (after IO + sidecar.save)
//   ExistingThread  -- resolveCurrent() -> Hidden (after IO + sidecar.save)
//
// Why the state machine has separate fields for `draft` vs `draftReply`:
//   The two modes can never be active at the same time, but reusing one
//   field would force every accessor to inspect the variant before
//   reading. Two narrowly-scoped fields make the call sites trivial and
//   are zero-cost (the data classes are immutable snapshots).
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.mdviewer.core.Anchor
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.NewComment
import dev.mdviewer.core.NewThread
import dev.mdviewer.core.Thread
import dev.mdviewer.core.createThread
import dev.mdviewer.core.postReply
import dev.mdviewer.core.resolveThread
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import dev.mdviewer.render.Selection
import dev.mdviewer.saf.SafCapability
import dev.mdviewer.saf.SidecarApi
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Three-state UI contract consumed by [ThreadSheet].
 *
 *   * [Hidden] — initial state; the modal sheet is unmounted.
 *   * [NewThread] — user has selected text and tapped "Comment" in the
 *     [SelectionPopover]. Carries the source [selection] so the composer
 *     can preview the highlighted text, the in-progress [draft] body,
 *     and the resolved [profile] so the "as <name>" badge renders the
 *     correct identity even before the field is touched.
 *   * [ExistingThread] — user tapped a highlight (a `data-thread-id` span
 *     in the rendered HTML); the sheet shows [thread]'s comment list and
 *     a reply composer. [draftReply] is the in-progress reply.
 */
sealed interface ThreadSheetState {
    /** Sheet is closed / unmounted. */
    data object Hidden : ThreadSheetState

    /** New-thread composer; selection carries the highlighted span. */
    data class NewThread(
        val selection: Selection,
        val draft: String,
        val profile: Profile,
    ) : ThreadSheetState

    /** Existing-thread reader + reply composer. */
    data class ExistingThread(
        val thread: Thread,
        val draftReply: String,
        val profile: Profile,
    ) : ThreadSheetState
}

class ThreadSheetViewModel(
    private val store: CommentsStoreHandle,
    private val sidecar: SidecarApi,
    private val profile: ProfileStoreApi,
    private val saveContext: SaveContext,
    /**
     * Dispatcher every mutation + sidecar.save coroutine runs on. Production
     * uses [Dispatchers.IO] so a Drive-backed save doesn't block the UI;
     * tests inject the same `StandardTestDispatcher` they routed Main
     * through so `advanceUntilIdle` sees the work and `runTest`'s scheduler
     * can drive both phases of the post pipeline. Without this seam the
     * real IO dispatcher would run the mutation on a thread the test
     * scheduler does not see, and assertions would race against the
     * still-running coroutine.
     */
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    /**
     * Static-per-document save parameters threaded through every Sidecar
     * call. Captured at ViewModel construction time so the mutators don't
     * have to reach back into [DocumentViewModel.uiState] on every action.
     *
     * Why we keep this as a value-class-of-five rather than reading the
     * doc context off the active [DocumentUiState]: the capability the
     * doc was opened with (and the matching tree URI / pattern) does not
     * change during a single document session — mid-document grant
     * promotion is E3's responsibility. Snapshotting at construction
     * makes every action allocation-free at the call site.
     */
    data class SaveContext(
        val docUri: Uri,
        val docFilename: String,
        val capability: SafCapability,
        val treeUri: Uri?,
        val sidecarPattern: String,
    )

    private val _state = MutableStateFlow<ThreadSheetState>(ThreadSheetState.Hidden)
    val state: StateFlow<ThreadSheetState> = _state.asStateFlow()

    /**
     * Open the sheet in new-thread mode anchored at [selection]. Profile
     * is resolved through [ProfileStoreApi.get] (which returns a fresh
     * Anonymous identity on first launch) so the composer's identity
     * badge shows the right author from the very first paint.
     */
    fun openForNewThread(selection: Selection) {
        viewModelScope.launch {
            val p = profile.get()
            _state.value = ThreadSheetState.NewThread(
                selection = selection,
                draft = "",
                profile = p,
            )
        }
    }

    /**
     * Open the sheet in existing-thread mode for [threadId]. If no thread
     * with that id exists in the store (e.g. the highlight points at a
     * thread that was deleted out-of-band by a Reload), the sheet stays
     * Hidden — opening a blank sheet for a missing thread would surface a
     * confusing empty surface.
     */
    fun openForExisting(threadId: String) {
        // Snapshot the thread on the current dispatcher; CommentsStoreHandle's
        // threads() reads through the handle's mutex which is safe to call
        // from any thread. A null result here means the highlight no longer
        // resolves; we simply stay Hidden rather than throw.
        val thread = store.threads().firstOrNull { it.id == threadId } ?: return
        viewModelScope.launch {
            _state.value = ThreadSheetState.ExistingThread(
                thread = thread,
                draftReply = "",
                profile = profile.get(),
            )
        }
    }

    /** Close the sheet. Idempotent — a second close from Hidden is a no-op. */
    fun close() {
        _state.value = ThreadSheetState.Hidden
    }

    /**
     * Update the active draft. Routes to the correct field based on the
     * live state variant; if the sheet is Hidden the call is a no-op (the
     * UI should never be able to fire this from Hidden, but the guard
     * keeps the state machine total).
     */
    fun updateDraft(text: String) {
        _state.value = when (val s = _state.value) {
            is ThreadSheetState.NewThread -> s.copy(draft = text)
            is ThreadSheetState.ExistingThread -> s.copy(draftReply = text)
            ThreadSheetState.Hidden -> s
        }
    }

    /**
     * Persist a new thread anchored at the current [ThreadSheetState.NewThread]
     * selection with the in-progress draft as the first comment. Blank
     * drafts are rejected (sheet stays open). Calls [SidecarApi.save] on
     * `Dispatchers.IO` so a Drive-backed sibling write doesn't block the
     * UI; the sheet then closes and [onPosted] fires exactly once. If the
     * sheet is not in NewThread mode the call is a no-op.
     */
    fun postNewThread(onPosted: () -> Unit) {
        val s = _state.value as? ThreadSheetState.NewThread ?: return
        if (s.draft.isBlank()) return
        viewModelScope.launch(ioDispatcher) {
            createThread(
                store = store,
                input = NewThread(
                    anchor = anchorFor(s.selection),
                    body = s.draft,
                    authorId = s.profile.userId,
                    authorName = s.profile.displayName,
                    authorColor = s.profile.color,
                ),
            )
            persist()
            close()
            onPosted()
        }
    }

    /**
     * Append a reply to the live [ThreadSheetState.ExistingThread]. Blank
     * drafts are rejected. Same dispatcher + persistence rules as
     * [postNewThread]; same idempotency guards.
     */
    fun postReply(onPosted: () -> Unit) {
        val s = _state.value as? ThreadSheetState.ExistingThread ?: return
        if (s.draftReply.isBlank()) return
        viewModelScope.launch(ioDispatcher) {
            postReply(
                store = store,
                threadId = s.thread.id,
                input = NewComment(
                    body = s.draftReply,
                    authorId = s.profile.userId,
                    authorName = s.profile.displayName,
                    authorColor = s.profile.color,
                ),
            )
            persist()
            close()
            onPosted()
        }
    }

    /**
     * Resolve the live thread (flips the `resolved` flag in the store) and
     * persist. Same dispatcher + persistence rules. The `unresolve` path
     * is symmetric and lands in D6 / E2 once the comments-list drawer
     * exposes a Reopen affordance from outside the sheet.
     */
    fun resolveCurrent(onResolved: () -> Unit) {
        val s = _state.value as? ThreadSheetState.ExistingThread ?: return
        viewModelScope.launch(ioDispatcher) {
            resolveThread(store = store, threadId = s.thread.id)
            persist()
            close()
            onResolved()
        }
    }

    /**
     * Build a UniFFI [Anchor] from a Compose-side [Selection]. The
     * anchor's `selectorText` plus the empty before/after context is
     * enough for the v1 source-offset re-anchor algorithm; richer
     * context windows land in D8 alongside the offline re-anchor path.
     *
     * The `toUInt` cast assumes selection offsets fit in 32 bits;
     * documents larger than 4 GiB are out of scope (and would already
     * fail elsewhere — UniFFI's u32 surface for offsets is the same one
     * core's anchor.rs down-casts to from `usize`).
     */
    private fun anchorFor(selection: Selection): Anchor = Anchor(
        selectorText = selection.text,
        contextBefore = "",
        contextAfter = "",
        charStart = selection.srcStart.toUInt(),
        charEnd = selection.srcEnd.toUInt(),
    )

    /**
     * Persist the current store snapshot through the configured Sidecar
     * IO. Capability + tree URI + pattern come from the
     * construction-time [SaveContext] so the call site does not have to
     * thread the doc context through every action.
     */
    private suspend fun persist() {
        sidecar.save(
            docUri = saveContext.docUri,
            docFilename = saveContext.docFilename,
            capability = saveContext.capability,
            treeUri = saveContext.treeUri,
            pattern = saveContext.sidecarPattern,
            store = store,
        )
    }
}
