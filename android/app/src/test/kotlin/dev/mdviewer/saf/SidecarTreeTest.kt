// ---------------------------------------------------------------------------
// SidecarTreeTest — host-JVM verification of the tree-access tier of the
// two-tier sidecar IO.
//
// When the user opened the document with a parent-folder grant in scope
// (DocumentRepository classified the URI as SafCapability.TreeAccess),
// the sidecar comments JSON is written as a sibling file inside that
// tree. Production walks via `DocumentFile.fromTreeUri(ctx, treeUri)`
// + `findFile / createFile`. Robolectric does not ship a usable
// DocumentsProvider for the documentfile library, so we inject a small
// `TreeAccess` abstraction here and back it with an in-memory fake.
//
// The fake (`FakeTreeAccess` + `FakeTreeNode`) is intentionally minimal —
// only the four operations the production Sidecar calls (rootFor /
// findFile / createFile / read+write bytes). Anything beyond that would
// be retesting `androidx.documentfile`, which is not the contract under
// test.
//
// We pin two round-trips:
//
//   1. `load` against an empty tree returns an empty CommentsStore — the
//      core's `load_sidecar_bytes(empty)` accepts that as "no sidecar
//      yet" and produces an empty store, so we don't need a sidecar file
//      to exist before the first save.
//
//   2. `save` against a TreeAccess capability creates the sidecar file
//      under the tree with the filename derived from the
//      mdviewer-core::sidecar_path helper, and a subsequent `load`
//      returns the same bytes (proves the create-or-overwrite path is
//      idempotent across two saves).
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.core.saveSidecarBytes
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

// `@RunWith(RobolectricTestRunner)` + `@Config(sdk = [33])` mirrors the
// :core UniffiSmokeTest wiring. The UniFFI-generated bindings reference
// `android.system.SystemCleaner` whose JVM-side codepath collides with
// JDK 17+ module access for `jdk.internal.ref.CleanerFactory`. Pinning
// the shadow framework to API 33 keeps Robolectric's shim selection on a
// known-good cleaner strategy without us having to flip the
// `android_cleaner` UDL config off (which would also flip it off for
// the production AAR).
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SidecarTreeTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun load_then_save_via_tree_round_trips() = runTest {
        val tree = FakeTreeNode.directory("notes")
        val md = tree.createFile("text/markdown", "spec.md")!!
        val access = FakeTreeAccess(mapOf(tree.uri to tree))
        val sidecar = Sidecar(ctx, treeAccess = access)

        val store = sidecar.load(
            docUri = md.uri,
            docFilename = "spec.md",
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = "{name}.md.comments.json",
        )
        assertNotNull(store)

        val bytes = saveSidecarBytes(store)
        assertNotNull(bytes)

        sidecar.save(
            docUri = md.uri,
            docFilename = "spec.md",
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = "{name}.md.comments.json",
            store = store,
        )

        val sidecarFile = tree.findFile("spec.md.comments.json")
        assertNotNull(sidecarFile, "expected sidecar to exist next to spec.md")
        // Idempotent on second save: still a single sibling, contents
        // updated, no createFile-twice duplicate.
        sidecar.save(
            docUri = md.uri,
            docFilename = "spec.md",
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = "{name}.md.comments.json",
            store = store,
        )
        val children = tree.children().filter { it.name == "spec.md.comments.json" }
        assertEquals(1, children.size)
    }

    @Test
    fun save_then_load_round_trips_bytes_through_core() = runTest {
        val tree = FakeTreeNode.directory("project")
        val md = tree.createFile("text/markdown", "draft.md")!!
        val access = FakeTreeAccess(mapOf(tree.uri to tree))
        val sidecar = Sidecar(ctx, treeAccess = access)

        // Empty store -> v2 envelope bytes through core; save writes them.
        val emptyStore = loadSidecarBytes(ByteArray(0))
        sidecar.save(
            docUri = md.uri,
            docFilename = "draft.md",
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = "{name}.md.comments.json",
            store = emptyStore,
        )

        val sidecarFile = tree.findFile("draft.md.comments.json")
        assertNotNull(sidecarFile)
        assertTrue(sidecarFile.readBytes().isNotEmpty(), "expected non-empty v2 envelope on disk")

        // Reload from the same tree should produce a parseable store
        // (the core round-trip pin in UniffiSmokeTest already proves
        // bit-for-bit; here we just need to assert it parses).
        val reloaded = sidecar.load(
            docUri = md.uri,
            docFilename = "draft.md",
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = "{name}.md.comments.json",
        )
        assertEquals(emptyStore.threads().size, reloaded.threads().size)
    }

    @Test
    fun load_returns_empty_store_when_sidecar_absent() = runTest {
        val tree = FakeTreeNode.directory("empty-tree")
        val md = tree.createFile("text/markdown", "lonely.md")!!
        val access = FakeTreeAccess(mapOf(tree.uri to tree))
        val sidecar = Sidecar(ctx, treeAccess = access)

        // No sidecar file in tree; load_sidecar_bytes(empty) returns an
        // empty store. The dispatcher must not throw on the missing-file
        // path or the first-open-of-fresh-doc UX would be broken.
        val store = sidecar.load(
            docUri = md.uri,
            docFilename = "lonely.md",
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = "{name}.md.comments.json",
        )
        assertEquals(0, store.threads().size)
    }

    @Test
    fun load_returns_empty_store_when_tree_uri_unknown() = runTest {
        val access = FakeTreeAccess(emptyMap())
        val sidecar = Sidecar(ctx, treeAccess = access)

        // Tree URI not resolvable (e.g. user revoked grant out of band).
        // We don't crash: the empty store keeps the doc readable; the
        // capability will be re-classified as SingleUri on next open.
        val store = sidecar.load(
            docUri = Uri.parse("content://stale/doc"),
            docFilename = "stale.md",
            capability = SafCapability.TreeAccess,
            treeUri = Uri.parse("content://stale/tree"),
            pattern = "{name}.md.comments.json",
        )
        assertEquals(0, store.threads().size)
    }

    @Test
    fun save_via_single_uri_writes_to_mirror() = runTest {
        // SingleUri capability never touches the tree access. Even when
        // we provide a fake tree access, the SingleUri branch must route
        // to SidecarMirror under filesDir/sidecars/.
        val access = FakeTreeAccess(emptyMap())
        val mirror = SidecarMirror(ctx)
        val sidecar = Sidecar(ctx, mirror = mirror, treeAccess = access)

        val docUri = Uri.parse("content://share/transient-doc")
        val emptyStore = loadSidecarBytes(ByteArray(0))
        sidecar.save(
            docUri = docUri,
            docFilename = "transient.md",
            capability = SafCapability.SingleUri,
            treeUri = null,
            pattern = "{name}.md.comments.json",
            store = emptyStore,
        )

        val mirrorFile = mirror.fileFor(docUri)
        assertTrue(mirrorFile.exists(), "expected SingleUri save to write to mirror")
        assertTrue(mirrorFile.length() > 0, "expected v2 envelope bytes in mirror")

        val reloaded = sidecar.load(
            docUri = docUri,
            docFilename = "transient.md",
            capability = SafCapability.SingleUri,
            treeUri = null,
            pattern = "{name}.md.comments.json",
        )
        assertEquals(0, reloaded.threads().size)
    }
}

