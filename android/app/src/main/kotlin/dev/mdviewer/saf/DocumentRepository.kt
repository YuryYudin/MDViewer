// ---------------------------------------------------------------------------
// DocumentRepository — single hand-off between framework-issued document
// URIs and the rest of the app.
//
// What this class owns:
//   * Reading the document bytes via ContentResolver.openInputStream on
//     Dispatchers.IO — main-thread file reads from a Drive-backed provider
//     can stall for seconds and trip StrictMode + ANR.
//   * Taking a persistable read grant where the provider allows it. Some
//     providers (notably some share-intent producers) deny
//     takePersistableUriPermission with SecurityException; we swallow that
//     so the share-receive flow E3 wires keeps working without a crash.
//   * Classifying the URI into TreeAccess vs SingleUri by scanning
//     ContentResolver.persistedUriPermissions for an enclosing tree grant
//     whose document id is a prefix of this document's id.
//
// What this class deliberately does NOT do:
//   * Prompt for folder access. That's a UI concern in C5 — repository's
//     job is to *detect* capability, not to nudge the user.
//   * Persist anything to Recents. Recents is a data-layer store the
//     ViewModel layer writes to *after* a successful open, threading
//     OpenedDocument.uri / displayName / capability across.
//   * Decode the bytes into rendered HTML. That happens at the
//     mdviewer-core boundary downstream; this class stays encoding-
//     agnostic so binary-but-mislabelled .md files surface as a render
//     error rather than a load error.
//
// Threading: open() and reload() are suspending, both go through
// Dispatchers.IO. Callers from a Compose ViewModel should launch on
// viewModelScope; callers from the share-intent receiver in E3 should
// launch on Dispatchers.Main + immediate so the reading is queued before
// the activity finishes its onCreate.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.mergeStores
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.FileNotFoundException

/**
 * The shape returned by [DocumentRepositoryApi.reloadWithSidecar].
 *
 * Carries everything the caller needs to (a) re-render the document
 * (`opened.bytes`), (b) swap its in-memory comments store
 * (`mergedStore`), and (c) surface the wireframe-10 snackbar copy
 * (`addedCount` / `changedCount`).
 *
 * Two diff axes:
 *   * [addedCount] — thread ids present in the merged store that were
 *     not in the local store before the merge.
 *   * [changedCount] — thread ids present on both sides whose comment
 *     count or `resolved` flag differ between the local-pre-merge
 *     snapshot and the merged-post snapshot. A reply on the desktop
 *     side, or a desktop-side resolve, lands here.
 *
 * The two counts are independent dimensions; the snackbar adds them
 * together for the user-facing "$N new comments" line because the
 * user does not care whether a thread is brand-new or simply grew —
 * either way "something changed".
 */
data class RefreshDelta(
    val addedCount: Int,
    val changedCount: Int,
    val mergedStore: CommentsStoreHandle,
    val opened: OpenedDocument,
) {
    /** Total surface count for the snackbar. */
    val totalNew: Int get() = addedCount + changedCount
}

/**
 * Public seam between framework-issued document URIs and the rest of
 * the app, narrowed to the read pathway used by the UI/ViewModel layer.
 *
 * Why a separate interface above the concrete [DocumentRepository]:
 * production wiring takes a [Context] (the SAF + ContentResolver calls
 * need one), but ViewModel unit tests are cheaper and clearer when
 * they inject a Context-free fake that simply returns a pre-built
 * [OpenedDocument] (or throws). All signatures stay suspend so the
 * interface preserves the IO-thread dispatch contract the production
 * implementation honours via `withContext(Dispatchers.IO)`.
 */
interface DocumentRepositoryApi {
    /** Reads + classifies the document at [uri]. */
    suspend fun open(uri: Uri): OpenedDocument

    /** Re-reads the document at [uri] without re-taking the persistable grant. */
    suspend fun reload(uri: Uri): OpenedDocument

