// ---------------------------------------------------------------------------
// DocumentViewModelTest — host-JVM verification of the open path that drives
// the DocumentScreen.
//
// The ViewModel sits between three collaborators:
//
//   * DocumentRepository — reads doc bytes + classifies SAF capability.
//   * Sidecar — loads/saves the comments JSON for the doc.
//   * Recents — records the open as a most-recent-first entry.
//
// We verify three behaviors the screen depends on:
//
//   1. uiState moves Loading -> Loaded after a successful open. Loaded
//      carries the rendered HTML, the runtime SafCapability, the resolved
//      HtmlTheme (driven by SettingsStore), and the displayName.
//   2. recordOpen lands on the Recents store with the correct safTier
//      derived from the runtime SafCapability — that's what the
//      `ReopenFromRecentsTest` E2E later relies on.
//   3. A repository failure (FileNotFoundException, denied read) flips
//      uiState to Error with a non-empty message instead of crashing.
//
// The repository, sidecar, recents, and settings collaborators are all
// faked: this test is a pure-logic verification of the ViewModel's state
// machine, not of the repository wiring (which DocumentRepositoryTest
// covers under Robolectric).
//
// We use Robolectric @RunWith because the Loaded path calls
// `dev.mdviewer.core.renderMarkdown` on the host JVM, which transitively
// hits `android.os.Build` (via the `android_cleaner = true` UDL setting).
// SidecarTreeTest's setup is the same pattern; reuse it.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import dev.mdviewer.core.Anchor
import dev.mdviewer.core.NewThread
import dev.mdviewer.core.createThread
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.core.saveSidecarBytes
import dev.mdviewer.data.SafTier
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.saf.OpenedDocument
import dev.mdviewer.saf.SafCapability
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.FileNotFoundException
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class DocumentViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        // viewModelScope dispatches to Main; we route Main through the test
        // dispatcher so `runTest`'s scheduler controls the coroutine.
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun open_emits_loaded_with_rendered_html_and_capability() = runTest {
        val docUri = Uri.parse("content://t/single")
        val repo = FakeDocumentRepository(
            opened = OpenedDocument(
                uri = docUri,
                displayName = "x.md",
                bytes = "# Hi".toByteArray(),
                capability = SafCapability.SingleUri,
                treeUri = null,
            ),
        )
        val recents = FakeRecents()
        val vm = DocumentViewModel(
            repo = repo,
            sidecarPattern = "{name}.md.comments.json",
            recents = recents,
            sidecar = FakeDocumentSidecar(),
            theme = HtmlTheme.Light,
            anchorDispatcher = testDispatcher,
        )

        vm.open(docUri)

        val loaded = vm.uiState.first { it is DocumentUiState.Loaded } as DocumentUiState.Loaded
        assertTrue(loaded.html.contains("<h1"), "expected <h1 in: ${loaded.html}")
        assertEquals(SafCapability.SingleUri, loaded.capability)
        assertEquals("x.md", loaded.displayName)
        assertEquals(docUri, loaded.uri)
        assertEquals(HtmlTheme.Light, loaded.theme)
    }

    @Test
    fun open_records_recent_with_single_uri_tier() = runTest {
        val docUri = Uri.parse("content://t/single")
        val repo = FakeDocumentRepository(
            opened = OpenedDocument(
                uri = docUri,
                displayName = "single.md",
                bytes = "body".toByteArray(),
                capability = SafCapability.SingleUri,
                treeUri = null,
            ),
        )
        val recents = FakeRecents()
        val vm = DocumentViewModel(
            repo = repo,
            sidecarPattern = "{name}.md.comments.json",
            recents = recents,
            sidecar = FakeDocumentSidecar(),
            theme = HtmlTheme.Light,
            anchorDispatcher = testDispatcher,
        )

        vm.open(docUri)
        vm.uiState.first { it is DocumentUiState.Loaded }

        assertEquals(1, recents.calls.size)
        val (uri, name, tier) = recents.calls.first()
        assertEquals(docUri.toString(), uri)
        assertEquals("single.md", name)
        assertEquals(SafTier.SingleUri, tier)
    }

    @Test
    fun open_records_recent_with_tree_access_tier() = runTest {
        val docUri = Uri.parse("content://t/tree/doc")
        val treeUri = Uri.parse("content://t/tree")
        val repo = FakeDocumentRepository(
            opened = OpenedDocument(
                uri = docUri,
                displayName = "tree.md",
                bytes = "body".toByteArray(),
                capability = SafCapability.TreeAccess,
                treeUri = treeUri,
            ),
        )
        val recents = FakeRecents()
        val vm = DocumentViewModel(
            repo = repo,
            sidecarPattern = "{name}.md.comments.json",
            recents = recents,
            sidecar = FakeDocumentSidecar(),
            theme = HtmlTheme.Light,
            anchorDispatcher = testDispatcher,
        )

        vm.open(docUri)
        vm.uiState.first { it is DocumentUiState.Loaded }

        assertEquals(1, recents.calls.size)
        assertEquals(SafTier.TreeAccess, recents.calls.first().third)
    }

    @Test
    fun open_failure_emits_error_state() = runTest {
        val docUri = Uri.parse("content://t/missing")
        val repo = FakeDocumentRepository(
            opened = null,
            failure = FileNotFoundException("missing"),
        )
        val recents = FakeRecents()
        val vm = DocumentViewModel(
            repo = repo,
            sidecarPattern = "{name}.md.comments.json",
            recents = recents,
            sidecar = FakeDocumentSidecar(),
            theme = HtmlTheme.Light,
            anchorDispatcher = testDispatcher,
        )

        vm.open(docUri)
        val errored = vm.uiState.first { it is DocumentUiState.Error } as DocumentUiState.Error
        assertTrue(errored.message.isNotEmpty(), "error message should be non-empty")
        // No recents entry on a failed open.
        assertTrue(recents.calls.isEmpty())
    }

    // -----------------------------------------------------------------
    // D8: anchor-resolution wiring on document open.
    //
    // After `open(uri)` lands the rendered HTML in `Loaded`, the
    // ViewModel must walk the sidecar's threads, call
    // `mdviewer-core::resolve_anchor` on each, and publish the
    // resolved ranges via the `anchorRanges` StateFlow. The Compose
    // layer then feeds those ranges to HighlightInjector. Orphan
    // threads (`is_orphan = true` from the core call) are NOT included
    // in the highlight payload — D6's CommentsListSheet surfaces them
    // separately as a flagged row.
    //
    // We seed the FakeSidecar by serializing a pre-built store via the
    // production `saveSidecarBytes` so the test reflects what
    // `Sidecar.load` will hand back from disk in production.
    // -----------------------------------------------------------------

    /**
     * Helper: build a fresh sidecar byte payload containing one thread
     * whose anchor matches the substring at [start..end) in [source].
     * Returns the raw bytes the FakeSidecar will hand back on `load`.
     */
    private fun seededSidecarBytes(
        source: String,
        start: Int,
        end: Int,
    ): ByteArray {
        val store = loadSidecarBytes(ByteArray(0))
        val anchor = Anchor(
            selectorText = source.substring(start, end),
            contextBefore = "",
            contextAfter = "",
            charStart = start.toUInt(),
            charEnd = end.toUInt(),
        )
        createThread(
            store = store,
            input = NewThread(
                anchor = anchor,
                body = "seed",
                authorId = "u-1",
                authorName = "Alice",
                authorColor = "#000000",
            ),
        )
        return saveSidecarBytes(store)
    }

    @Test
    fun open_resolves_anchors_for_each_thread_in_sidecar() = runTest {
        val source = "alpha bravo charlie"
        val docUri = Uri.parse("content://t/anchor")
        val repo = FakeDocumentRepository(
            opened = OpenedDocument(
                uri = docUri,
                displayName = "doc.md",
                bytes = source.toByteArray(),
                capability = SafCapability.SingleUri,
                treeUri = null,
            ),
        )
        val sidecar = FakeDocumentSidecar(bytes = seededSidecarBytes(source, 6, 11))
        val vm = DocumentViewModel(
            repo = repo,
            sidecarPattern = "{name}.md.comments.json",
            recents = FakeRecents(),
            sidecar = sidecar,
            theme = HtmlTheme.Light,
            anchorDispatcher = testDispatcher,
        )

        vm.open(docUri)
        // The Loaded state lands first; the anchor refresh kicks off
        // a separate coroutine on the (test-routed) anchorDispatcher
        // that we drive forward with `advanceUntilIdle`.
        vm.uiState.first { it is DocumentUiState.Loaded }
        advanceUntilIdle()

        val ranges = vm.anchorRanges.value
        assertEquals(1, ranges.size, "one thread -> one anchor range")
        val range = ranges.single()
        assertEquals(6, range.srcStart)
        assertEquals(11, range.srcEnd)
        assertFalse(range.resolved, "fresh thread is not resolved")
    }

    @Test
    fun open_publishes_orphan_threads_via_orphanThreadIds_flow() = runTest {
        // Source no longer contains the original "bravo" quote.
        val originalSource = "alpha bravo charlie"
        val mutatedSource = "alpha CHARLIE delta"
        val docUri = Uri.parse("content://t/orphan")
        val repo = FakeDocumentRepository(
            opened = OpenedDocument(
                uri = docUri,
                displayName = "doc.md",
                bytes = mutatedSource.toByteArray(),
                capability = SafCapability.SingleUri,
                treeUri = null,
            ),
        )
        // Seed sidecar with a thread anchored at "bravo" in the
        // ORIGINAL source — `resolve_anchor` against `mutatedSource`
        // returns Orphan because the quote is gone.
        val sidecar = FakeDocumentSidecar(bytes = seededSidecarBytes(originalSource, 6, 11))
        val vm = DocumentViewModel(
            repo = repo,
            sidecarPattern = "{name}.md.comments.json",
            recents = FakeRecents(),
            sidecar = sidecar,
            theme = HtmlTheme.Light,
            anchorDispatcher = testDispatcher,
        )

        vm.open(docUri)
        vm.uiState.first { it is DocumentUiState.Loaded }
        advanceUntilIdle()

        // Highlight payload: empty (orphan threads skip injection).
        assertEquals(0, vm.anchorRanges.value.size, "orphan threads do not paint")
        // Orphan flag surface: D6's CommentsListSheet reads from this.
        assertEquals(1, vm.orphanThreadIds.value.size, "orphan thread surfaced")
    }
}
