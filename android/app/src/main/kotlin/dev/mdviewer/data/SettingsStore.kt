// ---------------------------------------------------------------------------
// SettingsStore — DataStore-Preferences-backed app preferences.
//
// Three settings live here today:
//
//   * `theme` — Light / Dark / FollowSystem. Defaults to FollowSystem so
//     a fresh install respects the device theme without forcing a switch.
//   * `sidecarPattern` — printf-ish template that resolves a `.md` file
//     to its `.md.comments.json` sibling. Defaults to
//     "{name}.md.comments.json" to match the desktop client's naming.
//     Held as a string (rather than a custom type) so a future migration
//     can introduce per-folder overrides without breaking the wire format.
//   * `showResolved` — whether the comments drawer surfaces resolved
//     threads. Defaults to false so a freshly-resolved thread doesn't
//     keep cluttering the UI.
//
// All three exposed as Flow + a suspend setter — same shape as the other
// stores in this package. Compose collectors observe the Flow with
// `collectAsStateWithLifecycle()` and the per-setting setters land via
// suspend functions inside ViewModel coroutines.
//
// We deliberately do NOT cache reads in-memory: DataStore already wraps
// its underlying file in a coroutine-safe StateFlow internally, so the
// `data` property re-emits cheaply on every collection. Adding our own
// cache would just risk staleness when the on-disk file changes from
// another process (Android system "Clear data", restored backups, etc).
// ---------------------------------------------------------------------------
package dev.mdviewer.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * UI theme selector. Mirrored to disk as the lower-case identifier so a
 * hand-edit of the prefs file or a future migration script doesn't have
 * to chase enum-name renames. Unknown / missing values fall back to
 * [FollowSystem] in [SettingsStore.theme].
 */
enum class ThemeMode {
    Light,
    Dark,
    FollowSystem,
}

/** Default sidecar resolution pattern. Matches the desktop client. */
const val DEFAULT_SIDECAR_PATTERN: String = "{name}.md.comments.json"

