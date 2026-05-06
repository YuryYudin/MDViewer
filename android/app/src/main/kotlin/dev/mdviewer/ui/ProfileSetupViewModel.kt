// ---------------------------------------------------------------------------
// ProfileSetupViewModel — drives the [ProfileSetupScreen] composable
// (E1, wireframes/02-profile-setup.html). The screen has three pieces of
// state it has to track:
//
//   * the in-progress display name string,
//   * the picked swatch (or null while the user has not chosen one yet),
//   * a derived `canContinue` boolean the Continue button binds to.
//
// Two terminal actions:
//
//   * `saveAndContinue(onDone)` — persists a non-anonymous Profile carrying
//     the user-supplied name + colour and a freshly-minted UUID. The UUID
//     is canonical authorship identity; the spec is explicit that the
//     id is NOT derived from the display name (display names can collide).
//   * `skip(onDone)` — persists `Profile.anonymous()`. Skipping still
//     writes to the store so the router on the next cold start sees
//     `isInitialized() == true` and lands the user on Recents instead of
//     showing the setup screen again. (The "anonymous" identity itself
//     stays distinguishable across devices because the UUID is per-device.)
//
// Why blank-form save is a no-op (and not just disabled in the UI):
//   * The Continue button is disabled when `canContinue` is false, but a
//     future call site (a keyboard shortcut, a state-restore path, a unit
//     test bypassing the disabled state) must still be unable to write a
//     half-filled profile. The ViewModel guards the rule so the contract
//     holds regardless of who triggers `saveAndContinue`.
//
// Why a `ProfileStoreApi` seam (rather than the concrete [ProfileStore]):
//   * Mirrors the D5 [ThreadSheetViewModel] pattern. ViewModel tests
//     inject a Context-free fake; production wires the real store
//     through [ProfileSetupViewModelFactory].
//
// Coroutine wiring:
//   * `viewModelScope.launch` for the save coroutine. Skip-path persistence
//     is a single DataStore write — fast enough that we don't need a
//     dedicated IO dispatcher seam (unlike ThreadSheet's sidecar.save which
//     can hit Drive). If a future profile-store backend grows a network
//     dependency, this is the place to add an `ioDispatcher` parameter.
//   * `combine` over `_displayName` + `_color` produces the `canContinue`
//     StateFlow. We use `stateIn(viewModelScope, Eagerly, false)` rather
//     than the verbose collect-into-MutableStateFlow trick so the field
//     stays a one-liner.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.UUID

class ProfileSetupViewModel(
    private val profileStore: ProfileStoreApi,
) : ViewModel() {

    private val _displayName = MutableStateFlow("")
    /** The currently-typed display name. The screen binds the input field to this. */
    val displayName: StateFlow<String> = _displayName.asStateFlow()

    private val _color = MutableStateFlow<String?>(null)
    /**
     * The currently-picked swatch hex (e.g. "#4CAF50"), or null while the
     * user has not chosen one yet. `null` is the load-bearing distinction
     * for the canContinue gate — empty-string would conflate "not yet
     * picked" with "user explicitly cleared their selection", which the
     * UI does not actually allow.
     */
    val color: StateFlow<String?> = _color.asStateFlow()

    /**
     * True when both fields are populated (non-blank name AND a picked
     * swatch). The Continue button binds its `enabled` to this flow. We
     * use `stateIn(Eagerly, false)` so the initial emission is `false` —
     * the button must not flash enabled before the first combine emits.
     */
    val canContinue: StateFlow<Boolean> =
        combine(_displayName, _color) { name, hex ->
            name.isNotBlank() && hex != null
        }.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    /** Update the display name. Whitespace is preserved verbatim. */
    fun setDisplayName(value: String) {
        _displayName.value = value
    }

    /**
     * Pick a swatch. [hex] should be the canonical "#RRGGBB" form from
     * [AuthorPalette]; the persistence layer compares as raw strings, so
     * normalising elsewhere would silently de-select a previously-saved
     * profile's swatch.
     */
    fun setColor(hex: String) {
        _color.value = hex
    }

    /**
     * Persist a non-anonymous profile carrying the typed name + picked
     * colour and fire [onDone] exactly once. If either field is missing
     * (blank name OR null color) the call is a no-op — neither write nor
     * callback runs.
     */
    fun saveAndContinue(onDone: () -> Unit) {
        val name = _displayName.value
        val hex = _color.value
        if (name.isBlank() || hex == null) return
        viewModelScope.launch {
            profileStore.save(
                Profile(
                    userId = UUID.randomUUID().toString(),
                    displayName = name,
                    color = hex,
                    isAnonymous = false,
                ),
            )
            onDone()
        }
    }

    /**
     * Persist an Anonymous profile (default name + neutral grey + fresh
     * UUID) and fire [onDone]. This is the bypass path for users who
     * don't want to bother with the form; the router on the next cold
     * start sees `isInitialized() == true` and lands on Recents instead
     * of looping the setup screen.
     */
    fun skip(onDone: () -> Unit) {
        viewModelScope.launch {
            profileStore.save(Profile.anonymous())
            onDone()
        }
    }
}
