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
// `RecentsApi` and `DocumentRepositoryApi` interfaces expose only the
// methods this ViewModel calls, and the test fakes implement those with
// a couple of fields each. See `DocumentViewModelTest` and `Fakes.kt`.
//
// The Loaded path renders Markdown via the UniFFI binding from :core,
// then writes a recents entry. We deliberately record AFTER rendering
// succeeds: a malformed source produces a CoreError on `renderMarkdown`,
// and that should surface as Error without polluting Recents with an
// entry for a doc the user can't actually view.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.RenderOptions
import dev.mdviewer.core.renderMarkdown
import dev.mdviewer.data.RecentsApi
import dev.mdviewer.data.SafTier
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.saf.DocumentRepositoryApi
import dev.mdviewer.saf.SafCapability
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/**
 * Three-state UI contract consumed by [DocumentScreen].
 *
 *   * [Loading] — initial state, also re-entered if the screen ever
 *     re-launches an `open()` (currently it does not, but the state
 *     machine permits it).
 *   * [Loaded] — render succeeded; carries everything the screen needs
 *     to draw the WebView + the SAF banner.
 *   * [Error] — repository or render failure. The message is non-empty
 *     so the screen can show the cause without a separate fallback
 *     branch.
 */
sealed interface DocumentUiState {
    data object Loading : DocumentUiState

    data class Loaded(
        val uri: Uri,
        val displayName: String,
        val html: String,
        val theme: HtmlTheme,
        val capability: SafCapability,
        val treeUri: Uri?,
    ) : DocumentUiState

    data class Error(val message: String) : DocumentUiState
}

class DocumentViewModel(
    private val repo: DocumentRepositoryApi,
    private val sidecarPattern: String,
    private val recents: RecentsApi,
    private val theme: HtmlTheme,
) : ViewModel() {

    private val _ui = MutableStateFlow<DocumentUiState>(DocumentUiState.Loading)
    val uiState: StateFlow<DocumentUiState> = _ui.asStateFlow()

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
     * never produces a half-merged store.
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
                    html = rendered.html,
                    theme = theme,
                    capability = opened.capability,
                    treeUri = opened.treeUri,
                )
            } catch (e: Throwable) {
                _ui.value = DocumentUiState.Error(e.message ?: "Could not open document")
            }
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
     * The merged store replaces the in-memory reference via
     * [bindLocalStore] so a subsequent reload operates on the post-merge
     * snapshot. The rendered HTML is refreshed from the new bytes, and
     * a snackbar message is emitted with the wireframe-10 copy:
     *   * `"$N new comment"` (singular) when [RefreshDelta.totalNew] == 1
     *   * `"$N new comments"` (plural) when > 1
     *   * `"No changes"` when zero
     *
     * Pre-conditions:
     *   * The screen must be in [DocumentUiState.Loaded] (a reload from
     *     Loading or Error is a no-op — the user has nothing to refresh
     *     against).
     *   * [bindLocalStore] must have been called at least once. Without
     *     a local store the merge step has nothing to merge against; the
     *     call returns silently rather than fabricating an empty store
     *     (which could mask a wiring bug).
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
                val rendered = renderMarkdown(
                    String(delta.opened.bytes),
                    RenderOptions(syntaxHighlighting = true, mermaidEnabled = false),
                )
                _ui.value = current.copy(html = rendered.html)

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
