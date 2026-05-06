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
import dev.mdviewer.core.RenderOptions
import dev.mdviewer.core.renderMarkdown
import dev.mdviewer.data.RecentsApi
import dev.mdviewer.data.SafTier
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.saf.DocumentRepositoryApi
import dev.mdviewer.saf.SafCapability
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
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
    @Suppress("unused") private val sidecarPattern: String,
    private val recents: RecentsApi,
    private val theme: HtmlTheme,
) : ViewModel() {

    private val _ui = MutableStateFlow<DocumentUiState>(DocumentUiState.Loading)
    val uiState: StateFlow<DocumentUiState> = _ui.asStateFlow()

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
}
