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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.FileNotFoundException

/**
 * Public seam between framework-issued document URIs and the rest of
 * the app, narrowed to the read pathway used by the UI/ViewModel layer.
 *
 * Why a separate interface above the concrete [DocumentRepository]:
 * production wiring takes a [Context] (the SAF + ContentResolver calls
 * need one), but ViewModel unit tests are cheaper and clearer when
 * they inject a Context-free fake that simply returns a pre-built
 * [OpenedDocument] (or throws). Both signatures stay suspend so the
 * interface preserves the IO-thread dispatch contract the production
 * implementation honours via `withContext(Dispatchers.IO)`.
 */
interface DocumentRepositoryApi {
    /** Reads + classifies the document at [uri]. */
    suspend fun open(uri: Uri): OpenedDocument

    /** Re-reads the document at [uri] without re-taking the persistable grant. */
    suspend fun reload(uri: Uri): OpenedDocument
}

class DocumentRepository(ctx: Context) : DocumentRepositoryApi {

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
