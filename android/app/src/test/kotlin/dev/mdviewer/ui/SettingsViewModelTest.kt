// ---------------------------------------------------------------------------
// SettingsViewModelTest — host-JVM verification of the E2 settings screen
// state machine. The ViewModel surfaces three persisted preferences from
// [SettingsStore] (theme, sidecarPattern, showResolved) plus the persisted
// [Profile] from [ProfileStoreApi], and exposes mutation methods that
// round-trip through both stores.
//
// What we lock in:
//   1. Theme writes round-trip through SettingsStore — `setTheme(Dark)`
//      followed by a flow read returns Dark. Tied to the design's
//      success criterion #8 ("the change applies immediately"): if the
//      VM didn't observe the SettingsStore flow we'd ship a stale value
//      to the WebView CSS swap path.
//   2. Sidecar pattern writes round-trip; an empty / blank pattern is
//      rejected so the comments resolution path never sees "" as a sibling
//      filename. The ViewModel guards the rule because the UI's "Apply"
//      button must still fail safe if a future call site bypasses the
//      enabled-state.
//   3. `updateProfile` writes a non-anonymous Profile carrying the typed
//      name + picked color, preserves the existing user_id (the spec is
//      explicit that user_id is read-only post-setup), and clears the
//      `isAnonymous` flag so a previously-skipped user appears as a real
//      author after editing.
//   4. Show-resolved toggle round-trips.
//   5. The `theme` flow re-emits when a separate writer (a parallel
//      collector, a future settings sync path) mutates the store —
//      this is the contract that ThemeController relies on for live
//      Compose recomposition + the WebView CSS swap.
//
// Why `runBlocking` instead of `runTest` here (unlike most other VM
// tests in this package): the VM's setters return the launched [Job] —
// they fire-and-forget at the Compose call site but expose a
// completion handle for tests to `.join()`. `runBlocking` lets that
// `.join()` suspend on real wall-clock time until DataStore's IO
// write completes; `runTest`'s virtual-time scheduler doesn't drive
// the real `Dispatchers.IO` worker, so it would race against the
// still-in-flight write.
//
// The earlier shape (Unit-returning setters, polled flows under a
// real-clock withTimeout) was flake-prone on CI under JaCoCo offline
// instrumentation: the round-trip cost of a single DataStore write +
// flow re-emit regularly exceeded 30 seconds, blowing past the
// timeout. `.join()` removes the polling race entirely — the test
// resumes the moment the launch's body completes.
//
// Robolectric @Config(sdk = 33) keeps the shadow framework on the same
// API level the C-phase tests use; it's needed because [SettingsStore]
// touches Android's preferencesDataStoreFile path resolution.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import androidx.test.core.app.ApplicationProvider
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.data.ThemeMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
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
class SettingsViewModelTest {

    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    // viewModelScope routes its launch coroutines through Dispatchers.Main.
    // We install an UnconfinedTestDispatcher under Main so the launches
    // run synchronously up to their first real-IO suspension; the test's
    // `flow.first { ... }` then suspends on real wall-clock time until the
    // DataStore IO emission catches up.
    @Before fun setUp() { Dispatchers.setMain(UnconfinedTestDispatcher()) }
    @After fun tearDown() { Dispatchers.resetMain() }

    private fun newSettings(): SettingsStore =
        SettingsStore(ctx, prefsName = "settings-vm-${System.nanoTime()}")

    // ---------------------------------------------------------------------
    // Theme
    // ---------------------------------------------------------------------

