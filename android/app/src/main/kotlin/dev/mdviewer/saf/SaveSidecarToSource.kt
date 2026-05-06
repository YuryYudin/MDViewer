// ---------------------------------------------------------------------------
// SaveSidecarToSource — promotes a SidecarMirror file to a sibling of the
// source document once the user grants tree access via
// ACTION_OPEN_DOCUMENT_TREE.
//
// Trigger surface: the user opened a document via a single-URI grant
// (DocumentRepository classified the open as SafCapability.SingleUri)
// and posted comments. Those comments live in the app-private mirror
// under filesDir/sidecars/. The SafCapabilityBanner offers a "Share
// back" affordance — when the user taps it, we fire
// ACTION_OPEN_DOCUMENT_TREE so they can pick the parent folder of the
// source document. On grant, this class flushes the mirror payload to
// a sibling of the source URI.
//
// Five-step sequence in [onTreeGranted]:
//
//   1. Take a persistable RW grant on the new tree URI. Wrapped in
//      try/catch — some providers refuse persistence even on
//      legitimate grants (transient session URIs in particular).
//      Take failure is non-fatal: the in-process write may still
//      succeed; the persistable grant only matters across process
//      restarts. If it fails AND the in-process write also fails,
//      step 4 returns false and preserves the mirror.
//
//   2. Read the mirror bytes. Empty mirror is a no-op success — the
//      "Share back" button is reachable in states where no comments
//      have been posted yet (e.g. user opened the doc, immediately
//      tapped the banner). Don't fail those.
//
//   3. Walk the granted tree for any pre-existing sibling sidecar.
//      The "Avoid" section in e3.md is explicit: don't silently
//      overwrite. Instead, mergeStores(existing, mirror) so out-of-
//      band edits the desktop made survive the promotion.
//
//   4. Write the merged store via [Sidecar.save] — same code path
//      Sidecar uses for every other tree-access write.
//
//   5. Verify the sibling exists on disk and is non-empty before
//      deleting the mirror. The verification is the only thing that
//      stands between a quota-rejected provider write and silent
//      data loss; we deliberately re-walk the tree rather than trust
//      the create-or-overwrite return value.
//
// Why a function injection (`permissionTaker`) for the persistable-grant
// call: Robolectric's ContentResolver shim throws on
// `takePersistableUriPermission` because the underlying
// IContentService binder is unavailable. The host-JVM tests inject a
// no-op; the production call site uses the default (real
// ContentResolver call). Tests for the production wiring run
// instrumented on a real device.
//
// Why no auto-promotion from [Sidecar.save]: the mirror -> tree
// promotion is the user's choice (banner tap = consent). Auto-promoting
// inside Sidecar.save would surprise the user with a sudden tree-prompt
// the moment they posted a comment, and would mix two distinct flows.
// Keeping the promotion explicit here lets Sidecar.save stay simple:
// "write to whatever capability you were handed".
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.Context
import android.content.Intent
import android.net.Uri
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.core.mergeStores
import dev.mdviewer.core.sidecarFilename
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Function type for the persistable-permission-take side effect. The
 * production wiring is a one-line [android.content.ContentResolver]
 * call; tests inject a no-op so Robolectric's stub doesn't throw.
 *
 * Returns nothing — the production call is allowed to fail (transient
 * URI providers reject persistence by design). [SaveSidecarToSource]
 * does NOT short-circuit on take failure: a failed take only means
 * the grant won't survive a process restart; the in-process write
 * still works. The caller of `onTreeGranted` re-prompts the next
 * session if needed.
 */
typealias PermissionTaker = (Context, Uri) -> Unit

