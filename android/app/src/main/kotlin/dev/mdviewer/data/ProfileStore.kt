// ---------------------------------------------------------------------------
// ProfileStore — DataStore-Preferences-backed identity for thread
// authorship. v1 is single-device: we mint a UUID on first launch, ship
// it as the user_id field on every comment, and let the user customise
// the displayed name + colour swatch.
//
// Why opaque UUIDs and not e.g. an email or Google Sign-In ID:
//   * Cross-device sync is v2 work — the design intentionally keeps v1
//     identity per-device so we don't store a credential we don't yet
//     know how to refresh.
//   * UUIDs are URL-safe, sortable, and don't require any network round
//     trip to obtain — first-launch latency stays at zero.
//
// First-launch contract: `get()` returns an Anonymous profile (with a
// fresh UUID) AND persists it on the same call. This is deliberate —
// the alternative (returning a transient default that is *not* saved)
// would mean every cold-start before the user finishes the setup screen
// spawns a different UUID, breaking comment authorship continuity if a
// crash interleaves with the setup flow.
// ---------------------------------------------------------------------------
package dev.mdviewer.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

/**
 * Local-only authorship identity. `userId` is an opaque UUID minted on
 * first launch; `displayName` and `color` are user-editable. The
 * `isAnonymous` flag stays true until the user explicitly picks a name
 * and colour via the setup screen — the UI uses it to decide whether to
 * route the user through profile setup or straight to recents.
 */
@Serializable
data class Profile(
    val userId: String,
    val displayName: String,
    val color: String,
    val isAnonymous: Boolean,
) {
    companion object {
        // First palette swatch from wireframes/02-profile-setup.html (a
        // muted neutral grey). Pinned here so a refactor that reorders
        // the palette doesn't silently change first-launch identity for
        // every existing install.
        const val DEFAULT_COLOR: String = "#9CA3AF"

        /**
         * Mint an Anonymous profile with a fresh UUID. The store calls this
         * on first `get()` and persists the result, so subsequent `get()`s
         * see the same UUID. Callers who want a brand-new identity must
         * `save(...)` an explicit profile rather than calling this twice.
         */
        fun anonymous(): Profile = Profile(
            userId = UUID.randomUUID().toString(),
            displayName = "Anonymous",
            color = DEFAULT_COLOR,
            isAnonymous = true,
        )
    }
}

/**
 * Narrow interface the [dev.mdviewer.ui.ThreadSheetViewModel] consumes when
 * it needs the active [Profile] to stamp on a comment. Production wires the
 * full [ProfileStore]; ViewModel tests inject a fake (see
 * `ThreadSheetViewModelTest.FakeProfileStore`) so they don't have to spin
 * up a DataStore-backed file under a Robolectric Context.
 *
 * The interface is deliberately read-only — the ThreadSheet path never
 * mutates the profile (E2's SettingsScreen owns that). Keeping the seam
 * narrow means the fake stays a one-liner.
 */
interface ProfileStoreApi {
    /**
     * Returns the persisted profile, minting + saving an Anonymous one on
     * the very first call. Mirrors [ProfileStore.get].
     */
    suspend fun get(): Profile
}

/**
 * DataStore-backed singleton-style profile store. See [Recents] for the
 * `prefsName` injection rationale; same pattern applies here.
 */
class ProfileStore(
    ctx: Context,
    prefsName: String = "profile",
) : ProfileStoreApi {
    private val appCtx = ctx.applicationContext

    // See Recents for the rationale behind the per-file memoisation —
    // DataStore throws if two stores point at the same file in one
    // process, and ProfileStore is just as likely to be reconstructed
    // across config changes as Recents.
    private val store: DataStore<Preferences> = stores.getOrPut(prefsName) {
        PreferenceDataStoreFactory.create(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            produceFile = { appCtx.preferencesDataStoreFile(prefsName) },
        )
    }

    private val key = stringPreferencesKey("profile_json")

    /** Compose-friendly observable view; emits the saved profile or the
     *  default anonymous profile if nothing has been written yet. */
    val flow: Flow<Profile> = store.data.map { prefs ->
        decode(prefs[key]) ?: Profile.anonymous()
    }

    /**
     * Read the persisted profile, or mint+save an Anonymous one on first
     * call. The save happens inside the same suspend so a crash between
     * `anonymous()` and the next `get()` doesn't leak a fresh UUID per
     * restart.
     */
    override suspend fun get(): Profile {
        val raw = store.data.map { it[key] }.first()
        decode(raw)?.let { return it }
        val fresh = Profile.anonymous()
        save(fresh)
        return fresh
    }

    /** Persist the given profile, overwriting any prior value. */
    suspend fun save(profile: Profile) {
        store.edit { it[key] = json.encodeToString(Profile.serializer(), profile) }
    }

    /**
     * True iff a profile has been persisted at least once. The setup-
     * screen router consumes this — `false` triggers the
     * profile-setup flow on first launch; `true` skips straight to
     * recents.
     */
    suspend fun isInitialized(): Boolean =
        store.data.map { it[key] != null }.first()

    private fun decode(raw: String?): Profile? =
        if (raw.isNullOrEmpty()) null else json.decodeFromString(Profile.serializer(), raw)

    private companion object {
        // Process-wide DataStore cache. See Recents.Companion for rationale.
        val stores: java.util.concurrent.ConcurrentHashMap<String, DataStore<Preferences>> =
            java.util.concurrent.ConcurrentHashMap()

        // Same lenient parsing rules as Recents — keep the schema
        // forward-compatible without erroring on unknown fields.
        val json: Json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}
