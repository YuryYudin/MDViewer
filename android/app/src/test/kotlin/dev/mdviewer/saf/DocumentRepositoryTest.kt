// ---------------------------------------------------------------------------
// DocumentRepositoryTest — host-JVM verification of the SAF doc loader.
//
// The repository is the single hand-off between framework-issued document
// URIs (ACTION_VIEW from Drive, ACTION_OPEN_DOCUMENT from the in-app picker,
// reload-from-recents) and the rest of the app. Two concerns under test:
//
//   1. open(uri) must read the document bytes via ContentResolver, take a
//      persistable read grant when the provider allows it, and surface a
//      friendly display name. Robolectric's ShadowContentResolver lets us
//      register a fake InputStream against a content:// URI so the read
//      path runs without a real provider.
//
//   2. open(uri) must classify the URI into one of two SafCapability
//      tiers. TreeAccess means the user previously granted folder access
//      whose tree-document-id is a prefix of this doc's id (so the C5
//      sidecar writer can use DocumentFile.fromTreeUri without
//      re-prompting). SingleUri means we only have read access to this
//      one document. The classifier scans
//      ContentResolver.persistedUriPermissions, which Robolectric backs
//      with a static list populated by calling takePersistableUriPermission
//      against the same resolver.
//
// We deliberately exercise four cases: TreeAccess, SingleUri, IOException
// on read, and a transient URI that rejects takePersistableUriPermission
// (the share-intent flow in E3 needs that path). The "transient URI"
// path is exercised implicitly by every test here because Robolectric
// emits a SecurityException from takePersistableUriPermission for any
// URI that wasn't first granted by the framework — the repository
// catches it and continues.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows
import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull

@RunWith(AndroidJUnit4::class)
class DocumentRepositoryTest {
    private lateinit var ctx: Context
    private lateinit var repo: DocumentRepository
    private lateinit var cr: ContentResolver

    @Before
    fun setup() {
        ctx = ApplicationProvider.getApplicationContext()
        repo = DocumentRepository(ctx)
        cr = ctx.contentResolver
    }

    @Test
    fun open_reads_bytes_from_content_provider() = runTest {
        val uri = Uri.parse("content://com.test.docs/document/folder%2Ffile.md")
        Shadows.shadowOf(cr).registerInputStream(uri, "# Hi".byteInputStream())

        val opened = repo.open(uri)

        assertEquals("# Hi", String(opened.bytes))
        assertEquals(uri, opened.uri)
    }

    @Test
    fun capability_is_single_uri_when_no_tree_grant_present() = runTest {
        val uri = Uri.parse("content://com.test.docs/document/folder%2Ffile.md")
        Shadows.shadowOf(cr).registerInputStream(uri, "x".byteInputStream())

        val opened = repo.open(uri)

        assertEquals(SafCapability.SingleUri, opened.capability)
        assertNull(opened.treeUri)
    }

    @Test
    fun capability_is_tree_access_when_enclosing_tree_grant_present() = runTest {
        // Pre-grant a tree URI whose document id ("folder") is the parent
        // of the document URI's id ("folder/file.md"). Robolectric's
        // ShadowContentResolver tracks takePersistableUriPermission calls
        // in a static list that getPersistedUriPermissions reads back, so
        // this primes the classifier without needing a real provider.
        val treeUri = Uri.parse("content://com.test.docs/tree/folder")
        cr.takePersistableUriPermission(treeUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)

        val docUri = Uri.parse("content://com.test.docs/tree/folder/document/folder%2Ffile.md")
        Shadows.shadowOf(cr).registerInputStream(docUri, "x".byteInputStream())

        val opened = repo.open(docUri)

        assertEquals(SafCapability.TreeAccess, opened.capability)
        assertNotNull(opened.treeUri)
        assertEquals(treeUri, opened.treeUri)
    }

    @Test
    fun open_propagates_io_exception_when_provider_read_fails() = runTest {
        val uri = Uri.parse("content://com.test.docs/document/missing.md")
        // Register a stream that throws on first read — emulates a Drive
        // sync failure / network drop mid-read.
        val failing = object : java.io.InputStream() {
            override fun read(): Int = throw IOException("boom")
        }
        Shadows.shadowOf(cr).registerInputStream(uri, failing)

        assertFailsWith<IOException> {
            repo.open(uri)
        }
    }

    @Test
    fun open_throws_when_uri_is_not_resolvable() = runTest {
        // No InputStream registered; openInputStream returns null which
        // the repository surfaces as a FileNotFoundException-equivalent.
        // We expect *some* exception (the actual type depends on the
        // shadow's null-handling) — the load-bearing assertion is that
        // we don't silently swallow a missing document.
        val uri = Uri.parse("content://com.test.docs/document/never-registered.md")

        var threw = false
        try {
            repo.open(uri)
        } catch (_: Exception) {
            threw = true
        }
        assertEquals(true, threw)
    }

    @Test
    fun reload_re_reads_bytes_for_same_uri() = runTest {
        val uri = Uri.parse("content://com.test.docs/document/r1.md")
        Shadows.shadowOf(cr).registerInputStream(uri, "first".byteInputStream())

        val first = repo.open(uri)
        assertEquals("first", String(first.bytes))

        // Re-register with new bytes; reload() must pick them up.
        Shadows.shadowOf(cr).registerInputStream(uri, "second".byteInputStream())
        val second = repo.reload(uri)
        assertEquals("second", String(second.bytes))
    }
}
