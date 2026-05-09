// ---------------------------------------------------------------------------
// SettingsViewModel — drives [SettingsScreen] (E2,
// wireframes/08-settings.html). The screen surfaces three persisted
// preferences (theme, sidecar pattern, show-resolved) and a live editor
// for the [Profile] persisted by [ProfileStore].
//
// State surface:
//   * `theme`, `sidecarPattern`, `showResolved` — StateFlows over the
//     corresponding [SettingsStore] reads. Exposed as StateFlow so Compose
//     `collectAsState` produces a stable subscription that re-emits
//     across config changes; `SharingStarted.WhileSubscribed(5_000)`
//     keeps the upstream coroutines warm across short subscription gaps
//     (a recomposition that tears down and re-mounts the screen) without
//     leaving them running indefinitely.
//   * `profileState` — nullable StateFlow because the profile load is
//     async on construction. The screen renders a loading placeholder
//     while it's null and the editor controls once it's populated.
//
// Why we cache the loaded profile in a private StateFlow rather than
// re-collecting `profileStore.flow` on every read:
//   * The narrowed [ProfileStoreApi] doesn't expose a Flow — it carries
//     just `get` + `save` — so a reactive surface here would force every
//     consumer (including the test fakes) to widen. The MutableStateFlow
//     fed by an `init { get() }` coroutine + `save` round-trips keeps the
//     ProfileStoreApi narrow while letting the Compose layer observe the
//     editor state.
//   * The `updateProfile` call also has to *preserve* the previously-
//     loaded user_id (the spec is explicit that user_id is read-only post-
//     setup). A cache here is the cleanest place to read the prior id.
//
// Why `setSidecarPattern` rejects blank values:
//   * The sidecar resolver downstream uses the pattern to compute a sibling
//     filename. An empty string would resolve to "" which DocumentFile
//     treats as "the directory itself" on tree URIs — the comments would
//     be silently written into the parent folder rather than next to the
//     document. The screen's Apply button binds its `enabled` to the same
//     non-blank check, but the VM guards the rule independently because
//     the disabled-button check is a UI affordance, not a contract.
//
// Why `updateProfile` is a no-op before the initial load:
//   * `_profile.value == null` means the `init { profileStore.get() }`
//     coroutine has not yet completed. Saving with no current profile
//     would mint a fresh UUID via `Profile.anonymous()` and orphan
//     whatever identity the user had before — the editor's contract is
//     "edit the existing identity", not "replace it on first save".
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.mdviewer.data.DEFAULT_SIDECAR_PATTERN
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.data.ThemeMode
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class SettingsViewModel(
    private val settings: SettingsStore,
    private val profileStore: ProfileStoreApi,
) : ViewModel() {

    /**
     * Theme as a StateFlow over the persisted [SettingsStore.theme].
     * `WhileSubscribed(5_000)` keeps the upstream collector warm across
     * short subscription gaps (e.g. a recomposition that tears the screen
     * down and re-mounts it) without leaking the coroutine when nobody
     * is observing.
     */
    val theme: StateFlow<ThemeMode> = settings.theme.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = ThemeMode.FollowSystem,
    )

    val sidecarPattern: StateFlow<String> = settings.sidecarPattern.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = DEFAULT_SIDECAR_PATTERN,
    )

    val showResolved: StateFlow<Boolean> = settings.showResolved.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5_000),
        initialValue = false,
    )

    private val _profile = MutableStateFlow<Profile?>(null)
    /**
     * The currently-loaded profile, or null while the initial async
     * `profileStore.get()` is still in flight. The screen branches on
     * null to show a loading placeholder; the editor controls bind once
     * a non-null Profile is available.
     */
    val profileState: StateFlow<Profile?> = _profile.asStateFlow()

    init {
        // Kick off the initial profile load. The first `save` from
        // `updateProfile` runs only after this completes (guarded by the
        // null check there) so a too-early save can't orphan the
        // existing user_id.
        viewModelScope.launch {
            _profile.value = profileStore.get()
        }
    }

    // The setters return the launched [Job] so tests can `.join()` and
    // observe a deterministic post-write state without racing the
    // Compose-side fire-and-forget contract. Compose call sites discard
    // the return via Kotlin's Unit-coercion in `(T) -> Unit` lambdas
    // (method references — `vm::setTheme` — would NOT coerce, so
    // SettingsScreen wraps each in `{ ... }` to make the discard explicit).
    //
    // The earlier `Unit`-returning shape made the VM untestable without
    // a timed flow.first { } race: there was no completion handle for a
    // test to await, so we polled a downstream Flow with a real-clock
    // withTimeout that JaCoCo offline instrumentation regularly blew
    // through on CI runners.

    /** Persist the chosen theme. The flow re-emits and Compose recomposes. */
    fun setTheme(mode: ThemeMode): Job =
        viewModelScope.launch { settings.setTheme(mode) }

    /**
     * Persist the sidecar pattern. Blank values are rejected so the
     * sidecar resolver downstream never sees "" as a sibling filename.
     * The screen disables Apply on blank, but the VM enforces the rule
     * independently in case a future call site bypasses the UI gate.
     *
     * The blank check runs inside the launch so the returned Job
     * completes uniformly (including for the no-op case) — callers
     * `.join()`ing don't have to special-case a synthetic completed job.
     */
    fun setSidecarPattern(pattern: String): Job =
        viewModelScope.launch {
            if (pattern.isBlank()) return@launch
            settings.setSidecarPattern(pattern)
        }

    fun setShowResolved(value: Boolean): Job =
        viewModelScope.launch { settings.setShowResolved(value) }

    /**
     * Persist a new display name + color for the current user, preserving
     * the existing user_id and clearing the `isAnonymous` flag. A
     * previously-skipped user (Profile.anonymous()) appears as a real
     * named author after this completes.
     *
     * No-op when the initial profile load has not yet completed —
     * minting a fresh UUID here would orphan the existing identity.
     */
    fun updateProfile(displayName: String, color: String): Job =
        viewModelScope.launch {
            val current = _profile.value ?: return@launch
            val updated = current.copy(
                displayName = displayName,
                color = color,
                isAnonymous = false,
            )
            profileStore.save(updated)
            _profile.value = updated
        }
}
