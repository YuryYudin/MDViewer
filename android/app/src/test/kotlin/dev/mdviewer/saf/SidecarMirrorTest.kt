// ---------------------------------------------------------------------------
// SidecarMirrorTest — host-JVM verification of the app-private mirror tier
// of the two-tier sidecar IO described in the design doc.
//
// When the user opened the document via a single-URI grant (e.g. the
// document came in through ACTION_VIEW from a sender that didn't grant
// folder access, or through ACTION_SEND), we cannot write a sibling file
// next to the source. Instead we mirror the comments JSON into our app's
// internal storage (`filesDir/sidecars/<sha256(docUri)>.comments.json`)
// so threads still survive a process restart. E3's SaveSidecarToSource
// later promotes the mirror back to a sibling once the user grants tree
// access — but that promotion is out of scope here.
//
// The two invariants this test pins are:
//
//   1. **Determinism.** The same doc URI must always hash to the same
//      mirror file path; otherwise re-opening the doc in a fresh process
//      would orphan the prior sidecar. SHA-256 over the URI string is
//      stable across launches and platform-independent — that's why we
//      hash explicitly rather than using `Uri.toString().hashCode()`,
//      which is not contractually stable on the JVM.
//
//   2. **Sandboxing.** The mirror lives under `filesDir/sidecars/` so it
//      participates in app-data backup/restore and is removed on
//      uninstall. We assert the parent dir name to catch any accidental
//      drift to e.g. `cacheDir` (which the OS can wipe at any time and
//      would silently lose user data).
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class SidecarMirrorTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun mirror_path_is_deterministic_per_uri() {
        val mirror = SidecarMirror(ctx)
        val a1 = mirror.fileFor(Uri.parse("content://x/doc1"))
        val a2 = mirror.fileFor(Uri.parse("content://x/doc1"))
        assertEquals(a1.absolutePath, a2.absolutePath)
    }

    @Test
    fun different_uris_hash_to_different_files() {
        val mirror = SidecarMirror(ctx)
        val a = mirror.fileFor(Uri.parse("content://x/doc-a"))
        val b = mirror.fileFor(Uri.parse("content://x/doc-b"))
        assertTrue(a.absolutePath != b.absolutePath)
    }

    @Test
    fun save_creates_file_under_files_dir_sidecars() = runTest {
        val mirror = SidecarMirror(ctx)
        val uri = Uri.parse("content://x/doc-mirror")
        mirror.save(uri, byteArrayOf(1, 2, 3))
        val f = mirror.fileFor(uri)
        assertTrue(f.exists(), "expected mirror file to exist at ${f.absolutePath}")
        assertEquals("sidecars", f.parentFile?.name)
        // Mirror lives under filesDir (not cacheDir) — guards against an
        // accidental swap that would let the OS wipe user data.
        val filesDirPath = ctx.filesDir.absolutePath
        assertTrue(
            f.absolutePath.startsWith(filesDirPath),
            "expected mirror under $filesDirPath but was ${f.absolutePath}",
        )
    }

    @Test
    fun load_returns_empty_when_mirror_absent() {
        val mirror = SidecarMirror(ctx)
        val uri = Uri.parse("content://x/never-saved")
        val bytes = mirror.load(uri)
        assertEquals(0, bytes.size)
    }

    @Test
    fun load_round_trips_saved_bytes() = runTest {
        val mirror = SidecarMirror(ctx)
        val uri = Uri.parse("content://x/doc-rt")
        val payload = byteArrayOf(7, 8, 9, 10)
        mirror.save(uri, payload)
        val readback = mirror.load(uri)
        assertEquals(payload.toList(), readback.toList())
    }

    @Test
    fun delete_removes_mirror_file() = runTest {
        val mirror = SidecarMirror(ctx)
        val uri = Uri.parse("content://x/doc-del")
        mirror.save(uri, byteArrayOf(1))
        assertTrue(mirror.fileFor(uri).exists())
        mirror.delete(uri)
        assertTrue(!mirror.fileFor(uri).exists())
    }

    @Test
    fun mirror_filename_uses_sha256_hex_extension() {
        val mirror = SidecarMirror(ctx)
        val f = mirror.fileFor(Uri.parse("content://x/whatever"))
        // 64 hex chars from SHA-256 + ".comments.json" suffix.
        val name = f.name
        assertTrue(
            name.endsWith(".comments.json"),
            "expected .comments.json suffix, got $name",
        )
        val hash = name.removeSuffix(".comments.json")
        assertEquals(64, hash.length, "expected 64-char sha256 hex, got '$hash'")
        assertTrue(
            hash.all { it in '0'..'9' || it in 'a'..'f' },
            "expected lowercase hex, got '$hash'",
        )
    }
}
