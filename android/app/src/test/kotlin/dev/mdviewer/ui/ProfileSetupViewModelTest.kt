// ---------------------------------------------------------------------------
// ProfileSetupViewModelTest — host-JVM verification of the E1 profile-setup
// state machine. The ViewModel drives the [ProfileSetupScreen] composable
// (wireframes/02-profile-setup.html) through three actions: edit display
// name, pick a swatch, save+continue OR skip.
//
// What we lock in:
//   1. `canContinue` is initially false (no name, no color), flips to true
//      ONLY when both fields are non-blank / non-null. The Continue button's
//      enabled bit is bound to this flag so a future restyle can't turn the
//      button on with a half-filled form.
//   2. `saveAndContinue` writes a non-anonymous Profile carrying the typed
//      name and the picked color, then fires the onDone callback exactly
//      once. The persisted user_id is a non-blank UUID — the spec is
//      explicit that the id is NOT derived from the display name.
//   3. `skip` writes an Anonymous profile (Profile.anonymous() shape:
//      isAnonymous=true, displayName="Anonymous", color=DEFAULT_COLOR), then
//      fires onDone exactly once. The router downstream sees
//      `isInitialized() == true` so the user lands on Recents on next
//      cold start rather than being shown the setup again.
//   4. `saveAndContinue` with a missing color is a no-op — the UI disables
//      the button, but the ViewModel must still refuse to write a partial
//      profile in case a future call site bypasses the disabled state.
//
// Why Robolectric @Config(sdk = [33]): the ViewModel uses viewModelScope
// (Android `ViewModel`); Robolectric stubs `Looper.getMainLooper()` so
// `runTest` + `Dispatchers.setMain` can drive the launch coroutines on
// the host JVM. Same wiring as ThreadSheetViewModelTest /
// RecentsViewModelTest.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ProfileSetupViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(testDispatcher) }
    @After fun tearDown() { Dispatchers.resetMain() }

    // ---------------------------------------------------------------------
    // canContinue gate
    // ---------------------------------------------------------------------

    @Test
    fun can_continue_starts_false_then_flips_only_when_both_fields_set() = runTest {
        val store = RecordingProfileStore()
        val vm = ProfileSetupViewModel(store)

        // Initial: no name, no color.
        advanceUntilIdle()
        assertFalse(vm.canContinue.first(), "fresh form must not enable Continue")

        // Name only — still disabled.
        vm.setDisplayName("Reviewer")
        advanceUntilIdle()
        assertFalse(vm.canContinue.first(), "name without color must not enable Continue")

        // Color only — still disabled.
        vm.setDisplayName("")
        vm.setColor("#7C3AED")
        advanceUntilIdle()
        assertFalse(vm.canContinue.first(), "color without name must not enable Continue")

        // Both set — enabled.
        vm.setDisplayName("Reviewer")
        advanceUntilIdle()
        assertTrue(vm.canContinue.first(), "name + color must enable Continue")

        // Whitespace-only name reverts to disabled — the spec says
        // "non-blank display name", not "non-empty".
        vm.setDisplayName("   ")
        advanceUntilIdle()
        assertFalse(vm.canContinue.first(), "blank name must not enable Continue")
    }

    // ---------------------------------------------------------------------
    // saveAndContinue
    // ---------------------------------------------------------------------

    @Test
    fun save_and_continue_writes_chosen_profile_and_fires_done() = runTest {
        val store = RecordingProfileStore()
        val vm = ProfileSetupViewModel(store)

        vm.setDisplayName("Reviewer")
        vm.setColor("#16A34A")

        var doneCount = 0
        vm.saveAndContinue { doneCount += 1 }
        advanceUntilIdle()

        // Exactly one save lands; the persisted profile carries the typed
        // name + color and is NOT marked anonymous.
        val saved = store.saved.singleOrNull()
        assertNotNull(saved, "saveAndContinue must persist exactly one profile")
        assertEquals("Reviewer", saved.displayName)
        assertEquals("#16A34A", saved.color)
        assertFalse(saved.isAnonymous, "explicit setup must not yield an anonymous profile")
        assertTrue(saved.userId.isNotBlank(), "user_id must be a non-blank UUID")

        // onDone fires exactly once.
        assertEquals(1, doneCount, "onDone must fire exactly once on success")
    }

    @Test
    fun save_and_continue_without_color_is_a_noop() = runTest {
        val store = RecordingProfileStore()
        val vm = ProfileSetupViewModel(store)

        vm.setDisplayName("Reviewer")
        // Color deliberately not set.

        var fired = false
        vm.saveAndContinue { fired = true }
        advanceUntilIdle()

        assertTrue(store.saved.isEmpty(), "no save must happen with a missing color")
        assertFalse(fired, "onDone must not fire when the form is incomplete")
    }

    @Test
    fun save_and_continue_without_name_is_a_noop() = runTest {
        val store = RecordingProfileStore()
        val vm = ProfileSetupViewModel(store)

        vm.setColor("#DC2626")
        // Name deliberately not set.

        var fired = false
        vm.saveAndContinue { fired = true }
        advanceUntilIdle()

        assertTrue(store.saved.isEmpty(), "no save must happen with a missing name")
        assertFalse(fired, "onDone must not fire when the form is incomplete")
    }

    // ---------------------------------------------------------------------
    // skip
    // ---------------------------------------------------------------------

    @Test
    fun skip_writes_anonymous_profile_and_fires_done() = runTest {
        val store = RecordingProfileStore()
        val vm = ProfileSetupViewModel(store)

        var doneCount = 0
        vm.skip { doneCount += 1 }
        advanceUntilIdle()

        // The persisted profile is the canonical Anonymous shape — the
        // router downstream sees `isInitialized() == true` so the next
        // cold start lands on Recents instead of looping the setup.
        val saved = store.saved.singleOrNull()
        assertNotNull(saved, "skip must persist exactly one profile")
        assertTrue(saved.isAnonymous, "skip must mark the profile anonymous")
        assertEquals("Anonymous", saved.displayName)
        assertEquals(Profile.DEFAULT_COLOR, saved.color)
        assertTrue(saved.userId.isNotBlank(), "anonymous profile still needs a UUID")

        assertEquals(1, doneCount, "onDone must fire exactly once on skip")
    }
}

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

/**
 * In-memory [ProfileStoreApi] that records every save into a public list.
 * `get()` returns the most recently saved profile, or a fresh anonymous
 * snapshot if nothing has been written yet — matching the production
 * `ProfileStore.get()` first-launch contract.
 *
 * Distinct name from the file-private fakes in `ThreadSheetTest` /
 * `ThreadSheetViewModelTest` because top-level Kotlin types in the same
 * package can't share a simple name even when one is `private`. The E1
 * path needs `save` for assertions, so it carries its own recording fake.
 */
private class RecordingProfileStore : ProfileStoreApi {
    val saved: MutableList<Profile> = mutableListOf()

    override suspend fun get(): Profile = saved.lastOrNull() ?: Profile.anonymous()

    override suspend fun save(profile: Profile) {
        saved += profile
    }
}
