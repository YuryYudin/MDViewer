// ---------------------------------------------------------------------------
// DocumentViewModel — drives [DocumentScreen] through a three-state UI
// machine: Loading -> Loaded | Error.
//
// Collaborators (all injected through interfaces so the C5 unit test
// can fake them on the host JVM without a Context):
//
//   * [DocumentRepositoryApi] — reads bytes + classifies SAF capability.
//   * [RecentsApi] — records a `recordOpen` after a successful render so
//     the doc surfaces as the head entry in the Recents list on the next
//     visit.
//   * [SidecarApi] (D8) — loads the comments JSON next to the document so
//     the ViewModel can re-resolve every thread's anchor against the
//     freshly-rendered source. The handle returned from `load` is held on
//     the Loaded state so the D-phase ThreadSheet can mutate it without
//     asking the ViewModel to expose its internals.
//
// Two non-collaborator inputs come in as plain values:
//   * `sidecarPattern` — printf-ish template for the sibling JSON file
//     name; resolved at construction by the Navigation layer (it reads
//     the persisted [SettingsStore] value once before launching the
//     screen, so the ViewModel doesn't have to hold a reactive flow on
//     every recomposition).
//   * `theme` — already-resolved [HtmlTheme] for this open. The Compose
//     layer (Navigation factory) maps [ThemeMode.FollowSystem] against
//     the device's `isSystemInDarkTheme()` *before* it constructs the
//     ViewModel, keeping render-time logic out of the state machine.
//
// Why the interface-narrowed dependencies (vs the concrete classes from
// `dev.mdviewer.data.Recents` and `dev.mdviewer.saf.DocumentRepository`):
// the production classes both capture a [android.content.Context], which
// makes them awkward to instantiate in a host-JVM unit test. The
// `RecentsApi`, `DocumentRepositoryApi`, and `SidecarApi` interfaces
// expose only the methods this ViewModel calls, and the test fakes
// implement those with a couple of fields each. See
// `DocumentViewModelTest` and `Fakes.kt`.
//
// The Loaded path renders Markdown via the UniFFI binding from :core,
// then writes a recents entry. We deliberately record AFTER rendering
// succeeds: a malformed source produces a CoreError on `renderMarkdown`,
// and that should surface as Error without polluting Recents with an
// entry for a doc the user can't actually view.
//
// D8: anchor resolution.
//
// After the open path lands the rendered HTML, the ViewModel kicks off
// a separate coroutine on `Dispatchers.Default` that walks every thread
// in the loaded comments store and calls
// `mdviewer-core::resolve_anchor`. Resolved threads land in the
// `anchorRanges` StateFlow as [AnchorRange] entries the Compose layer
// feeds into HighlightInjector. Orphan threads (the quote no longer
// matches the source) skip injection but their thread ids land in
// `orphanThreadIds` so D6's CommentsListSheet can flag them with an
// "orphan" badge instead of dropping them silently — orphans are user
// data, not garbage to clean up.
//
// Why a separate dispatcher seam (`anchorDispatcher`):
//   * `anchor::resolve_anchor_with_threshold` runs Bitap fuzzy matching
//     on a CPU-bound loop. On a large doc it can take milliseconds; the
//     UI thread can't afford that even once per open.
//   * The host-JVM unit test routes the dispatcher through the same
//     `StandardTestDispatcher` it uses for `viewModelScope`, so
//     `runTest`'s scheduler can drive both the open coroutine and the
//     resolve coroutine in lockstep. Without this seam the
//     `Dispatchers.Default` work would land on a real worker thread the
//     test scheduler does not see, and assertions would race.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.RenderOptions
import dev.mdviewer.core.renderMarkdown
import dev.mdviewer.core.resolveAnchor
import dev.mdviewer.data.RecentsApi
import dev.mdviewer.data.SafTier
import dev.mdviewer.render.AnchorRange
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.saf.DocumentRepositoryApi
import dev.mdviewer.saf.SafCapability
import dev.mdviewer.saf.SidecarApi
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Three-state UI contract consumed by [DocumentScreen].
 *
 *   * [Loading] — initial state, also re-entered if the screen ever
 *     re-launches an `open()` (currently it does not, but the state
 *     machine permits it).
 *   * [Loaded] — render succeeded; carries everything the screen needs
 *     to draw the WebView + the SAF banner. D8 widens the state with
 *     the comments [store] and the [source] string so anchor
 *     re-resolution and the D-phase ThreadSheet can read both without
 *     a second open round-trip.
 *   * [Error] — repository or render failure. The message is non-empty
 *     so the screen can show the cause without a separate fallback
 *     branch.
 */