    /**
     * Manual-reload entry point for D7's "Reload" affordance.
     *
     * Re-reads the document bytes (so the rendered HTML can pick up an
     * out-of-band edit on the source markdown), reads the sidecar bytes
     * via the configured [SidecarApi], parses the incoming bytes through
     * `loadSidecarBytes`, and merges them with [currentLocalStore] using
     * the Automerge-union semantics of `merge_stores`. Returns the
     * [RefreshDelta] computed against the local-pre-merge snapshot.
     *
     * The caller — typically [dev.mdviewer.ui.DocumentViewModel.reload] —
     * is expected to:
     *   1. Replace its in-memory store reference with [RefreshDelta.mergedStore].
     *   2. Re-render the HTML from [RefreshDelta.opened.bytes].
     *   3. Surface the snackbar message derived from [RefreshDelta.totalNew].
     *
     * Why this lives on the repository (and not in the ViewModel):
     * reloading is a SAF-shaped operation (re-read bytes, re-classify
     * capability, walk the tree URI) that already belongs here; pulling
     * the merge step in keeps the diff math close to the bytes round-trip
     * and lets the ViewModel stay free of the `mergeStores` import.
     */
    suspend fun reloadWithSidecar(
        uri: Uri,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
        currentLocalStore: CommentsStoreHandle,
    ): RefreshDelta
}

