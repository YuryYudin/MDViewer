// ---------------------------------------------------------------------------
// SafCapability — what the Storage Access Framework will let us do with a
// document URI we've just opened.
//
// Two tiers, mirroring SafTier under dev.mdviewer.data but kept separate
// here because:
//   * SafTier (data layer) is the *persisted* bit on a Recents entry —
//     answers "how was this URI originally granted?" so the C5 reload
//     flow knows whether to expect TreeAccess to still be available.
//   * SafCapability (saf layer) is the *runtime* bit computed at open-time
//     by inspecting ContentResolver.persistedUriPermissions — answers
//     "right now, can we touch this doc's siblings without re-prompting?"
//
// They line up 1:1 today but the runtime check is the source of truth: a
// user who revoked folder access between sessions will see TreeAccess
// downgrade to SingleUri on the next open, even if Recents still says
// TreeAccess. The C5 sidecar writer routes off the runtime capability,
// not the persisted tier.
//
// OpenedDocument bundles the bytes + metadata + capability into one
// immutable record so the call site doesn't have to thread four return
// values through the ViewModel layer. `treeUri` is non-null exactly when
// `capability == TreeAccess` — it's the parent tree grant the C5/E5
// sidecar writer hands to DocumentFile.fromTreeUri.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.net.Uri

enum class SafCapability {
    /**
     * The user has previously granted ACTION_OPEN_DOCUMENT_TREE access to a
     * folder whose document id is the parent of this document's id. We can
     * walk siblings via DocumentFile.fromTreeUri and write the sidecar
     * comments JSON next to the source without re-prompting.
     */
    TreeAccess,

    /**
     * We hold a single-document grant only. Reads/writes against this URI
     * work; touching siblings requires a fresh ACTION_OPEN_DOCUMENT_TREE
     * prompt (surfaced by C5's "grant folder access" nudge when the user
     * hasn't already dismissed it for this doc).
     */
    SingleUri,
}

/**
 * The result of [DocumentRepository.open] — the document bytes plus the
 * metadata the caller needs to render and to decide which sidecar
 * pathway applies.
 *
 * @property uri the original URI handed in to [DocumentRepository.open].
 * @property displayName user-facing name resolved from
 *   [android.provider.OpenableColumns.DISPLAY_NAME], with a fallback to
 *   the URI's last path segment when the provider doesn't expose one.
 * @property bytes raw file bytes; UTF-8 decoding happens at the renderer
 *   boundary (where the desktop's `mdviewer-core` lives) so this layer
 *   stays encoding-agnostic.
 * @property capability runtime SAF tier (see [SafCapability]).
 * @property treeUri the parent tree URI when [capability] is
 *   [SafCapability.TreeAccess]; null otherwise. Stable across the lifetime
 *   of the persisted grant.
 */
data class OpenedDocument(
    val uri: Uri,
    val displayName: String,
    val bytes: ByteArray,
    val capability: SafCapability,
    val treeUri: Uri?,
) {
    // ByteArray uses identity equality by default; data-class equals would
    // therefore lie about content equality. Override so test assertions
    // and downstream caching layers (think: dirty-tracking on reload) can
    // compare two OpenedDocuments meaningfully.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is OpenedDocument) return false
        return uri == other.uri &&
            displayName == other.displayName &&
            bytes.contentEquals(other.bytes) &&
            capability == other.capability &&
            treeUri == other.treeUri
    }

    override fun hashCode(): Int {
        var result = uri.hashCode()
        result = 31 * result + displayName.hashCode()
        result = 31 * result + bytes.contentHashCode()
        result = 31 * result + capability.hashCode()
        result = 31 * result + (treeUri?.hashCode() ?: 0)
        return result
    }
}