class SaveSidecarToSource(
    private val mirror: SidecarMirror,
    private val sidecar: SidecarApi,
    private val sidecarPattern: () -> String,
    private val treeAccess: TreeAccess,
    private val permissionTaker: PermissionTaker = ::defaultPermissionTaker,
) {

    /**
     * Builds the [Intent] the SafCapabilityBanner uses to fire the
     * system tree picker. The activity-side launcher contract returns
     * the granted tree URI back through `ActivityResult`; the consumer
     * then calls [onTreeGranted] with that URI to flush the mirror.
     *
     * Kept as a static-style factory so the banner doesn't need to
     * know about ACTION_OPEN_DOCUMENT_TREE flag mechanics.
     */
    fun buildTreePickerIntent(): Intent =
        Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            // FLAG_GRANT_READ + FLAG_GRANT_WRITE so the resulting tree
            // URI is RW once the user picks. Without WRITE, the
            // sibling-create call would fail with a SecurityException
            // even though the user explicitly granted folder access.
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
            )
        }

    /**
     * Flushes the mirror for [docUri] to the granted [treeUri].
     *
     * Returns true on success (sibling exists post-write OR mirror
     * was empty so no flush was needed), false on a benign failure
     * mode (tree no longer reachable, sibling failed to materialize,
     * read-back length check failed). On false, the mirror is
     * preserved so the user can retry.
     *
     * Throws if the sidecar layer raises an exception that's not in
     * the contract (malformed bytes, etc.) — those propagate up to
     * the caller's coroutine scope so the snackbar can surface them.
     */
    suspend fun onTreeGranted(
        ctx: Context,
        docUri: Uri,
        docFilename: String,
        treeUri: Uri,
    ): Boolean = withContext(Dispatchers.IO) {
        // Step 1: take the persistable RW grant. Failure is non-fatal.
        // Wrapping the SecurityException explicitly — the ContentResolver
        // contract throws when the URI was not actually granted to us
        // (race between picker dismiss and intent receipt), and we'd
        // rather preserve the mirror than crash.
        try {
            permissionTaker(ctx, treeUri)
        } catch (_: SecurityException) {
            // Continue — the in-process write may still succeed even
            // without persistence. If it does, future opens of this
            // doc will downgrade to SingleUri because the grant didn't
            // survive, but the comments will at least be in the source
            // folder.
        }

        // Step 2: read mirror bytes. Empty mirror = nothing to flush.
        val mirrorBytes = mirror.load(docUri)
        if (mirrorBytes.isEmpty()) {
            // Nothing to write — but the user's intent was "share back",
            // which is now satisfied. Return true so the UI doesn't
            // surface a misleading error.
            return@withContext true
        }

        // Step 3: parse the mirror, then walk the tree for any
        // existing sibling and merge. The merge is the data-loss
        // guard from e3.md's "Avoid" — we cannot blow away a sidecar
        // the desktop wrote in the meantime.
        val mirrorStore = loadSidecarBytes(mirrorBytes)
        val pattern = sidecarPattern()
        val existing = sidecar.load(
            docUri = docUri,
            docFilename = docFilename,
            capability = SafCapability.TreeAccess,
            treeUri = treeUri,
            pattern = pattern,
        )
        val merged = mergeStores(existing, mirrorStore)

        // Step 4: write the merged store. Sidecar.save throws on a
        // missing root (treeUri unreachable); the runCatching surfaces
        // that as a `false` return so the caller can keep the mirror.
        val saveResult = runCatching {
            sidecar.save(
                docUri = docUri,
                docFilename = docFilename,
                capability = SafCapability.TreeAccess,
                treeUri = treeUri,
                pattern = pattern,
                store = merged,
            )
        }
        if (saveResult.isFailure) {
            return@withContext false
        }

        // Step 5: read-back verification. We re-walk the tree (not the
        // cached node from save) because the provider may have moved
        // the node under us during write. Check existence + non-empty
        // length before deleting the mirror — if the provider quietly
        // dropped the bytes, the mirror is the only remaining copy of
        // the user's data.
        val name = sidecarFilename(docFilename, pattern)
        val root = treeAccess.rootFor(treeUri) ?: return@withContext false
        val sibling = root.findFile(name) ?: return@withContext false
        val siblingBytes = sibling.readBytes()
        if (siblingBytes.isEmpty()) {
            return@withContext false
        }

        mirror.delete(docUri)
        true
    }

    companion object {
        /**
         * Production [PermissionTaker]: takes a persistable RW grant
         * on [treeUri] via [android.content.ContentResolver.takePersistableUriPermission].
         *
         * Pulled out as a top-level (well, companion-object) function
         * so test wiring can swap it for a no-op without subclassing.
         * The default constructor of [SaveSidecarToSource] picks this
         * via method-reference (`::defaultPermissionTaker`).
         */
        @JvmStatic
        fun defaultPermissionTaker(ctx: Context, treeUri: Uri) {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            ctx.contentResolver.takePersistableUriPermission(treeUri, flags)
        }
    }
}