sealed interface DocumentUiState {
    data object Loading : DocumentUiState

    data class Loaded(
        val uri: Uri,
        val displayName: String,
        val source: String,
        val html: String,
        val theme: HtmlTheme,
        val capability: SafCapability,
        val treeUri: Uri?,
        val store: CommentsStoreHandle,
    ) : DocumentUiState

    data class Error(val message: String) : DocumentUiState
}

class DocumentViewModel(
    private val repo: DocumentRepositoryApi,
    private val sidecarPattern: String,
    private val recents: RecentsApi,
    private val sidecar: SidecarApi,
    private val theme: HtmlTheme,
    /**
     * Dispatcher that the (CPU-bound) `resolve_anchor` loop runs on.
     * Production passes [Dispatchers.Default]; the host-JVM test routes
     * it through the same `StandardTestDispatcher` it uses for
     * `viewModelScope` so `runTest`'s scheduler can drive the resolve
     * coroutine in lockstep with the open coroutine.
     */
    private val anchorDispatcher: CoroutineDispatcher = Dispatchers.Default,
) : ViewModel() {

    private val _ui = MutableStateFlow<DocumentUiState>(DocumentUiState.Loading)
    val uiState: StateFlow<DocumentUiState> = _ui.asStateFlow()

    /**
     * Per-thread resolved ranges the Compose layer feeds to
     * [dev.mdviewer.render.HighlightInjector]. Empty when the document
     * has no threads or every thread orphaned. Re-emits whenever
     * [refreshAnchors] runs (open + post-mutation + Reload).
     */
    private val _anchorRanges = MutableStateFlow<List<AnchorRange>>(emptyList())
    val anchorRanges: StateFlow<List<AnchorRange>> = _anchorRanges.asStateFlow()

    /**
     * Set of thread ids whose anchors `resolve_anchor` reported as
     * orphan. D6's CommentsListSheet renders these with an "orphan"
     * assist chip; HighlightInjector skips them entirely (an orphaned
     * thread has no document position to paint at).
     */
    private val _orphanThreadIds = MutableStateFlow<Set<String>>(emptySet())
    val orphanThreadIds: StateFlow<Set<String>> = _orphanThreadIds.asStateFlow()

    /**
     * One-shot snackbar messages emitted by [reload]. Backed by an
     * unlimited Channel rather than a SharedFlow so emit() always lands
     * exactly once on the next collector regardless of subscription
     * timing — which is the correctness model snackbars need ("the same
     * message text needs to surface as a fresh snackbar on a second
     * reload"). Channels avoid the SharedFlow-replay-vs-dedupe and
     * collector-active-at-emission-time tradeoffs that StateFlow and
     * SharedFlow each lose on respectively.
     *
     * The screen collects this in a `LaunchedEffect` and forwards each
     * received string to a [androidx.compose.material3.SnackbarHostState].
     */
    private val _snackbarMessage = Channel<String>(Channel.UNLIMITED)
    val snackbarMessage: Flow<String> = _snackbarMessage.receiveAsFlow()

    /**
     * Live reference to the comments store the [reload] path will merge
     * the incoming sidecar against. Wired by the ThreadSheet integration
     * layer through [bindLocalStore] once the sidecar has loaded; reload
     * is a no-op until the binding lands so a too-early overflow tap
     * never produces a half-merged store. D8's `open` path also auto-
     * binds the store loaded from the sidecar so reload works without
     * an explicit ThreadSheet hook.
     */
    private var localStore: CommentsStoreHandle? = null

    /**
     * Hand the comments store to the ViewModel so [reload] can pass it
     * through to the repository's merge step. The caller (production: the
     * `DocumentScreen` integration once a `ThreadSheetViewModel` is
     * mounted; tests: directly from the test setup) is responsible for
     * keeping this reference in sync with the store the ThreadSheet
     * mutates — they share the same Arc<CommentsStore> handle so a
     * thread posted via the sheet is visible here at next reload.
     *
     * Re-binding with a different handle (e.g. after merge_stores
     * returned a new one) is supported: the next [reload] call uses
     * whatever handle is current.
     */
    fun bindLocalStore(store: CommentsStoreHandle) {
        localStore = store
    }

    /**
     * Kicks off the open flow. The repository handles its own
     * `Dispatchers.IO` dispatch, so [viewModelScope] (Main-immediate
     * under the hood) is correct here — we want the eventual state
     * mutation to land synchronously on the same dispatcher Compose
     * reads from.
     *
     * Failure path: any throwable from the repository or the renderer
     * lands as [DocumentUiState.Error] with the message preserved. We
     * never record a recents entry on failure — the user shouldn't see
     * a doc surface in their history that they couldn't actually open.
     */
    fun open(uri: Uri) {
        viewModelScope.launch {
            try {
                val opened = repo.open(uri)
                val source = String(opened.bytes)
                val rendered = renderMarkdown(
                    source,
                    RenderOptions(syntaxHighlighting = true, mermaidEnabled = false),
                )

                val store = sidecar.load(
                    docUri = opened.uri,
                    docFilename = opened.displayName,
                    capability = opened.capability,
                    treeUri = opened.treeUri,
                    pattern = sidecarPattern,
                )

                val tier = when (opened.capability) {
                    SafCapability.TreeAccess -> SafTier.TreeAccess
                    SafCapability.SingleUri -> SafTier.SingleUri
                }
                recents.recordOpen(
                    uri = opened.uri.toString(),
                    displayName = opened.displayName,
                    safTier = tier,
                )

                _ui.value = DocumentUiState.Loaded(
                    uri = opened.uri,
                    displayName = opened.displayName,
                    source = source,
                    html = rendered.html,
                    theme = theme,
                    capability = opened.capability,
                    treeUri = opened.treeUri,
                    store = store,
                )

                // Auto-bind the local store so the D7 Reload path works
                // without an explicit ThreadSheet wiring step. The
                // ThreadSheet integration may re-bind a different handle
                // post-mutation; bindLocalStore is the explicit override.
                localStore = store

                // Kick off anchor resolution after Loaded has been
                // published — the Compose layer's LaunchedEffect on
                // anchorRanges will fire when this coroutine completes.
                refreshAnchors()
            } catch (e: Throwable) {
                _ui.value = DocumentUiState.Error(e.message ?: "Could not open document")
            }
        }
    }

    /**
     * Walk every thread in the loaded store and re-resolve its anchor
     * against the live source. Splits the result two ways:
     *
     *   * Resolved threads -> [AnchorRange] entries in [anchorRanges]
     *     for HighlightInjector.
     *   * Orphan threads -> their thread ids in [orphanThreadIds] so
     *     CommentsListSheet (D6) can flag them.
     *
     * Called from:
     *   1. [open] after Loaded is published (initial set).
     *   2. The D5 ThreadSheet after a successful Post / Reply / Resolve
     *      (mutation re-published the thread set).
     *   3. The D7 Reload action after the source bytes change.
     *
     * No-op when the ViewModel isn't in the Loaded state — there is
     * nothing to resolve against.
     */
    fun refreshAnchors() {
        val loaded = _ui.value as? DocumentUiState.Loaded ?: return
        viewModelScope.launch {
            // Snapshot threads on the calling dispatcher (cheap mutex
            // lock); jump to the CPU dispatcher for the Bitap loop.
            val threads = loaded.store.threads()
            val (ranges, orphans) = withContext(anchorDispatcher) {
                val resolved = mutableListOf<AnchorRange>()
                val orphanIds = mutableSetOf<String>()
                for (thread in threads) {
                    val outcome = resolveAnchor(loaded.source, thread.anchor)
                    if (outcome.isOrphan) {
                        orphanIds += thread.id
                    } else {
                        resolved += AnchorRange(
                            threadId = thread.id,
                            srcStart = outcome.start.toInt(),
                            srcEnd = outcome.end.toInt(),
                            resolved = thread.resolved,
                        )
                    }
                }
                resolved to orphanIds
            }
            _anchorRanges.value = ranges
            _orphanThreadIds.value = orphans
        }
    }

    /**
     * Manual-reload entry point invoked by the D7 [ReloadOverflowItem].
     *
     * Calls [DocumentRepositoryApi.reloadWithSidecar] to:
     *   1. Re-read the document bytes.
     *   2. Re-read the sidecar bytes through the configured [SidecarApi].
     *   3. Merge the parsed incoming store against the live local store
     *      using `merge_stores` (Automerge union — locally-posted threads
     *      survive even when the incoming store does not carry them).
     *
     * The merged store replaces the in-memory reference so a subsequent
     * reload operates on the post-merge snapshot. The rendered HTML is
     * refreshed from the new bytes, the source string and store are
     * updated on the Loaded state so D8's [refreshAnchors] re-resolves
     * against the new source, and a snackbar message is emitted with
     * the wireframe-10 copy:
     *   * `"$N new comment"` (singular) when [RefreshDelta.totalNew] == 1
     *   * `"$N new comments"` (plural) when > 1
     *   * `"No changes"` when zero
     *
     * Pre-conditions:
     *   * The screen must be in [DocumentUiState.Loaded] (a reload from
     *     Loading or Error is a no-op — the user has nothing to refresh
     *     against).
     *   * [localStore] must be bound. [open] auto-binds; the ThreadSheet
     *     re-binds after each mutation. Without a local store the merge
     *     step has nothing to merge against; the call returns silently.
     *
     * Failures during the reload are surfaced as a "Could not reload"
     * snackbar; the existing Loaded state is preserved so the user
     * doesn't see the document content disappear on a transient error.
     */
    fun reload() {
        val current = _ui.value as? DocumentUiState.Loaded ?: return
        val store = localStore ?: return
        viewModelScope.launch {
            try {
                val delta = repo.reloadWithSidecar(
                    uri = current.uri,
                    capability = current.capability,
                    treeUri = current.treeUri,
                    pattern = sidecarPattern,
                    currentLocalStore = store,
                )

                // Replace the held local-store reference so subsequent
                // reads (and a future reload) see the merged snapshot.
                localStore = delta.mergedStore

                // Re-render with the (possibly updated) source bytes.
                val newSource = String(delta.opened.bytes)
                val rendered = renderMarkdown(
                    newSource,
                    RenderOptions(syntaxHighlighting = true, mermaidEnabled = false),
                )
                _ui.value = current.copy(
                    source = newSource,
                    html = rendered.html,
                    store = delta.mergedStore,
                )

                // Re-resolve anchors against the new source so a desktop-
                // side edit that shifted line numbers picks up the new
                // offsets. D8's refreshAnchors reads the latest Loaded
                // state and republishes anchorRanges + orphanThreadIds.
                refreshAnchors()

                _snackbarMessage.send(snackbarCopyFor(delta.totalNew))
            } catch (e: Throwable) {
                // Don't replace the Loaded state on failure — the user
                // sees the prior content intact and a one-shot toast.
                _snackbarMessage.send("Could not reload: ${e.message ?: "unknown error"}")
            }
        }
    }

    /**
     * Wireframe-10 snackbar copy. Pulled out so the cardinality logic is
     * one place rather than embedded in the (already long) reload body.
     */
    private fun snackbarCopyFor(totalNew: Int): String = when {
        totalNew == 0 -> "No changes"
        totalNew == 1 -> "1 new comment"
        else -> "$totalNew new comments"
    }
}
