// ---------------------------------------------------------------------------
// SaveSidecarToSourceTest — host-JVM coverage of the mirror -> tree
// promotion flow surfaced by the SafCapabilityBanner tap.
//
// The instrumented twin (`SaveSidecarToSourceInstrumentedTest` under
// androidTest/) covers the full ACTION_OPEN_DOCUMENT_TREE round-trip on
// an emulator. This host-JVM test pins the post-grant `onTreeGranted`
// behavior with a [PromoteFakeTreeAccess] + a real [SidecarMirror], so the
// mid-tier flow is under continuous coverage on every commit:
//
//   1. Mirror is read; bytes are parsed via `loadSidecarBytes`.
//   2. The granted tree is walked for any existing sibling sidecar.
//   3. `mergeStores(existing, mirrorStore)` produces the union.
//   4. The merged store is written via [Sidecar.save].
//   5. The sibling is verified to exist and be non-empty before the
//      mirror is deleted.
//
// We deliberately do NOT exercise `takePersistableUriPermission` here —
// Robolectric's ContentResolver shadow rejects the call, and the
// production code wraps it in a try/catch precisely so transient share
// URIs don't crash the flow. The instrumented test runs on a real
// device where the call succeeds; this test injects a bypass via the
// `permissionTaker` constructor seam.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import dev.mdviewer.core.Anchor
import dev.mdviewer.core.NewThread
import dev.mdviewer.core.createThread
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.core.saveSidecarBytes
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class SaveSidecarToSourceTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
    private val pattern = "{name}.md.comments.json"

    @Test
    fun on_tree_granted_flushes_mirror_to_sibling_and_deletes_mirror() = runTest {
        val docUri = Uri.parse("content://share/doc-1")
        val docFilename = "spec.md"

        // Seed the mirror with a single thread.
        val mirror = SidecarMirror(ctx)
        val mirrorStore = createThreadAt("mirror anchor", mirror = mirror, docUri = docUri)
        mirror.save(docUri, saveSidecarBytes(mirrorStore))
        assertTrue(mirror.fileFor(docUri).exists(), "precondition: mirror exists")

        // Granted tree starts empty — no existing sidecar, no merge needed
        // beyond the mirror payload itself.
        val tree = PromoteFakeTreeNode.directory("project")
        val access = PromoteFakeTreeAccess(mapOf(tree.uri to tree))
        val sidecar = Sidecar(ctx, mirror = mirror, treeAccess = access)

        val saveSidecarToSource = SaveSidecarToSource(
            mirror = mirror,
            sidecar = sidecar,
            sidecarPattern = { pattern },
            treeAccess = access,
            permissionTaker = { _, _ -> /* no-op for tests */ },
        )

        val result = saveSidecarToSource.onTreeGranted(
            ctx = ctx,
            docUri = docUri,
            docFilename = docFilename,
            treeUri = tree.uri,
        )
        assertTrue(result, "promotion must report success")

        // Sibling exists in tree and carries the mirror's payload (length
        // alone is the gate the production code checks; we re-load to
        // confirm the thread set comes back through).
        val siblingNode = tree.findFile("spec.md.comments.json")
        assertTrue(siblingNode != null, "expected sibling sidecar in tree")
        assertTrue(
            (siblingNode as PromoteFakeTreeNode).bytes().isNotEmpty(),
            "expected non-empty sidecar bytes",
        )
        val reloaded = sidecar.load(
            docUri = docUri,
            docFilename = docFilename,
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = pattern,
        )
        assertEquals(1, reloaded.threads().size, "sibling carries the mirror's thread")

        // Mirror is gone — only after the read-back length check passed.
        assertTrue(!mirror.fileFor(docUri).exists(), "mirror file must be deleted post-flush")
    }

    @Test
    fun on_tree_granted_merges_mirror_with_existing_sibling() = runTest {
        // The "Avoid" section in e3.md is explicit: a sibling that
        // already exists must NOT be silently overwritten. Instead we
        // mergeStores() with the mirror so out-of-band edits survive.
        val docUri = Uri.parse("content://share/doc-merge")
        val docFilename = "draft.md"

        // Seed the tree with a sibling sidecar containing one thread.
        val tree = PromoteFakeTreeNode.directory("merge-project")
        val access = PromoteFakeTreeAccess(mapOf(tree.uri to tree))
        val mirror = SidecarMirror(ctx)
        val sidecar = Sidecar(ctx, mirror = mirror, treeAccess = access)

        val seedTreeStore = loadSidecarBytes(ByteArray(0)).let { empty ->
            createThread(
                store = empty,
                input = NewThread(
                    anchor = Anchor(
                        selectorText = "tree-side anchor",
                        contextBefore = "",
                        contextAfter = "",
                        charStart = 0u,
                        charEnd = 16u,
                    ),
                    body = "from tree",
                    authorId = "u-tree",
                    authorName = "Tree",
                    authorColor = "#0066FF",
                ),
            )
            empty
        }
        sidecar.save(
            docUri = docUri,
            docFilename = docFilename,
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = pattern,
            store = seedTreeStore,
        )
        val treeOnlyThreadIds = sidecar.load(
            docUri = docUri,
            docFilename = docFilename,
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = pattern,
        ).threads().map { it.id }
        assertEquals(1, treeOnlyThreadIds.size, "precondition: tree sidecar has one thread")

        // Seed the mirror with a different thread.
        val mirrorStore = createThreadAt(
            anchorText = "mirror-side anchor",
            mirror = mirror,
            docUri = docUri,
            authorId = "u-mirror",
        )
        mirror.save(docUri, saveSidecarBytes(mirrorStore))

        val saveSidecarToSource = SaveSidecarToSource(
            mirror = mirror,
            sidecar = sidecar,
            sidecarPattern = { pattern },
            treeAccess = access,
            permissionTaker = { _, _ -> },
        )

        val result = saveSidecarToSource.onTreeGranted(
            ctx = ctx,
            docUri = docUri,
            docFilename = docFilename,
            treeUri = tree.uri,
        )
        assertTrue(result)

        // Both threads are in the merged sibling. Order is not pinned —
        // Automerge's union doesn't promise insertion order across stores.
        val merged = sidecar.load(
            docUri = docUri,
            docFilename = docFilename,
            capability = SafCapability.TreeAccess,
            treeUri = tree.uri,
            pattern = pattern,
        )
        assertEquals(
            2,
            merged.threads().size,
            "merge must preserve both tree-side and mirror-side threads",
        )

        // Mirror is gone — only after the post-write verification.
        assertTrue(!mirror.fileFor(docUri).exists())
    }

    @Test
    fun on_tree_granted_returns_true_with_no_mirror_and_does_nothing() = runTest {
        // Empty mirror is a normal state (the user opens a fresh single-
        // URI doc, never posts anything, then taps "Share back"). The
        // flow should succeed without writing or deleting.
        val docUri = Uri.parse("content://share/doc-empty")
        val tree = PromoteFakeTreeNode.directory("empty")
        val access = PromoteFakeTreeAccess(mapOf(tree.uri to tree))
        val mirror = SidecarMirror(ctx)
        val sidecar = Sidecar(ctx, mirror = mirror, treeAccess = access)

        val saveSidecarToSource = SaveSidecarToSource(
            mirror = mirror,
            sidecar = sidecar,
            sidecarPattern = { pattern },
            treeAccess = access,
            permissionTaker = { _, _ -> },
        )

        val result = saveSidecarToSource.onTreeGranted(
            ctx = ctx,
            docUri = docUri,
            docFilename = "lonely.md",
            treeUri = tree.uri,
        )
        assertTrue(result, "no-op promotion should still report success")
        assertTrue(tree.children().none { it.name.endsWith(".comments.json") },
            "no sidecar should be created when mirror is empty")
    }

    @Test
    fun on_tree_granted_returns_false_when_tree_unreachable() = runTest {
        // Granted URI that resolves to nothing (provider revoked, etc.).
        // The flow must not delete the mirror in that case — if we did,
        // the user's local data would be gone with no place to read it
        // back from.
        val docUri = Uri.parse("content://share/doc-bad-tree")
        val mirror = SidecarMirror(ctx)
        val mirrorStore = createThreadAt(
            anchorText = "mirror only",
            mirror = mirror,
            docUri = docUri,
        )
        mirror.save(docUri, saveSidecarBytes(mirrorStore))

        val access = PromoteFakeTreeAccess(emptyMap())
        val sidecar = Sidecar(ctx, mirror = mirror, treeAccess = access)

        val saveSidecarToSource = SaveSidecarToSource(
            mirror = mirror,
            sidecar = sidecar,
            sidecarPattern = { pattern },
            treeAccess = access,
            permissionTaker = { _, _ -> },
        )

        val unreachable = Uri.parse("content://stale/tree")
        val result = runCatching {
            saveSidecarToSource.onTreeGranted(
                ctx = ctx,
                docUri = docUri,
                docFilename = "x.md",
                treeUri = unreachable,
            )
        }
        // Either returns false OR throws — both are acceptable failure
        // modes; the contract is "do not delete the mirror".
        assertTrue(result.isFailure || result.getOrNull() == false)
        assertTrue(
            mirror.fileFor(docUri).exists(),
            "mirror must NOT be deleted when tree write failed",
        )
    }

    // ---------- helpers ---------------------------------------------------

    private fun createThreadAt(
        anchorText: String,
        mirror: SidecarMirror,
        docUri: Uri,
        authorId: String = "u-test",
    ): dev.mdviewer.core.CommentsStoreHandle {
        val empty = loadSidecarBytes(mirror.load(docUri))
        createThread(
            store = empty,
            input = NewThread(
                anchor = Anchor(
                    selectorText = anchorText,
                    contextBefore = "",
                    contextAfter = "",
                    charStart = 0u,
                    charEnd = anchorText.length.toUInt(),
                ),
                body = "body",
                authorId = authorId,
                authorName = "Tester",
                authorColor = "#FF0066",
            ),
        )
        return empty
    }
}

