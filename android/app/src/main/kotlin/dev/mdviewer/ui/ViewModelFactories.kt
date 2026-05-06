// ---------------------------------------------------------------------------
// ViewModelFactories — boring constructor wiring between the Compose
// Navigation layer (which can only call factories with a Context) and
// the [DocumentViewModel] / [RecentsViewModel] (which want narrowed
// `*Api` interfaces injected).
//
// Why we need explicit factories rather than the default no-arg
// constructor: both ViewModels take constructor parameters that Compose
// Navigation cannot synthesize (a [DocumentRepositoryApi], a
// [RecentsApi], an already-resolved sidecar pattern + theme). The
// factory pattern is the standard Android-recommended seam — see
// `ViewModelProvider.Factory.create`.
//
// Sidecar pattern + theme resolution:
//   * `sidecarPattern`: read from [SettingsStore] via `runBlocking` on
//     the composer thread is bad form, but the default — defined as the
//     constant [DEFAULT_SIDECAR_PATTERN] in the data layer — is the
//     same value the persistent store falls back to when no override is
//     set. C5 ships with the default; D7's "Settings" screen will wire
//     a reactive flow once the user can change it.
//   * `theme`: derived from the device theme via Compose's
//     `isSystemInDarkTheme()` at the call site. We pass [HtmlTheme.Light]
//     or [HtmlTheme.Dark] in by value so the ViewModel never needs a
//     Compose dependency.
//
// Both factories are deliberately narrow: they do nothing beyond
// instantiation. Production wiring (Hilt, manual DI containers) can
// replace them by overriding the route's `viewModel(factory = ...)`
// argument; for C5 the inline factories are enough.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import dev.mdviewer.data.DEFAULT_SIDECAR_PATTERN
import dev.mdviewer.data.ProfileStore
import dev.mdviewer.data.Recents
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.saf.DocumentRepository
import dev.mdviewer.saf.Sidecar

class DocumentViewModelFactory(
    private val ctx: Context,
    private val theme: HtmlTheme,
    private val sidecarPattern: String = DEFAULT_SIDECAR_PATTERN,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(DocumentViewModel::class.java)) {
            "DocumentViewModelFactory does not produce ${modelClass.name}"
        }
        return DocumentViewModel(
            repo = DocumentRepository(ctx.applicationContext),
            sidecarPattern = sidecarPattern,
            recents = Recents(ctx.applicationContext),
            // D8: Sidecar.load returns the per-doc CommentsStoreHandle
            // the open path stashes on Loaded so the anchor-resolve
            // pass and the future ThreadSheet integration can read it
            // without a second open round-trip.
            sidecar = Sidecar(ctx.applicationContext),
            theme = theme,
        ) as T
    }
}

class RecentsViewModelFactory(
    private val ctx: Context,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(RecentsViewModel::class.java)) {
            "RecentsViewModelFactory does not produce ${modelClass.name}"
        }
        return RecentsViewModel(Recents(ctx.applicationContext)) as T
    }
}

/**
 * Wires the production [ProfileStore] into a [ProfileSetupViewModel]. The
 * `applicationContext` capture mirrors the other factories' rationale —
 * the Activity-scoped Context would leak into a ViewModel that survives
 * configuration changes, while the application-scoped one is fine for
 * the lifetime of the process.
 */
class ProfileSetupViewModelFactory(
    private val ctx: Context,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(ProfileSetupViewModel::class.java)) {
            "ProfileSetupViewModelFactory does not produce ${modelClass.name}"
        }
        return ProfileSetupViewModel(ProfileStore(ctx.applicationContext)) as T
    }
}

/**
 * Wires the production [SettingsStore] + [ProfileStore] into a
 * [SettingsViewModel] for the E2 settings route. Both stores are keyed on
 * `applicationContext`'s prefs path so this factory shares state with
 * the [SettingsStore] instance MainActivity hands to [MdviewerApp]
 * (DataStore-Preferences is process-singleton'd by file name —
 * `SettingsStore.companion.stores` and `ProfileStore.companion.stores`
 * both cache by prefsName, so two `SettingsStore(ctx)` calls return
 * handles to the same DataStore).
 */
class SettingsViewModelFactory(
    private val ctx: Context,
) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(SettingsViewModel::class.java)) {
            "SettingsViewModelFactory does not produce ${modelClass.name}"
        }
        return SettingsViewModel(
            settings = SettingsStore(ctx.applicationContext),
            profileStore = ProfileStore(ctx.applicationContext),
        ) as T
    }
}
