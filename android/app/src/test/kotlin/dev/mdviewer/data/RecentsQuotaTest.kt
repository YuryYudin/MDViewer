// ---------------------------------------------------------------------------
// RecentsQuotaTest — locks the E5 contract for `Recents.openOrTouch`:
// when the persisted-recents list would cross [Recents.PERSISTABLE_URI_CAP],
// the *oldest* entry (lowest `lastOpenedEpochMs`) is dropped from DataStore
// AND its persistable URI grant is released via
// `ContentResolver.releasePersistableUriPermission` so the OS-side grant
// counter drops in lockstep.
//
// Why we exercise this against Robolectric's ShadowContentResolver: the
// shadow tracks `takePersistableUriPermission` / `releasePersistableUriPermission`
// in a static list that `getPersistedUriPermissions` reads back, so we
// can pre-grant a synthetic URI, call `openOrTouch`, and assert the
// post-conditions on the *real* `cr.persistedUriPermissions` list — no
// mocking of the resolver itself. Mirrors the pattern used by
// `DocumentRepositoryTest`.
//
// We deliberately use a small in-memory cap (overridden via the test-only
// `persistableUriCap` parameter) so we don't have to fabricate 480
// entries to trip the eviction path. The constant `PERSISTABLE_URI_CAP`
// is pinned separately by `RecentsTest.persistable_uri_cap_constant_is_480`.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class RecentsQuotaTest {

    private val ctx = ApplicationProvider.getApplicationContext<Context>()

    private fun newStore(persistableUriCap: Int = 3): Recents =
        Recents(
            ctx = ctx,
            prefsName = "recents-quota-${System.nanoTime()}",
            // The in-memory cap (`maxEntries`) is set high enough that it
            // never fires in these tests; the `persistableUriCap` is the
            // load-bearing knob for the eviction-on-grant-cap path.
            maxEntries = 1000,
            persistableUriCap = persistableUriCap,
        )

    /** Take a read+write persistable grant on a synthetic URI. */
    private fun grant(uri: Uri) {
        ctx.contentResolver.takePersistableUriPermission(
            uri,
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
        )
    }

    @Test
    fun openOrTouch_below_cap_does_not_evict_or_release_grants() = runTest {
        val r = newStore(persistableUriCap = 5)
        val u1 = Uri.parse("content://test/u1")
        val u2 = Uri.parse("content://test/u2")
        grant(u1)
        grant(u2)

        r.openOrTouch(u1.toString(), "u1.md", SafTier.SingleUri)
        r.openOrTouch(u2.toString(), "u2.md", SafTier.SingleUri)

        // No eviction should have happened yet — both grants should still
        // be in the persisted-permission list.
        val persisted = ctx.contentResolver.persistedUriPermissions
            .map { it.uri.toString() }.toSet()
        assertTrue(u1.toString() in persisted, "u1 grant should still be held")
        assertTrue(u2.toString() in persisted, "u2 grant should still be held")
        assertEquals(2, r.list().size)
    }

    @Test
    fun openOrTouch_evicts_oldest_when_crossing_cap() = runTest {
        // Cap of 3 → the 4th distinct openOrTouch must evict the oldest.
        val r = newStore(persistableUriCap = 3)
        val uris = (1..4).map { Uri.parse("content://test/u$it") }
        uris.forEach { grant(it) }

        // Seed three entries with strictly-increasing timestamps so the
        // first one is unambiguously the "oldest".
        for ((i, u) in uris.take(3).withIndex()) {
            r.openOrTouch(u.toString(), "u${i + 1}.md", SafTier.SingleUri)
            // `Recents.openOrTouch` stamps `lastOpenedEpochMs` from
            // `System.currentTimeMillis()` internally; nudging the wall
            // clock by sleeping a millisecond between calls would be
            // flaky on fast hardware. Instead we rely on the production
            // contract: ties break in insertion order (newest-first list
            // built via `listOf(new) + without`), which preserves the
            // same eviction semantics the production path follows when
            // two opens race within the same millisecond.
        }
        assertEquals(3, r.list().size)

        // 4th open crosses the cap → oldest (u1) must be evicted from
        // both the DataStore list and the persistable-permissions list.
        r.openOrTouch(uris[3].toString(), "u4.md", SafTier.SingleUri)

        val list = r.list()
        assertEquals(3, list.size, "list must remain at the cap, not grow")
        assertFalse(
            list.any { it.uri == uris[0].toString() },
            "oldest entry (u1) should have been evicted",
        )
        assertTrue(
            list.any { it.uri == uris[3].toString() },
            "newest entry (u4) should be present",
        )

        // Released grant is no longer in the OS persisted-permissions list.
        val persisted = ctx.contentResolver.persistedUriPermissions
            .map { it.uri.toString() }.toSet()
        assertFalse(
            uris[0].toString() in persisted,
            "released URI should no longer be in persistedUriPermissions",
        )
        assertTrue(
            uris[3].toString() in persisted,
            "newest URI's grant should still be held",
        )
    }

    @Test
    fun openOrTouch_existing_uri_does_not_grow_count_or_release_grant() = runTest {
        val r = newStore(persistableUriCap = 3)
        val u1 = Uri.parse("content://test/u1")
        val u2 = Uri.parse("content://test/u2")
        grant(u1)
        grant(u2)

        r.openOrTouch(u1.toString(), "u1.md", SafTier.SingleUri)
        r.openOrTouch(u2.toString(), "u2.md", SafTier.SingleUri)
        // Re-touching an existing URI must dedupe-promote, not append.
        r.openOrTouch(u1.toString(), "u1.md", SafTier.SingleUri)

        assertEquals(2, r.list().size)
        // Both grants survive because nothing crossed the cap.
        val persisted = ctx.contentResolver.persistedUriPermissions
            .map { it.uri.toString() }.toSet()
        assertTrue(u1.toString() in persisted)
        assertTrue(u2.toString() in persisted)
    }

    @Test
    fun openOrTouch_release_swallows_security_exception() = runTest {
        // Eviction targets a URI for which we never took a persistable
        // grant. `releasePersistableUriPermission` raises SecurityException
        // in that case (the OS protects against double-release); the
        // production code swallows it because the row eviction is the
        // load-bearing outcome and the grant was already absent. We pin
        // that swallow here so a future refactor doesn't tighten the
        // catch-block and crash on a benign mismatch.
        val r = newStore(persistableUriCap = 2)
        // No `grant()` calls — every URI here is "ungranted".
        r.openOrTouch("content://test/a", "a.md", SafTier.SingleUri)
        r.openOrTouch("content://test/b", "b.md", SafTier.SingleUri)
        // Crossing the cap must not throw even though the evicted entry
        // has no underlying persistable grant.
        r.openOrTouch("content://test/c", "c.md", SafTier.SingleUri)

        assertEquals(2, r.list().size)
    }
}