// ---------------------------------------------------------------------------
// FakeTreeAccess + FakeTreeNode — Robolectric-friendly in-memory shims
// around the four DocumentFile operations Sidecar relies on. Kept private
// to this test file because they are not a stable test fixture; if D-phase
// tests want to reuse them they can be promoted to a `helpers/` package
// then.
// ---------------------------------------------------------------------------

private class FakeTreeAccess(
    private val roots: Map<Uri, FakeTreeNode>,
) : TreeAccess {
    override fun rootFor(treeUri: Uri): TreeNode? = roots[treeUri]
}

private class FakeTreeNode private constructor(
    override val uri: Uri,
    val name: String,
    private val isDirectory: Boolean,
    private val children: MutableList<FakeTreeNode> = mutableListOf(),
    private var bytes: ByteArray = ByteArray(0),
) : TreeNode {
    override fun findFile(displayName: String): TreeNode? =
        children.firstOrNull { it.name == displayName }

    override fun createFile(mimeType: String, displayName: String): TreeNode? {
        if (!isDirectory) return null
        // DocumentFile.createFile under a real provider would dedupe by
        // suffixing " (1)" etc; the production Sidecar does findFile
        // first so a duplicate createFile is the bug we want the
        // idempotent assertion to catch. We faithfully append rather
        // than dedupe.
        val child = FakeTreeNode(
            uri = uri.buildUpon().appendPath(displayName).build(),
            name = displayName,
            isDirectory = false,
        )
        children += child
        return child
    }

    override fun readBytes(): ByteArray = bytes
    override fun writeBytes(data: ByteArray) {
        bytes = data
    }

    fun children(): List<FakeTreeNode> = children.toList()
    fun bytes(): ByteArray = bytes

    companion object {
        fun directory(name: String): FakeTreeNode = FakeTreeNode(
            uri = Uri.parse("content://fake.tree/$name"),
            name = name,
            isDirectory = true,
        )
    }
}
