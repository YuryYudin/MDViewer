// ---------------------------------------------------------------------------
// SidecarMirror — app-private, single-URI tier of the two-tier sidecar IO.
//
// When DocumentRepository classifies an opened document as
// SafCapability.SingleUri, the user has not granted parent-folder access
// and we cannot write a sibling JSON next to the source. SidecarMirror is
// the fallback: the comments JSON for that document lives under
// `filesDir/sidecars/<sha256(docUri)>.comments.json` so threads survive
// process restarts and uninstall removes the file with the rest of the
// app's data.
//
// Filename hashing — SHA-256 hex over the URI string — earns its keep on
// three separate axes:
//
//   1. **Filesystem safety.** Document URIs (`content://com.foo/document/
//      tree%2Fa%252Fb`) contain colons, slashes, and percent-encoded
//      reserved chars that aren't legal on every fileystem the OS might
//      stage data on. A hex hash sidesteps the entire encoding question.
//
//   2. **Determinism across launches.** `Uri.toString().hashCode()` is
//      *not* contractually stable across JVM/Android process boundaries;
//      Android documents the contract for `String.hashCode()` but not for
//      `Uri.hashCode()`, and even the former is technically permitted to
//      change between major Java releases. SHA-256 is fixed forever.
//
//   3. **Fixed-length filenames.** Some FAT-derived storage layers
//      (legacy SD-card-via-MTP setups still seen in the wild) cap path
//      components at 255 bytes; hashing keeps every mirror name well
//      under that.
//
// What's deliberately NOT here:
//   * **No automatic mirror cleanup on capability promotion.** When the
//     user later grants tree access for a doc that already has a mirror,
//     E3's `SaveSidecarToSource` orchestrates: read mirror -> write tree
//     sibling -> delete mirror. Doing it implicitly here would risk
//     losing user data if the tree-sibling write failed mid-transaction.
//   * **No locking.** Single-app, sub-millisecond writes; concurrent
//     access from two coroutines on the same doc URI would race the same
//     way two coroutines writing the same plain file would. The
//     ViewModel layer serializes save calls per doc.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.Context
import android.net.Uri
import java.io.File
import java.security.MessageDigest

class SidecarMirror(ctx: Context) {

    // Application context only — SidecarMirror outlives any single Activity
    // through its DI singleton in the C5 ViewModel layer; capturing an
    // Activity context would leak.
    private val appCtx: Context = ctx.applicationContext

    // Lazy because tests construct SidecarMirror in @Before with a
    // Robolectric Application context that hasn't fully initialized
    // filesDir yet on some emulator targets. Touching `filesDir` once the
    // first lookup happens — by then the Application is live.
    private val dir: File by lazy {
        File(appCtx.filesDir, DIR_NAME).also { it.mkdirs() }
    }

    /**
     * Returns the (possibly nonexistent) mirror file for [docUri].
     *
     * Pure mapping function — no IO performed. Callers use this for both
     * the `exists()` check before [load] and the post-[save] verification
     * in tests.
     */
    fun fileFor(docUri: Uri): File = File(dir, "${sha256Hex(docUri.toString())}$EXTENSION")

    /**
     * Reads the mirror bytes for [docUri], or returns an empty array when
     * no mirror exists. The empty path is a normal first-open-of-fresh-doc
     * outcome — the core's `load_sidecar_bytes(empty)` accepts it as "no
     * sidecar yet" and returns an empty store, so the caller does not
     * need to distinguish missing from empty.
     */
    fun load(docUri: Uri): ByteArray {
        val f = fileFor(docUri)
        return if (f.exists()) f.readBytes() else ByteArray(0)
    }

    /**
     * Writes [bytes] as the sidecar mirror for [docUri], creating the
     * `filesDir/sidecars/` directory if necessary. Overwrites any prior
     * mirror at the same hash atomically (File.writeBytes truncates +
     * writes on POSIX, which is good enough for the per-doc serialization
     * contract; we don't need the rename-trick here because there is no
     * concurrent reader).
     */
    fun save(docUri: Uri, bytes: ByteArray) {
        fileFor(docUri).writeBytes(bytes)
    }

    /**
     * Removes the mirror for [docUri]. No-op when absent. Used by E3's
     * SaveSidecarToSource after a successful promotion to tree access.
     */
    fun delete(docUri: Uri) {
        fileFor(docUri).delete()
    }

    private fun sha256Hex(s: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        // Manual hex loop — `joinToString { "%02x".format(...) }` works
        // but allocates a per-byte format-string parse on every call;
        // mirror.fileFor is hot during open, so we avoid the formatter
        // overhead.
        val sb = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xff
            sb.append(HEX[v ushr 4])
            sb.append(HEX[v and 0x0f])
        }
        return sb.toString()
    }

    private companion object {
        private const val DIR_NAME = "sidecars"
        private const val EXTENSION = ".comments.json"
        private val HEX = "0123456789abcdef".toCharArray()
    }
}