    @Test
    fun set_theme_persists_through_settings_store() = runBlocking {
        val settings = newSettings()
        val profile = SeededProfileStore(seed = Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        // `.join()` waits for the launched setter to finish persisting;
        // after that, both the underlying SettingsStore and (after
        // upstream propagation through stateIn) the VM's theme flow
        // surface the new value.
        vm.setTheme(ThemeMode.Dark).join()

        assertEquals(ThemeMode.Dark, settings.theme.first())
        // The VM's stateIn flow is lazy (WhileSubscribed); a `first { }`
        // predicate read forces a subscription and waits up to 5s for
        // upstream propagation under heavy CI runners.
        withTimeout(5_000) {
            assertEquals(ThemeMode.Dark, vm.theme.first { it == ThemeMode.Dark })
        }
    }

    @Test
    fun theme_flow_observes_external_writes() = runBlocking {
        // The Compose ThemeController collects this flow via
        // collectAsState; it MUST reflect a write that lands via the
        // SettingsStore directly (e.g. a future settings-sync path), not
        // just writes routed through the VM. If this regressed, the
        // WebView CSS swap would lag the persisted theme.
        val settings = newSettings()
        val profile = SeededProfileStore(seed = Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        // Direct SettingsStore.setTheme is already suspending and awaits
        // the IO write — no VM-launch indirection here, so the only
        // remaining wait is upstream-propagation latency for the VM's
        // lazy stateIn subscriber.
        settings.setTheme(ThemeMode.Light)

        withTimeout(5_000) {
            assertEquals(ThemeMode.Light, vm.theme.first { it == ThemeMode.Light })
        }
    }

    // ---------------------------------------------------------------------
    // Sidecar pattern
    // ---------------------------------------------------------------------

    @Test
    fun set_sidecar_pattern_round_trips() = runBlocking {
        val settings = newSettings()
        val profile = SeededProfileStore(seed = Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        vm.setSidecarPattern(".comments/{name}.json").join()

        assertEquals(".comments/{name}.json", settings.sidecarPattern.first())
    }

    @Test
    fun set_sidecar_pattern_rejects_blank() = runBlocking {
        val settings = newSettings()
        val profile = SeededProfileStore(seed = Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        // Seed a custom value so we can detect (or rather, assert the
        // absence of) a subsequent write.
        vm.setSidecarPattern("custom-{name}.json").join()
        assertEquals("custom-{name}.json", settings.sidecarPattern.first())

        // Blank value is a no-op — the prior value survives. The screen
        // disables the Apply button, but the VM must guard the rule
        // independently in case a future caller bypasses the disabled
        // state. The launch still completes (the blank-check is inside
        // the launch), so `.join()` returns; the assertion then verifies
        // the SettingsStore was untouched.
        vm.setSidecarPattern("   ").join()
        assertEquals("custom-{name}.json", settings.sidecarPattern.first())
    }

    // ---------------------------------------------------------------------
    // Show-resolved toggle
    // ---------------------------------------------------------------------

    @Test
    fun set_show_resolved_round_trips() = runBlocking {
        val settings = newSettings()
        val profile = SeededProfileStore(seed = Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        vm.setShowResolved(true).join()
        assertEquals(true, settings.showResolved.first())

        vm.setShowResolved(false).join()
        assertEquals(false, settings.showResolved.first())
    }

    // ---------------------------------------------------------------------
    // Profile editor
    // ---------------------------------------------------------------------

    @Test
    fun update_profile_writes_named_profile_and_clears_anonymous_flag() = runBlocking {
        val settings = newSettings()
        // Seed an anonymous profile — the editor's job is to upgrade this
        // to a named one without changing the user_id.
        val seeded = Profile.anonymous()
        val profile = SeededProfileStore(seed = seeded)
        val vm = SettingsViewModel(settings, profile)

        // Wait for the VM's `init { profileStore.get() }` to land in the
        // exposed StateFlow before we trigger the edit; otherwise the
        // updateProfile call would be a (correct, but uninteresting) no-op.
        // The init load is itself a `viewModelScope.launch`; this poll is
        // tiny and runs in well under a second.
        withTimeout(5_000) {
            vm.profileState.first { it != null }
        }

        vm.updateProfile(displayName = "Daisy Sato", color = "#4CAF50").join()

        val current = vm.profileState.value!!
        assertEquals("Daisy Sato", current.displayName)
        assertEquals("#4CAF50", current.color)
        assertFalse(current.isAnonymous, "saving from the editor must clear the anonymous flag")
        // user_id is read-only metadata — preserved across the save.
        assertEquals(seeded.userId, current.userId)

        val saved = profile.saved.lastOrNull()
        assertNotNull(saved, "updateProfile must persist the new profile")
        assertEquals("Daisy Sato", saved.displayName)
        assertEquals("#4CAF50", saved.color)
        assertFalse(saved.isAnonymous)
        assertEquals(seeded.userId, saved.userId)
    }

    @Test
    fun update_profile_before_load_is_a_noop() = runBlocking {
        // If the initial `get()` hasn't completed yet, the VM has no
        // user_id to preserve. The save path must be a no-op rather than
        // mint a fresh UUID — that would orphan the existing identity.
        val settings = newSettings()
        val profile = LatchedSettingsProfileStore()
        val vm = SettingsViewModel(settings, profile)

        // The latched store's `get()` never returns, so the init load
        // never lands in `_profile`. `updateProfile` launches anyway,
        // hits the null-check inside the launch, and returns without
        // calling `save`. `.join()` waits for that no-op to complete.
        vm.updateProfile("Reviewer", "#16A34A").join()

        assertTrue(profile.saved.isEmpty(), "updateProfile must not save before profile loads")
    }
}

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

/**
 * In-memory [ProfileStoreApi] seeded with a known profile. Records every
 * save into a public list so tests can assert on the persisted Profile
 * directly rather than re-reading through `get()`.
 *
 * Distinct name from the file-private fakes in
 * `ProfileSetupViewModelTest` because Kotlin top-level declarations can
 * not share a simple name across the same package even when one is
 * `private`. The E2 path needs a seed parameter (the editor's
 * `updateProfile` preserves user_id from the prior get()), so it carries
 * its own recording fake.
 */
private class SeededProfileStore(seed: Profile) : ProfileStoreApi {
    private var current: Profile = seed
    val saved: MutableList<Profile> = mutableListOf()

    override suspend fun get(): Profile = current

    override suspend fun save(profile: Profile) {
        saved += profile
        current = profile
    }
}

/**
 * [ProfileStoreApi] whose `get()` never completes — used to verify the VM
 * does not save a profile before its initial load lands. `save` records
 * for assertions but should never fire under the test scenario.
 */
private class LatchedSettingsProfileStore : ProfileStoreApi {
    val saved: MutableList<Profile> = mutableListOf()

    override suspend fun get(): Profile {
        kotlinx.coroutines.awaitCancellation()
    }

    override suspend fun save(profile: Profile) {
        saved += profile
    }
}
