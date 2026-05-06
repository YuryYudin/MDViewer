// ---------------------------------------------------------------------------
// Sidecar — two-tier IO dispatcher for the comments JSON that sits next
// to (or in lieu of) every opened markdown document.
//
// Tier selection is driven by the SafCapability the DocumentRepository
// classified at open time:
//
//   * SafCapability.TreeAccess — the user has a parent-folder grant in
//     scope. Sidecar.save writes a sibling file via DocumentFile.fromTreeUri
//     + findFile/createFile; Sidecar.load reads it back via the same
//     traversal. On rename of the parent folder (Drive frequently rewrites
//     ids on rename), the sidecar URI is recomputed every save by walking
//     from the freshly-handed treeUri rather than caching the URI from
//     the prior write — a stale cached sibling URI is the most common
//     "where did my comments go" failure mode the design is wary of.
//
//   * SafCapability.SingleUri — no parent grant; we mirror the comments
//     JSON into the app-private SidecarMirror (see SidecarMirror.kt for
//     the full rationale on hashing + filesDir placement). On the next
//     open of the same doc URI the mirror surfaces the same comments,
//     even though we never had write access to the source's sibling.
//
// The dispatcher keeps the two tiers behind one symmetric load/save
// surface so the C5 ViewModel layer and the D-phase ThreadSheet do not
// have to branch on capability. The capability bit travels with every
// call to keep the dispatcher stateless — caching it would create a
// cross-call hazard if the user's grant set changed mid-session.
//
// `TreeAccess` is the small in-process abstraction over the four
// DocumentFile operations that need a Robolectric-friendly fake. The
// production implementation (`DocumentFileTreeAccess`) wraps
// `androidx.documentfile.provider.DocumentFile.fromTreeUri` + the
// ContentResolver IO calls. Tests replace it with an in-memory shim
// (see SidecarTreeTest's FakeTreeAccess).
//
// Why suspend + Dispatchers.IO: writes to a Drive-backed sibling URI go
// over the network; on the main thread they would block long enough to
// trip StrictMode + ANR. The Sidecar itself does the dispatcher swap so
// every caller (D5's ThreadSheet, D7's ReloadAction, E3's
// SaveSidecarToSource) gets the right thread for free.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.core.saveSidecarBytes
import dev.mdviewer.core.sidecarFilename
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Narrow interface the [dev.mdviewer.ui.ThreadSheetViewModel] (and any future
 * mutation surface — D7's ReloadAction, E3's SaveSidecarToSource) calls into
 * for sidecar IO. The real implementation lives on [Sidecar]; tests inject a
 * fake (see `ThreadSheetViewModelTest.FakeSidecar`) so they don't have to
 * carry a Context or a Robolectric-friendly TreeAccess shim.
 *
 * Why an interface here (and not on the call sites of ViewModels-that-just-
 * happen-to-use-Sidecar): the production Sidecar's collaborators
 * (TreeAccess, SidecarMirror) are themselves test seams already, so a
 * second seam at the ViewModel boundary feels redundant — except that
 * the ViewModel test cares only about *whether* save was called with the
 * right params, not about exercising the bytes round-trip again. Adding
 * a one-method-per-direction interface here keeps that test focused.
 */
interface SidecarApi {
    suspend fun load(
        docUri: Uri,
        docFilename: String,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
    ): CommentsStoreHandle

    suspend fun save(
        docUri: Uri,
        docFilename: String,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
        store: CommentsStoreHandle,
    )
}

