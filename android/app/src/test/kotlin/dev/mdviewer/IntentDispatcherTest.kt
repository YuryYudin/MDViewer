// ---------------------------------------------------------------------------
// IntentDispatcherTest — host-JVM unit coverage for [IntentDispatcher.resolve].
//
// Runs under Robolectric so `android.content.Intent` and `android.net.Uri`
// resolve against the framework stubs (default-values mode in
// `app/build.gradle.kts` makes the unused parts of those classes return
// zeroes instead of throwing). The instrumented twin
// (`IntentDispatcherInstrumentedTest`) covers the activity-launch path on a
// real device — this test fixes the resolver's contract on every commit
// without an emulator hop.
//
// Coverage matrix:
//   1. null intent + no profile           -> ProfileSetup
//   2. null intent + profile present      -> Recents
//   3. ACTION_VIEW + content:// URI       -> Document(uri)
//   4. ACTION_VIEW + no data              -> Recents (defensive fall-through)
//   5. ACTION_MAIN                        -> Recents
//   6. unknown action                     -> Recents (default + profile)
//
// Each row is an independent contract; folding them into one parametrized
// test would obscure which assumption regressed when the suite goes red.
// ---------------------------------------------------------------------------
package dev.mdviewer

import android.content.Intent
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals

@RunWith(AndroidJUnit4::class)
class IntentDispatcherTest {

    @Test
    fun null_intent_no_profile_routes_to_setup() {
        assertEquals(
            NavDestination.ProfileSetup,
            IntentDispatcher.resolve(null, hasProfile = false),
        )
    }

    @Test
    fun null_intent_with_profile_routes_to_recents() {
        assertEquals(
            NavDestination.Recents,
            IntentDispatcher.resolve(null, hasProfile = true),
        )
    }

    @Test
    fun action_view_with_content_uri_returns_document() {
        val uri = Uri.parse("content://provider/path/file.md")
        val intent = Intent(Intent.ACTION_VIEW, uri)
        assertEquals(
            NavDestination.Document(uri),
            IntentDispatcher.resolve(intent, hasProfile = true),
        )
    }

    @Test
    fun action_view_with_no_data_falls_through_to_default_with_profile() {
        // ACTION_VIEW with a null data URI should NOT crash and should NOT
        // be treated as a Document open — fall through to the default for
        // the profile state. A malicious app sending an empty ACTION_VIEW
        // would otherwise drop the user on a Document screen with no source.
        val intent = Intent(Intent.ACTION_VIEW)
        assertEquals(
            NavDestination.Recents,
            IntentDispatcher.resolve(intent, hasProfile = true),
        )
    }

    @Test
    fun action_view_with_no_data_falls_through_to_setup_when_no_profile() {
        val intent = Intent(Intent.ACTION_VIEW)
        assertEquals(
            NavDestination.ProfileSetup,
            IntentDispatcher.resolve(intent, hasProfile = false),
        )
    }

    @Test
    fun action_main_routes_to_default_start() {
        val intent = Intent(Intent.ACTION_MAIN)
        assertEquals(
            NavDestination.Recents,
            IntentDispatcher.resolve(intent, hasProfile = true),
        )
    }

    @Test
    fun unknown_action_routes_to_default_start() {
        // Any unhandled action falls through to the default — Recents or
        // ProfileSetup based on hasProfile.
        val intent = Intent("dev.mdviewer.test.UNKNOWN_ACTION")
        assertEquals(
            NavDestination.Recents,
            IntentDispatcher.resolve(intent, hasProfile = true),
        )
        assertEquals(
            NavDestination.ProfileSetup,
            IntentDispatcher.resolve(intent, hasProfile = false),
        )
    }

    @Test
    fun action_send_with_extra_stream_routes_to_document() {
        // E3 wires ACTION_SEND through ShareIntents.extractDocumentUri.
        // A SEND intent carrying an EXTRA_STREAM URI for a markdown file
        // must land on Document(uri) the same way ACTION_VIEW does.
        val uri = Uri.parse("content://provider/document/shared.md")
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/markdown"
            putExtra(Intent.EXTRA_STREAM, uri)
        }
        assertEquals(
            NavDestination.Document(uri),
            IntentDispatcher.resolve(intent, hasProfile = true),
        )
    }

    @Test
    fun action_send_text_only_falls_through_to_default() {
        // EXTRA_TEXT-only shares are out of scope in v1 — fall through
        // to the cold-start default rather than land on a doc-less
        // Document destination.
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "inline text")
        }
        assertEquals(
            NavDestination.Recents,
            IntentDispatcher.resolve(intent, hasProfile = true),
        )
        assertEquals(
            NavDestination.ProfileSetup,
            IntentDispatcher.resolve(intent, hasProfile = false),
        )
    }

    @Test
    fun document_destination_holds_original_uri() {
        // Uri equality is identity-by-string; assert the round-tripped
        // value matches the input so the navigation layer can encode it
        // without surprises.
        val uri = Uri.parse("content://com.google.android.apps.docs.storage/document/abc123")
        val intent = Intent(Intent.ACTION_VIEW, uri)
        val dest = IntentDispatcher.resolve(intent, hasProfile = true)
        assertEquals(NavDestination.Document(uri), dest)
        assertEquals(uri, (dest as NavDestination.Document).uri)
    }
}
