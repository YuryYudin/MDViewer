// ---------------------------------------------------------------------------
// Test fakes for DocumentViewModelTest.
//
// Both fakes implement the narrowed interfaces the ViewModel depends on
// (`DocumentRepositoryApi`, `RecentsApi`) so the test never has to
// allocate a Context-bound DataStore or a real ContentResolver. They
// stay tiny on purpose — the ViewModel test cares about the state
// machine, not about preserving the production class behavior.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import dev.mdviewer.data.RecentEntry
import dev.mdviewer.data.RecentsApi
import dev.mdviewer.data.SafTier
import dev.mdviewer.saf.DocumentRepositoryApi
import dev.mdviewer.saf.OpenedDocument
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Stand-in for [dev.mdviewer.saf.DocumentRepository] that returns a
 * pre-built [OpenedDocument] (success path) or throws a pre-supplied
 * [Throwable] (failure path).
 *
 * The two cases are mutually exclusive at the call site — pass either
 * `opened` (and leave `failure` null) or `failure` (and leave `opened`
 * null). Passing neither is rejected as soon as `open` runs so a
 * malformed test fails loud.
 */
class FakeDocumentRepository(
    private val opened: OpenedDocument?,
    private val failure: Throwable? = null,
) : DocumentRepositoryApi {

    override suspend fun open(uri: Uri): OpenedDocument {
        failure?.let { throw it }
        return opened ?: error("FakeDocumentRepository: configure either opened or failure")
    }

    override suspend fun reload(uri: Uri): OpenedDocument = open(uri)
}

/**
 * In-memory [RecentsApi] that records every `recordOpen` call into a
 * public [calls] list (`Triple<uri, displayName, safTier>`) and serves
 * the same backing list back to readers.
 *
 * The `flow` property re-emits whenever a write lands so any future
 * test that wires Compose collection sees the same shape as production.
 */
class FakeRecents : RecentsApi {

    /**
     * Records every `recordOpen` invocation in arrival order. Tests
     * assert against `.size` and the last triple's contents.
     */
    val calls: MutableList<Triple<String, String, SafTier>> = mutableListOf()

    private val _state: MutableStateFlow<List<RecentEntry>> = MutableStateFlow(emptyList())
    override val flow: Flow<List<RecentEntry>> = _state.asStateFlow()

    override suspend fun list(): List<RecentEntry> = _state.value

    override suspend fun recordOpen(uri: String, displayName: String, safTier: SafTier) {
        calls += Triple(uri, displayName, safTier)
        val now = System.currentTimeMillis()
        val without = _state.value.filterNot { it.uri == uri }
        _state.value = listOf(RecentEntry(uri, displayName, now, safTier)) + without
    }
}