class Sidecar(
    ctx: Context,
    private val mirror: SidecarMirror = SidecarMirror(ctx),
    private val treeAccess: TreeAccess = DocumentFileTreeAccess(ctx),
) : SidecarApi {

    // Application context kept for any future need (logging, etc); the
    // real IO happens through `mirror` and `treeAccess`, both of which
    // already captured an app context at construction.
    @Suppress("unused")
    private val appCtx: Context = ctx.applicationContext

    /**
     * Loads the sidecar for [docUri] and returns it as a parsed
     * [CommentsStoreHandle]. The path the bytes take depends on
     * [capability]:
     *
     *   * [SafCapability.TreeAccess] — walk to [treeUri], find the
     *     sibling whose name comes from [sidecarFilename]([docFilename],
     *     [pattern]), read its bytes; if absent, returns an empty store.
     *   * [SafCapability.SingleUri] — read the app-private mirror for
     *     [docUri]; if absent, returns an empty store.
     *
     * The "absent -> empty store" path is load-bearing: it lets the
     * first-open-of-fresh-doc UX skip an extra branch in the caller.
     */
    override suspend fun load(
        docUri: Uri,
        docFilename: String,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
    ): CommentsStoreHandle = withContext(Dispatchers.IO) {
        val sidecarName = sidecarFilename(docFilename, pattern)
        val bytes = when (capability) {
            SafCapability.TreeAccess -> readTreeSibling(treeUri, sidecarName)
            SafCapability.SingleUri -> mirror.load(docUri)
        }
        loadSidecarBytes(bytes)
    }

    /**
     * Persists [store] to the sidecar location implied by [capability]:
     *
     *   * [SafCapability.TreeAccess] — write a sibling JSON file under
     *     [treeUri] using create-or-overwrite via [TreeAccess]. We never
     *     cache the resulting sibling URI: the user can rename the parent
     *     folder out of band (Drive does this on every move), and a
     *     cached child URI would dangle silently. Recomputing on every
     *     save is cheap (one findFile lookup) and bulletproof.
     *
     *   * [SafCapability.SingleUri] — write to the app-private mirror.
     *     The SaveSidecarToSource flow (E3) is what eventually moves the
     *     mirror into a real sibling once the user grants tree access;
     *     this method does NOT auto-promote so a partial promotion can
     *     never lose data.
     *
     * The sidecar filename is always derived from
     * mdviewer-core::sidecar_path::sidecar_filename via the Kotlin UDL
     * binding so the desktop and Android builds agree on the wire-level
     * filename pattern with no Kotlin-side duplication.
     */
    override suspend fun save(
        docUri: Uri,
        docFilename: String,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
        store: CommentsStoreHandle,
    ): Unit = withContext(Dispatchers.IO) {
        val bytes = saveSidecarBytes(store)
        val sidecarName = sidecarFilename(docFilename, pattern)
        when (capability) {
            SafCapability.TreeAccess -> writeTreeSibling(treeUri, sidecarName, bytes)
            SafCapability.SingleUri -> mirror.save(docUri, bytes)
        }
    }

    private fun readTreeSibling(treeUri: Uri?, name: String): ByteArray {
        if (treeUri == null) return ByteArray(0)
        val root = treeAccess.rootFor(treeUri) ?: return ByteArray(0)
        val sibling = root.findFile(name) ?: return ByteArray(0)
        return sibling.readBytes()
    }

    private fun writeTreeSibling(treeUri: Uri?, name: String, bytes: ByteArray) {
        // A null treeUri at TreeAccess capability is a programming error
        // upstream — DocumentRepository only sets capability=TreeAccess
        // when it has a non-null tree URI. Convert to an exception so
        // tests catch the regression rather than silently dropping the
        // save into the void.
        val nonNullTree = treeUri
            ?: error("TreeAccess capability requires a non-null treeUri")

        val root = treeAccess.rootFor(nonNullTree)
            ?: error("Tree URI no longer accessible: $nonNullTree")

        // findFile-then-createFile is the standard documentfile idiom for
        // create-or-overwrite. We *could* call createFile unconditionally
        // and rely on the provider's de-duplication, but DocumentsContract
        // de-dupes by suffixing " (1)" — which would orphan the original
        // sidecar and write to a new sibling each save. Looking up first
        // and writing to the existing node when present is the only
        // correct path here.
        val target = root.findFile(name)
            ?: root.createFile(SIDECAR_MIME, name)
            ?: error("Could not create sidecar $name in tree $nonNullTree")
        target.writeBytes(bytes)
    }

    companion object {
        // application/json is the desktop's mime for the same artifact.
        // Drive surfaces this in its UI and uses it for default-app-open
        // routing; using the right mime makes the sidecar visible as
        // "JSON" rather than "Unknown" when the user browses the folder.
        const val SIDECAR_MIME = "application/json"
    }
}

