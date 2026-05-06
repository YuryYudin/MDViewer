// ---------------------------------------------------------------------------
// RecentsViewModel — feeds [RecentsScreen] the most-recent-first list of
// previously-opened markdown documents.
//
// Design choices:
//
//   * One-shot snapshot on init + manual `refresh()` rather than a
//     persistent flow collection. The Recents screen is a leaf
//     destination in the nav graph and doesn't need real-time updates
//     while the user is on it — they can only land on `Document` from
//     here, and on the trip back the screen recomposes from a fresh
//     snapshot. Skipping the long-lived collector keeps the ViewModel
//     leak-free without an explicit `cancel`.
//
//   * [RecentsApi] (interface), not the concrete [Recents] class, so the
//     unit test can plug a Context-free fake. Same rationale as for
//     [DocumentViewModel] — see `DocumentViewModel.kt`.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.mdviewer.data.RecentEntry
import dev.mdviewer.data.RecentsApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

class RecentsViewModel(private val recents: RecentsApi) : ViewModel() {

    private val _entries = MutableStateFlow<List<RecentEntry>>(emptyList())
    val entries: StateFlow<List<RecentEntry>> = _entries.asStateFlow()

    init { refresh() }

    /**
     * Re-pulls the snapshot from the underlying [RecentsApi]. Called on
     * construction and any time the screen explicitly asks for a
     * refresh (e.g. after a navigation pop from the Document screen).
     */
    fun refresh() {
        viewModelScope.launch { _entries.value = recents.list() }
    }
}
