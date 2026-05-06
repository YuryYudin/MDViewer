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
// tests in this package): the VM's setters are non-suspending — they
// schedule a `viewModelScope.launch` that calls into [SettingsStore]'s
// suspending writes, which dispatch to DataStore's internal scope on
// `Dispatchers.IO`. `runTest`'s virtual-time scheduler doesn't drive the
// real `Dispatchers.IO` worker, so a `runTest { vm.setTheme(...);
// advanceUntilIdle(); assert(...) }` would race against the still-in-
// flight IO write. `runBlocking` lets the assertion's `flow.first { ... }`
// suspend on real wall-clock time until DataStore re-emits — the only
// reliable way to observe the write under a real IO dispatcher.
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

        vm.setTheme(ThemeMode.Dark)

        // The VM's theme flow is downstream of settings.theme; once the IO
        // write lands and DataStore re-emits, the VM stateIn flow surfaces
        // the new value. `first { ... }` suspends until the predicate
        // matches; the timeout guards against a regression that fails to
        // emit at all.
        withTimeout(5_000) {
            assertEquals(ThemeMode.Dark, vm.theme.first { it == ThemeMode.Dark })
        }
        assertEquals(ThemeMode.Dark, settings.theme.first())
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

        vm.setSidecarPattern(".comments/{name}.json")

        withTimeout(5_000) {
            settings.sidecarPattern.first { it == ".comments/{name}.json" }
        }
        assertEquals(".comments/{name}.json", settings.sidecarPattern.first())
    }

    @Test
    fun set_sidecar_pattern_rejects_blank() = runBlocking {
        val settings = newSettings()
        val profile = SeededProfileStore(seed = Profile.anonymous())
        val vm = SettingsViewModel(settings, profile)

        // Seed a custom value so we can detect a write happening.
        vm.setSidecarPattern("custom-{name}.json")
        withTimeout(5_000) {
            settings.sidecarPattern.first { it == "custom-{name}.json" }
        }

        // Blank value is a no-op — the prior value survives. The screen
        // disables the Apply button, but the VM must guard the rule
        // independently in case a future caller bypasses the disabled
        // state.
        vm.setSidecarPattern("   ")
        // No write was scheduled, so we just give the test scheduler a
        // brief real-time window to confirm nothing changed. A second
        // first() read returns the same custom value.
        kotlinx.coroutines.delay(50)
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

        vm.setShowResolved(true)
        withTimeout(5_000) {
            settings.showResolved.first { it }
        }
        assertEquals(true, settings.showResolved.first())

        vm.setShowResolved(false)
        withTimeout(5_000) {
            settings.showResolved.first { !it }
        }
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
        withTimeout(5_000) {
            vm.profileState.first { it != null }
        }

        vm.updateProfile(displayName = "Daisy Sato", color = "#4CAF50")

        // Wait for the VM's saved-profile state to reflect the edit.
        val current = withTimeout(5_000) {
            vm.profileState.first { it?.displayName == "Daisy Sato" }
        }!!
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

        // Do NOT wait for the load — the latched store's get() never
        // returns, so _profile stays null.
        vm.updateProfile("Reviewer", "#16A34A")

        // Give the launch a chance to run (it should early-return on the
        // null check). 100ms is well past the dispatch-and-no-op latency.
        kotlinx.coroutines.delay(100)

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