// ---------------------------------------------------------------------------
// TreeAccess — the four-method seam Sidecar.save/load uses to talk to
// the parent-folder grant. The production wiring goes through
// `androidx.documentfile.provider.DocumentFile`; tests inject an
// in-memory shim. Kept small on purpose so the fake has a tiny surface
// and the real wrapper has nothing to mis-implement.
// ---------------------------------------------------------------------------

interface TreeAccess {
    /**
     * Returns a [TreeNode] rooted at [treeUri], or null when the URI is
     * no longer reachable (user revoked the grant, provider went away).
     * Sidecar.load translates null into "empty store"; Sidecar.save
     * translates it into an exception (the caller knew this was a
     * TreeAccess capability, so a missing tree mid-save is a bug worth
     * surfacing).
     */
    fun rootFor(treeUri: Uri): TreeNode?
}

interface TreeNode {
    /** The URI this node represents; useful for diagnostics. */
    val uri: Uri

    /**
     * Looks up a direct child by display name. Returns null when no
     * child with that name exists. Production walks
     * [DocumentFile.findFile]; the fake walks an in-memory list.
     */
    fun findFile(displayName: String): TreeNode?

    /**
     * Creates a new child under this node with [displayName] and the
     * given [mimeType], returning a node pointing at it. Returns null
     * when this node is not a directory or creation otherwise fails
     * (provider rejected the create). Production calls
     * [DocumentFile.createFile].
     */
    fun createFile(mimeType: String, displayName: String): TreeNode?

    /**
     * Reads the full contents of this node. Empty array when the
     * underlying file is empty (or unreadable for benign reasons —
     * e.g. provider returned null from openInputStream during a Drive
     * sync glitch).
     */
    fun readBytes(): ByteArray

    /**
     * Truncates and writes [data] as the new contents. Production opens
     * the underlying URI in "wt" mode through ContentResolver so the
     * provider is handed the truncate-on-write semantics most callers
     * expect.
     */
    fun writeBytes(data: ByteArray)
}

// ---------------------------------------------------------------------------
// DocumentFileTreeAccess — production implementation of TreeAccess on
// top of `androidx.documentfile.provider.DocumentFile`. Internal because
// no caller outside this file should depend on it directly; everything
// goes through the TreeAccess interface.
// ---------------------------------------------------------------------------

internal class DocumentFileTreeAccess(ctx: Context) : TreeAccess {
    private val appCtx: Context = ctx.applicationContext

    override fun rootFor(treeUri: Uri): TreeNode? {
        val df = DocumentFile.fromTreeUri(appCtx, treeUri) ?: return null
        return DocumentFileNode(appCtx, df)
    }
}

private class DocumentFileNode(
    private val appCtx: Context,
    private val df: DocumentFile,
) : TreeNode {
    override val uri: Uri get() = df.uri

    override fun findFile(displayName: String): TreeNode? =
        df.findFile(displayName)?.let { DocumentFileNode(appCtx, it) }

    override fun createFile(mimeType: String, displayName: String): TreeNode? =
        df.createFile(mimeType, displayName)?.let { DocumentFileNode(appCtx, it) }

    override fun readBytes(): ByteArray =
        appCtx.contentResolver.openInputStream(df.uri)?.use { it.readBytes() }
            ?: ByteArray(0)

    override fun writeBytes(data: ByteArray) {
        // "wt" = write + truncate. Without the "t" some providers (Drive
        // historically) would append on top of the prior bytes, leaving
        // a malformed JSON tail. The DocumentsContract spec only
        // guarantees "w" support but every provider we ship against
        // honors "wt"; if a future SAF-only provider doesn't, we'd
        // surface that as a write-time IOException rather than silent
        // corruption.
        appCtx.contentResolver.openOutputStream(df.uri, "wt")?.use { it.write(data) }
            ?: error("Could not open output stream for ${df.uri}")
    }
}