class DocumentRepository(
    ctx: Context,
    /**
     * Sidecar IO collaborator used by [reloadWithSidecar] to fetch the
     * incoming bytes. Defaults to a production [Sidecar] bound to the
     * same context; tests can substitute a fake that returns pre-built
     * [CommentsStoreHandle]s without touching the SAF tree.
     */
    internal val sidecar: SidecarApi = Sidecar(ctx),
) : DocumentRepositoryApi {

    // Capture only the application context to avoid leaking activity
    // references through long-lived ViewModels / DI singletons.
    private val appCtx: Context = ctx.applicationContext

    /**
     * Reads the document at [uri] and resolves its SAF capability.
     *
     * On success, the returned [OpenedDocument] carries the raw bytes
     * plus the runtime [SafCapability]. On a missing or unreadable URI,
     * throws [FileNotFoundException] (when the provider returns null
     * from openInputStream) or whatever IOException the provider raised
     * during the actual read.
     *
     * Side effect: takes a persistable read grant via
     * [android.content.ContentResolver.takePersistableUriPermission] when
     * the provider allows it. Failures are swallowed (transient share-
     * intent URIs deny persistence by design); they don't affect the
     * capability classification or the read result.
     */
    override suspend fun open(uri: Uri): OpenedDocument = withContext(Dispatchers.IO) {
        readDocument(uri, takePermission = true)
    }

    /**
     * Re-reads the document at [uri] without re-taking the persistable
     * grant (the original [open] call already took it; re-taking is a
     * no-op against the same flags but we skip the call to keep the hot
     * path cheap and to avoid the SecurityException-swallow on transient
     * URIs that happen to expire mid-session).
     *
     * Used by the manual-reload affordance in D7 and by the resume path
     * when the document changes underneath us.
     */
    override suspend fun reload(uri: Uri): OpenedDocument = withContext(Dispatchers.IO) {
        readDocument(uri, takePermission = false)
    }

    /**
     * Re-reads the document + the on-disk sidecar, merges the sidecar
     * with [currentLocalStore], and returns a [RefreshDelta] the caller
     * uses to drive the snackbar + state replacement.
     *
     * The diff math snapshots `currentLocalStore.threads()` BEFORE the
     * merge (so locally-posted threads are visible in the "before" set)
     * and the merged store's threads AFTER. Added = post-only ids;
     * changed = same id, different comment count or resolved flag. The
     * snapshots are by thread id rather than full equality because
     * Automerge can re-order the comments list without that being a
     * user-visible change.
     *
     * Errors thrown by the sidecar load (provider exception, malformed
     * bytes that core's `load_sidecar_bytes` rejects with `CoreError`)
     * propagate up; the ViewModel catches them and surfaces an
     * "Could not reload" toast rather than a silent stale state.
     */
    override suspend fun reloadWithSidecar(
        uri: Uri,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
        currentLocalStore: CommentsStoreHandle,
    ): RefreshDelta = withContext(Dispatchers.IO) {
        // Re-read the document first so a sidecar read failure doesn't
        // leave us with a partial result. open() also re-classifies
        // capability (the user may have revoked tree access between
        // sessions); we honour the *passed-in* capability here because
        // the caller already snapshotted it at open time and a mid-
        // session capability change is E3's concern, not ours.
        val opened = readDocument(uri, takePermission = false)

        // Snapshot the local store BEFORE the merge. mergeStores returns
        // a new handle (no in-place mutation), so the local handle's
        // threads() is still the pre-merge view at this point.
        val before = currentLocalStore.threads().associateBy { it.id }

        val incoming = sidecar.load(
            docUri = uri,
            docFilename = opened.displayName,
            capability = capability,
            treeUri = treeUri,
            pattern = pattern,
        )
        val merged = mergeStores(currentLocalStore, incoming)
        val after = merged.threads().associateBy { it.id }

        val added = (after.keys - before.keys).size
        val changed = after.values.count { aft ->
            val bef = before[aft.id]
            bef != null && (
                bef.comments.size != aft.comments.size ||
                    bef.resolved != aft.resolved
                )
        }

        RefreshDelta(
            addedCount = added,
            changedCount = changed,
            mergedStore = merged,
            opened = opened,
        )
    }

    private fun readDocument(uri: Uri, takePermission: Boolean): OpenedDocument {
        val cr = appCtx.contentResolver

        // Take the persistable read grant *before* we read so a successful
        // grant survives even a subsequent IOException — that way a flaky
        // read (Drive sync glitch) doesn't leave us with no permission to
        // retry from. Transient URIs (share-intent producers) deny the
        // grant with SecurityException; that's fine and expected.
        if (takePermission) {
            try {
                cr.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION,
                )
            } catch (_: SecurityException) {
                // Transient URI; capability is unaffected. The classifier
                // below will still correctly report SingleUri unless an
                // enclosing tree grant happens to exist from a prior
                // session.
            }
        }

        val bytes = cr.openInputStream(uri)?.use { it.readBytes() }
            ?: throw FileNotFoundException("Could not open input stream for $uri")

        val displayName = queryDisplayName(uri)
            ?: uri.lastPathSegment?.substringAfterLast('/')
            ?: "untitled.md"

        val (capability, treeUri) = classifyCapability(uri)

        return OpenedDocument(uri, displayName, bytes, capability, treeUri)
    }

    /**
     * Decides whether [uri] is reachable via a previously-persisted tree
     * grant. The check is: among all read-permission tree URIs in
     * [android.content.ContentResolver.persistedUriPermissions], is there
     * one whose tree-document-id is a strict prefix of this document's
     * document-id (delimited by `/`).
     *
     * Edge cases:
     *   * URIs that don't carry a parseable document id (e.g. file:// URIs
     *     mistakenly handed in) classify as [SafCapability.SingleUri] —
     *     they can be read but not "tree walked".
     *   * A tree grant for the *exact* same id (no `/` suffix) is also
     *     considered a tree match — this covers the case where the user
     *     opens a folder and the folder URI itself is treated as the doc.
     */
    private fun classifyCapability(uri: Uri): Pair<SafCapability, Uri?> {
        val cr = appCtx.contentResolver

        val docId = runCatching { DocumentsContract.getDocumentId(uri) }.getOrNull()
            ?: return SafCapability.SingleUri to null

        for (perm in cr.persistedUriPermissions) {
            if (!perm.isReadPermission) continue
            val candidate = perm.uri
            val treeDocId = runCatching { DocumentsContract.getTreeDocumentId(candidate) }
                .getOrNull() ?: continue

            if (docId == treeDocId || docId.startsWith("$treeDocId/")) {
                return SafCapability.TreeAccess to candidate
            }
        }
        return SafCapability.SingleUri to null
    }

    private fun queryDisplayName(uri: Uri): String? {
        // Defensive try/catch — some providers throw on the OpenableColumns
        // query (Drive's read-only mode under offline) and we'd rather
        // fall back to the path-segment name than fail the whole open.
        return runCatching {
            appCtx.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME),
                null,
                null,
                null,
            )?.use { c ->
                if (c.moveToFirst() && c.columnCount > 0) c.getString(0) else null
            }
        }.getOrNull()
    }
}
