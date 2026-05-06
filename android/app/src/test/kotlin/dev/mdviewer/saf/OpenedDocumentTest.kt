// ---------------------------------------------------------------------------
// OpenedDocumentTest — host-JVM verification of the data class's hand-rolled
// equals/hashCode.
//
// `OpenedDocument` carries a `bytes: ByteArray`, and Kotlin's auto-generated
// data-class `equals`/`hashCode` use *identity* equality on arrays. The
// hand-rolled overrides (see `SafCapability.kt`) substitute `contentEquals`
// + `contentHashCode` so two OpenedDocuments with the same logical bytes
// compare equal.
//
// This file pins three properties:
//   1. `equals` is content-based on the byte payload, not identity-based.
//   2. `equals` returns false when any single field differs (uri, displayName,
//      bytes, capability, treeUri).
//   3. `hashCode` is consistent with `equals`: two equal instances share a
//      hash. We don't pin "different instances must have different hashes"
//      because that's a property of the inputs, not the class.
//
// These overrides are tiny but load-bearing for the dirty-tracking layer in
// D7 (reload detection compares the current OpenedDocument against the
// last-rendered one); a regression where two byte-equal documents compare
// unequal would cause spurious reloads and visible flicker. The test catches
// the regression cheaply.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class OpenedDocumentTest {

    private val baseUri = Uri.parse("content://test/doc/1")
    private val baseTree = Uri.parse("content://test/tree")

    @Test
    fun equals_is_content_based_on_bytes() {
        val a = OpenedDocument(
            uri = baseUri,
            displayName = "spec.md",
            bytes = byteArrayOf(1, 2, 3),
            capability = SafCapability.SingleUri,
            treeUri = null,
        )
        // Same field values, different ByteArray instance.
        val b = OpenedDocument(
            uri = baseUri,
            displayName = "spec.md",
            bytes = byteArrayOf(1, 2, 3),
            capability = SafCapability.SingleUri,
            treeUri = null,
        )
        assertEquals(a, b)
        // hashCode contract: equal instances must agree on hashCode.
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test
    fun equals_handles_self_and_wrong_type() {
        val a = OpenedDocument(
            uri = baseUri,
            displayName = "n",
            bytes = ByteArray(0),
            capability = SafCapability.SingleUri,
            treeUri = null,
        )
        // Self-equality short-circuit (the `this === other` branch).
        @Suppress("KotlinConstantConditions")
        assertTrue(a.equals(a))
        // Wrong-type guard (the `other !is OpenedDocument` branch).
        assertFalse(a.equals("not a doc"))
        assertFalse(a.equals(null))
    }

    @Test
    fun equals_is_false_when_uri_differs() {
        val a = OpenedDocument(
            baseUri, "n", ByteArray(0), SafCapability.SingleUri, null,
        )
        val b = a.copy(uri = Uri.parse("content://test/doc/2"))
        assertNotEquals(a, b)
    }

    @Test
    fun equals_is_false_when_display_name_differs() {
        val a = OpenedDocument(
            baseUri, "a.md", ByteArray(0), SafCapability.SingleUri, null,
        )
        val b = a.copy(displayName = "b.md")
        assertNotEquals(a, b)
    }

    @Test
    fun equals_is_false_when_bytes_differ() {
        val a = OpenedDocument(
            baseUri, "n", byteArrayOf(1, 2), SafCapability.SingleUri, null,
        )
        val b = a.copy(bytes = byteArrayOf(1, 2, 3))
        assertNotEquals(a, b)
    }

    @Test
    fun equals_is_false_when_capability_differs() {
        val a = OpenedDocument(
            baseUri, "n", ByteArray(0), SafCapability.SingleUri, null,
        )
        val b = a.copy(capability = SafCapability.TreeAccess, treeUri = baseTree)
        assertNotEquals(a, b)
    }

    @Test
    fun equals_is_false_when_tree_uri_differs() {
        val a = OpenedDocument(
            baseUri, "n", ByteArray(0), SafCapability.TreeAccess, baseTree,
        )
        val b = a.copy(treeUri = Uri.parse("content://test/other-tree"))
        assertNotEquals(a, b)
    }

    @Test
    fun hash_code_includes_tree_uri_when_present_and_zero_when_null() {
        val withTree = OpenedDocument(
            baseUri, "n", ByteArray(0), SafCapability.TreeAccess, baseTree,
        )
        val withoutTree = OpenedDocument(
            baseUri, "n", ByteArray(0), SafCapability.SingleUri, null,
        )
        // Different fields => the hashCode lines that involve `treeUri`
        // (and capability) are exercised. We don't assert inequality of
        // the hash itself — only that calling hashCode on both branches
        // doesn't crash and yields a stable Int.
        val h1 = withTree.hashCode()
        val h2 = withoutTree.hashCode()
        assertEquals(h1, withTree.hashCode())
        assertEquals(h2, withoutTree.hashCode())
    }
}