class SettingsStore(
    ctx: Context,
    prefsName: String = "settings",
) {
    private val appCtx = ctx.applicationContext

    // See Recents for the rationale behind the per-file memoisation. The
    // settings file is functionally a singleton in production but tests
    // — and any future code that reconstructs the wrapper across config
    // changes — need the same instance back from the cache to avoid the
    // "multiple DataStores per file" runtime check.
    private val store: DataStore<Preferences> = stores.getOrPut(prefsName) {
        PreferenceDataStoreFactory.create(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            produceFile = { appCtx.preferencesDataStoreFile(prefsName) },
        )
    }

    private val themeKey = stringPreferencesKey("theme")
    private val sidecarPatternKey = stringPreferencesKey("sidecar_pattern")
    private val showResolvedKey = booleanPreferencesKey("show_resolved")

    // v0.4.17: tracks doc-URI hashes for which the user has already seen
    // the "grant folder access?" bottom-sheet, so it doesn't re-prompt on
    // every reopen of the same SingleUri document. Hashed (SHA-256, base64)
    // rather than stored verbatim because Drive URIs include opaque doc-id
    // strings we don't want to persist in the preferences file in clear.
    private val promoAskedKey = stringSetPreferencesKey("grant_folder_promo_asked")

    // v0.4.19: tracks URI hashes the user explicitly dismissed via the
    // banner close button. Once dismissed, the banner doesn't return on
    // re-open of the same doc — it's the user's "I get it, stop showing
    // me" signal. Separate from the asked set so we can distinguish
    // "shown" (declined sheet) from "told us to shut up" (closed banner).
    private val bannerDismissedKey = stringSetPreferencesKey("grant_folder_banner_dismissed")

    /**
     * Theme as a Flow. Falls back to [ThemeMode.FollowSystem] on absent
     * keys AND on values we don't recognise — the latter keeps a forward-
     * compatible migration safe (a future "system_high_contrast" string
     * just renders as FollowSystem on this version instead of crashing).
     */
    val theme: Flow<ThemeMode> = store.data.map { prefs ->
        decodeTheme(prefs[themeKey])
    }

    val sidecarPattern: Flow<String> = store.data.map { prefs ->
        prefs[sidecarPatternKey] ?: DEFAULT_SIDECAR_PATTERN
    }

    val showResolved: Flow<Boolean> = store.data.map { prefs ->
        prefs[showResolvedKey] ?: false
    }

    suspend fun setTheme(mode: ThemeMode) {
        setThemeRaw(encodeTheme(mode))
    }

    /**
     * Visible-for-tests escape hatch that writes any string into the
     * theme slot, including unknown values. Production code should use
     * [setTheme] which guarantees the encoded value round-trips through
     * [decodeTheme]; the test suite uses this to assert that bogus on-
     * disk values fall back to FollowSystem rather than throwing.
     *
     * `internal` keeps this off the production API surface — callers
     * outside the `:app` module cannot corrupt the theme slot with
     * arbitrary strings. `:app`-internal tests in the same module still
     * resolve it because Kotlin's `internal` is module-scoped.
     */
    internal suspend fun setThemeRaw(raw: String) {
        store.edit { it[themeKey] = raw }
    }

    suspend fun setSidecarPattern(pattern: String) {
        store.edit { it[sidecarPatternKey] = pattern }
    }

    /**
     * Set of doc-URI hashes for which the grant-folder-access bottom-sheet
     * has already been shown (regardless of user choice). Used by
     * DocumentScreen to decide between sheet-on-first-open and the
     * persistent "Comments saved on device" banner on later opens.
     */
    val grantPromoAsked: Flow<Set<String>> = store.data.map { prefs ->
        prefs[promoAskedKey] ?: emptySet()
    }

    /**
     * Record that the user has seen the grant-folder-access prompt for the
     * given URI. Safe to call concurrently; DataStore serializes writes.
     */
    suspend fun recordGrantPromoAsked(uriHash: String) {
        store.edit { prefs ->
            val current = prefs[promoAskedKey] ?: emptySet()
            prefs[promoAskedKey] = current + uriHash
        }
    }

    /**
     * Set of doc-URI hashes for which the user has explicitly dismissed
     * the saved-on-device banner via its close button. The banner stays
     * hidden across reopens until the user re-grants tree access (which
     * would flip the capability away from SingleUri anyway).
     */
    val grantBannerDismissed: Flow<Set<String>> = store.data.map { prefs ->
        prefs[bannerDismissedKey] ?: emptySet()
    }

    /**
     * Record that the user dismissed the banner for the given URI. Idempotent.
     */
    suspend fun recordGrantBannerDismissed(uriHash: String) {
        store.edit { prefs ->
            val current = prefs[bannerDismissedKey] ?: emptySet()
            prefs[bannerDismissedKey] = current + uriHash
        }
    }

    suspend fun setShowResolved(value: Boolean) {
        store.edit { it[showResolvedKey] = value }
    }

    private fun decodeTheme(raw: String?): ThemeMode = when (raw) {
        "light" -> ThemeMode.Light
        "dark" -> ThemeMode.Dark
        // Includes both null (never written) and "follow_system" (explicitly
        // written) and unknown future values — all collapse to the safe
        // default.
        else -> ThemeMode.FollowSystem
    }

    private fun encodeTheme(mode: ThemeMode): String = when (mode) {
        ThemeMode.Light -> "light"
        ThemeMode.Dark -> "dark"
        ThemeMode.FollowSystem -> "follow_system"
    }

    private companion object {
        // Process-wide DataStore cache. See Recents.Companion for rationale.
        val stores: java.util.concurrent.ConcurrentHashMap<String, DataStore<Preferences>> =
            java.util.concurrent.ConcurrentHashMap()
    }
}
