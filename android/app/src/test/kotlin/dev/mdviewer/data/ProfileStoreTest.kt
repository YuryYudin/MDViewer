// ---------------------------------------------------------------------------
// ProfileStoreTest — verifies first-launch defaulting + persisted profile
// round-trip for the DataStore-backed `dev.mdviewer.data.ProfileStore`.
//
// First-launch behaviour is the load-bearing one for the
// ProfileSetupAndEmptyRecentsTest e2e spec: until the user picks a
// display name + colour the store should hand out an Anonymous profile
// with a fresh UUID. Once `save(...)` has been called the on-disk
// payload wins for every subsequent `get(...)`.
// ---------------------------------------------------------------------------
package dev.mdviewer.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class ProfileStoreTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun newStore(): ProfileStore =
        ProfileStore(ctx, prefsName = "profile-test-${System.nanoTime()}")

    @Test
    fun first_get_creates_anonymous_profile() = runTest {
        val store = newStore()
        val p = store.get()
        assertTrue(p.isAnonymous, "default profile must be flagged anonymous")
        assertEquals("Anonymous", p.displayName)
        // The default colour is the first palette swatch — pinned by the
        // companion object so a refactor that reorders the palette doesn't
        // silently change first-launch identity.
        assertEquals(Profile.DEFAULT_COLOR, p.color)
    }

    @Test
    fun first_get_assigns_uuid_user_id() = runTest {
        val store = newStore()
        val p = store.get()
        // userId must be a parseable UUID — not a placeholder constant
        // like "anonymous", which would collide across devices.
        UUID.fromString(p.userId) // throws IllegalArgumentException on regression
    }

    @Test
    fun first_get_persists_so_second_get_reuses_uuid() = runTest {
        val store = newStore()
        val p1 = store.get()
        val p2 = store.get()
        // Two consecutive get() calls must hand back the SAME profile —
        // otherwise every restart would produce a fresh anonymous identity
        // and break thread authorship continuity.
        assertEquals(p1.userId, p2.userId)
    }

    @Test
    fun two_distinct_stores_get_different_uuids() = runTest {
        val a = ProfileStore(ctx, prefsName = "profile-a-${System.nanoTime()}")
        val b = ProfileStore(ctx, prefsName = "profile-b-${System.nanoTime()}")
        // Sanity-check that the UUID generator is genuinely random — if
        // the implementation returned a hardcoded placeholder both stores
        // would converge.
        assertNotEquals(a.get().userId, b.get().userId)
    }

    @Test
    fun saved_profile_round_trips() = runTest {
        val store = newStore()
        val p = Profile(
            userId = "u1-fixed",
            displayName = "Yury",
            color = "#7c3aed",
            isAnonymous = false,
        )
        store.save(p)
        assertEquals(p, store.get())
    }

    @Test
    fun saved_profile_survives_new_store_instance() = runTest {
        val name = "profile-persist-${System.nanoTime()}"
        val s1 = ProfileStore(ctx, prefsName = name)
        s1.save(Profile("u1", "Yury", "#7c3aed", isAnonymous = false))
        val s2 = ProfileStore(ctx, prefsName = name)
        val p = s2.get()
        assertEquals("Yury", p.displayName)
        assertFalse(p.isAnonymous)
    }

    @Test
    fun isInitialized_is_false_before_first_write() = runTest {
        val store = newStore()
        assertFalse(store.isInitialized())
    }

    @Test
    fun isInitialized_is_true_after_first_get_persists_default() = runTest {
        val store = newStore()
        store.get() // triggers anonymous-default save
        assertTrue(store.isInitialized())
    }

    @Test
    fun flow_emits_saved_profile() = runTest {
        val store = newStore()
        val p = Profile("u1", "Yury", "#7c3aed", isAnonymous = false)
        store.save(p)
        val emitted = store.flow.first()
        assertEquals(p, emitted)
    }

    @Test
    fun anonymous_factory_marks_isAnonymous_true() {
        val p = Profile.anonymous()
        assertTrue(p.isAnonymous)
        assertEquals("Anonymous", p.displayName)
        assertEquals(Profile.DEFAULT_COLOR, p.color)
    }
}
