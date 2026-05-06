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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
}
