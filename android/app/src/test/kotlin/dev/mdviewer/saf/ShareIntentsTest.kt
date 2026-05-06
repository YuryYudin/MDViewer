// ---------------------------------------------------------------------------
// ShareIntentsTest — host-JVM verification of [ShareIntents] inbound
// extraction + outbound construction.
//
// E3 wires ACTION_SEND into [IntentDispatcher] and the share-back
// affordance from the document screen. Two halves to cover here:
//
//   1. **Inbound** — `extractDocumentUri(intent)` returns the document
//      URI when the intent carries `EXTRA_STREAM`, or null otherwise.
//      We pin the EXTRA_TEXT-only path to null because plain text
//      shares aren't supported in v1 (see e3.md "Avoid").
//
//   2. **Outbound** — `buildOutbound(uri, displayName)` produces an
//      ACTION_SEND intent with the right MIME, EXTRA_STREAM, EXTRA_TITLE,
//      and the read-grant flag. The flag is load-bearing: without it,
//      the receiver app cannot read the URI on Android 7+.
//
// Robolectric runs under @Config(sdk = [33]) for parity with the rest
// of the saf package's host-JVM tests; default-values mode (set in
// app/build.gradle.kts) makes Intent + Uri stubs return zeroes instead
// of throwing, so the resolver-style assertions don't trip on
// secondary framework calls we don't actually care about.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class ShareIntentsTest {

    @Test
    fun action_send_with_extra_stream_returns_uri() {
        val uri = Uri.parse("content://x/y.md")
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/markdown"
            putExtra(Intent.EXTRA_STREAM, uri)
        }
        assertEquals(uri, ShareIntents.extractDocumentUri(intent))
    }

    @Test
    fun action_send_text_only_returns_null() {
        // Plain text shares (Gmail "share text" path) are out of scope:
        // the v1 contract is "stream-mode .md URI only". A null return
        // lets the dispatcher fall through to the default route.
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "some inline text")
        }
        assertNull(ShareIntents.extractDocumentUri(intent))
    }

    @Test
    fun non_send_intent_returns_null() {
        // Defensive: passing an ACTION_VIEW intent in here (a refactor
        // that loses the action check) would silently hand the dispatcher
        // a Document destination via the wrong code path. The function
        // should ignore non-SEND intents.
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("content://x/y"))
        assertNull(ShareIntents.extractDocumentUri(intent))
    }

    @Test
    fun action_send_without_any_extras_returns_null() {
        val intent = Intent(Intent.ACTION_SEND)
        assertNull(ShareIntents.extractDocumentUri(intent))
    }

    @Test
    fun build_outbound_carries_uri_and_read_flag() {
        val uri = Uri.parse("content://provider/doc/abc")
        val intent = ShareIntents.buildOutbound(uri, displayName = "spec.md")

        assertEquals(Intent.ACTION_SEND, intent.action)
        assertEquals("text/markdown", intent.type)
        assertEquals(uri, intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        // EXTRA_TITLE is what the system chooser surfaces above the
        // target list — without it, the chooser falls back to the
        // generic "Share" header.
        assertEquals("spec.md", intent.getStringExtra(Intent.EXTRA_TITLE))
        // FLAG_GRANT_READ_URI_PERMISSION is required for Android 7+ to
        // pass the URI grant to the receiver. Missing flag = receiver
        // sees a SecurityException on openInputStream.
        assertTrue(
            intent.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0,
            "outbound share intent must carry FLAG_GRANT_READ_URI_PERMISSION",
        )
    }

    @Test
    fun build_outbound_is_independent_of_input_intent() {
        // Sanity: each call returns a fresh Intent. A shared mutable
        // intent would let the caller accidentally mutate the chooser
        // payload between invocations.
        val a = ShareIntents.buildOutbound(Uri.parse("content://x/a"), "a.md")
        val b = ShareIntents.buildOutbound(Uri.parse("content://x/b"), "b.md")
        assertNotNull(a)
        assertNotNull(b)
        assertTrue(a !== b, "buildOutbound must return a fresh Intent each call")
        assertEquals(Uri.parse("content://x/a"), a.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
        assertEquals(Uri.parse("content://x/b"), b.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
    }
}