// ---------------------------------------------------------------------------
// PromoteFakeTreeAccess + PromoteFakeTreeNode — duplicated from SidecarTreeTest because
// those are file-private. Once two saf tests reuse the fake, promote it
// to a `helpers/` source set; today the duplication is the simpler
// path (the API is small and changes infrequently). Kept file-private
// here to avoid colliding with SidecarTreeTest's identically-named
// (also file-private) shims.
// ---------------------------------------------------------------------------

private class PromoteFakeTreeAccess(
    private val roots: Map<Uri, PromoteFakeTreeNode>,
) : TreeAccess {
    override fun rootFor(treeUri: Uri): TreeNode? = roots[treeUri]
}

private class PromoteFakeTreeNode private constructor(
    override val uri: Uri,
    val name: String,
    private val isDirectory: Boolean,
    private val children: MutableList<PromoteFakeTreeNode> = mutableListOf(),
    private var bytes: ByteArray = ByteArray(0),
) : TreeNode {
    override fun findFile(displayName: String): TreeNode? =
        children.firstOrNull { it.name == displayName }

    override fun createFile(mimeType: String, displayName: String): TreeNode? {
        if (!isDirectory) return null
        val child = PromoteFakeTreeNode(
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

    fun children(): List<PromoteFakeTreeNode> = children.toList()
    fun bytes(): ByteArray = bytes

    companion object {
        fun directory(name: String): PromoteFakeTreeNode = PromoteFakeTreeNode(
            uri = Uri.parse("content://fake.tree/$name"),
            name = name,
            isDirectory = true,
        )
    }
}
