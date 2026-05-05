// ---------------------------------------------------------------------------
// RecentsTest — host-JVM verification of the DataStore-backed Recents store.
//
// The store keeps the most-recent-first list of opened markdown documents
// with their SAF tier (TreeAccess vs SingleUri). Round-trip and ordering
// invariants are the load-bearing surface for the Phase C UI flows that
// drive ReopenFromRecentsTest, so we cover them as unit tests against a
// real DataStore-Preferences file under Robolectric.
//
// Why Robolectric: DataStore-Preferences requires a real Context to wire
// its file-backed storage. The :app module already pulled Robolectric in
// for the smoke test; reusing it here keeps the test surface consistent.
//
// Why per-test prefs name: each Recents instance writes to a single
// preferences file rooted at the Application's filesDir. Sharing a name
// across @Test methods would let earlier writes leak into later ones,
// hiding ordering bugs. We thread a unique nano-time-suffixed name
// through the constructor so each test gets its own file.
// ---------------------------------------------------------------------------
package dev.mdviewer.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class RecentsTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun newStore(maxEntries: Int = 50): Recents =
        Recents(
            ctx = ctx,
            prefsName = "recents-test-${System.nanoTime()}",
            maxEntries = maxEntries,
        )

    @Test
    fun empty_store_returns_empty_list() = runTest {
        val r = newStore()
        assertEquals(emptyList(), r.list())
    }

    @Test
    fun add_then_list_round_trips() = runTest {
        val r = newStore()
        r.recordOpen("content://uri/A", "doc-a.md", SafTier.SingleUri)
        r.recordOpen("content://uri/B", "doc-b.md", SafTier.TreeAccess)
        val list = r.list()
        assertEquals(2, list.size)
        // Most-recent-first ordering: B was added second so it leads.
        assertEquals("content://uri/B", list[0].uri)
        assertEquals("doc-b.md", list[0].displayName)
        assertEquals(SafTier.TreeAccess, list[0].safTier)
        assertEquals("content://uri/A", list[1].uri)
        assertEquals(SafTier.SingleUri, list[1].safTier)
    }

    @Test
    fun touch_existing_moves_to_top_without_duplicating() = runTest {
        val r = newStore()
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        r.recordOpen("u2", "d2", SafTier.SingleUri)
        r.recordOpen("u1", "d1-renamed", SafTier.TreeAccess) // re-open w/ updated metadata
        val list = r.list()
        assertEquals(2, list.size)
        assertEquals("u1", list[0].uri)
        // The latest recordOpen wins for displayName + safTier — re-opens
        // act as both an LRU touch and a metadata refresh.
        assertEquals("d1-renamed", list[0].displayName)
        assertEquals(SafTier.TreeAccess, list[0].safTier)
    }

    @Test
    fun timestamp_is_monotonic_or_increasing_across_recordOpen() = runTest {
        val r = newStore()
        val before = System.currentTimeMillis()
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        val after = System.currentTimeMillis()
        val entry = r.list().first()
        // recordOpen should stamp lastOpenedEpochMs from the call site —
        // assert it's within the bracketing wall-clock window so we can
        // detect a regression where the field is left at zero.
        assertTrue(entry.lastOpenedEpochMs in before..after,
            "expected stamp in [$before, $after], saw ${entry.lastOpenedEpochMs}")
    }

    @Test
    fun cap_evicts_oldest_when_exceeded() = runTest {
        val r = newStore(maxEntries = 3)
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        r.recordOpen("u2", "d2", SafTier.SingleUri)
        r.recordOpen("u3", "d3", SafTier.SingleUri)
        r.recordOpen("u4", "d4", SafTier.SingleUri) // pushes u1 out
        val uris = r.list().map { it.uri }
        assertEquals(listOf("u4", "u3", "u2"), uris)
    }

    @Test
    fun default_cap_is_50() = runTest {
        val r = newStore() // default maxEntries
        repeat(60) { i -> r.recordOpen("u$i", "d$i", SafTier.SingleUri) }
        val list = r.list()
        assertEquals(50, list.size)
        // The 10 oldest (u0..u9) should have been evicted; u59 leads.
        assertEquals("u59", list.first().uri)
        assertEquals("u10", list.last().uri)
    }

    @Test
    fun remove_drops_matching_uri() = runTest {
        val r = newStore()
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        r.recordOpen("u2", "d2", SafTier.TreeAccess)
        r.remove("u1")
        val list = r.list()
        assertEquals(1, list.size)
        assertEquals("u2", list.first().uri)
    }

    @Test
    fun remove_unknown_uri_is_noop() = runTest {
        val r = newStore()
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        r.remove("u-does-not-exist")
        assertEquals(listOf("u1"), r.list().map { it.uri })
    }

    @Test
    fun flow_emits_current_list() = runTest {
        val r = newStore()
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        r.recordOpen("u2", "d2", SafTier.TreeAccess)
        val emitted = r.flow.first()
        assertEquals(2, emitted.size)
        assertEquals("u2", emitted.first().uri)
    }

    @Test
    fun persistable_uri_cap_constant_is_480() {
        // The 480 cap is enforced in C5/E5; here we just pin the constant
        // so a refactor that re-tunes it shows up as a deliberate test
        // change. 480 leaves 20 of headroom under Android's ~500 limit.
        assertEquals(480, Recents.PERSISTABLE_URI_CAP)
    }

    @Test
    fun persisted_state_survives_new_store_instance() = runTest {
        val name = "recents-persist-${System.nanoTime()}"
        val r1 = Recents(ctx, prefsName = name)
        r1.recordOpen("u1", "d1", SafTier.SingleUri)
        // A second Recents instance pointed at the same prefs file should
        // observe the prior write — this is what proves the on-disk
        // serialization round-trips, separate from the in-memory dedupe
        // logic that other tests exercise.
        val r2 = Recents(ctx, prefsName = name)
        val list = r2.list()
        assertEquals(1, list.size)
        assertEquals("u1", list.first().uri)
    }

    @Test
    fun get_returns_entry_by_uri() = runTest {
        val r = newStore()
        r.recordOpen("u1", "d1", SafTier.SingleUri)
        r.recordOpen("u2", "d2", SafTier.TreeAccess)
        val hit = r.get("u2")
        assertEquals("d2", hit?.displayName)
        assertEquals(SafTier.TreeAccess, hit?.safTier)
        assertNull(r.get("missing"))
    }
}
