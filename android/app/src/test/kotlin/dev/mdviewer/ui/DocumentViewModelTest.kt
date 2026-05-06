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
import dev.mdviewer.data.SafTier
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.saf.OpenedDocument
import dev.mdviewer.saf.SafCapability
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
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
            theme = HtmlTheme.Light,
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
        val vm = DocumentViewModel(repo, "{name}.md.comments.json", recents, HtmlTheme.Light)

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
        val vm = DocumentViewModel(repo, "{name}.md.comments.json", recents, HtmlTheme.Light)

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
        val vm = DocumentViewModel(repo, "{name}.md.comments.json", recents, HtmlTheme.Light)

        vm.open(docUri)
        val errored = vm.uiState.first { it is DocumentUiState.Error } as DocumentUiState.Error
        assertTrue(errored.message.isNotEmpty(), "error message should be non-empty")
        // No recents entry on a failed open.
        assertTrue(recents.calls.isEmpty())
    }
}
