// ---------------------------------------------------------------------------
// Recents — DataStore-Preferences-backed list of recently-opened markdown
// documents, capped at `maxEntries` (50 by default) and ordered most-
// recent-first.
//
// Why a single JSON-encoded string over a structured key-set: each entry
// carries four fields (uri, displayName, lastOpenedEpochMs, safTier) plus
// future ones (Phase E adds folder/tree URIs). Unrolling those into a
// per-entry preferences key is verbose, fragile (key-name collisions),
// and forces every read to scan the entire prefs map. A single JSON blob
// keeps the schema legible and the read path O(1) — DataStore's atomic
// write semantics guarantee we either see the old list or the new list,
// never a half-written hybrid.
//
// Why an explicit `prefsName` parameter (with a default of "recents"):
//   * Production code constructs `Recents(ctx)` and gets the singleton
//     "recents" preferences file under `filesDir/datastore/`.
//   * Unit tests construct `Recents(ctx, prefsName = "recents-test-${nanoTime}")`
//     so each `@Test` method writes to its own file. Without the override
//     the second @Test in a class would observe the first @Test's writes,
//     hiding ordering and eviction bugs.
//
// Eviction policy: this class enforces the in-memory size cap (`maxEntries`).
// The 480-entry persistable-URI cap is a *separate* concern handled in C5/E5
// — recording an entry doesn't take a persistable grant; that happens at the
// SAF call site. The `PERSISTABLE_URI_CAP` constant lives here so the C5
// reaper can reference it without re-defining the magic number.
// ---------------------------------------------------------------------------
package dev.mdviewer.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json

/**
 * One row in the recents list. `safTier` carries forward how the URI was
 * originally granted so the document loader knows whether it can touch
 * sibling sidecars without re-prompting (see [SafTier]).
 */
@Serializable
data class RecentEntry(
    val uri: String,
    val displayName: String,
    val lastOpenedEpochMs: Long,
    val safTier: SafTier,
)

/**
 * Public surface of [Recents] consumed by the UI/ViewModel layer.
 *
 * Why an interface above a single concrete class: the production
 * [Recents] takes a [Context] in its constructor (DataStore needs it to
 * resolve `filesDir/datastore/`) which is awkward to fake under a host-
 * JVM unit test. Extracting the interface lets ViewModels depend on
 * exactly the methods they need, and the C5 unit tests inject a
 * Context-free fake. The methods listed here mirror the subset of
 * [Recents] that crosses the data/UI seam — lower-level helpers like
 * `remove()` stay on the concrete class for now and can be promoted
 * later if the UI needs them.
 */
interface RecentsApi {
    /**
     * Compose-friendly observable view of the list. Subscribers re-render
     * whenever a write lands.
     */
    val flow: Flow<List<RecentEntry>>

    /** Snapshot of the current list, most-recent-first. */
    suspend fun list(): List<RecentEntry>

    /**
     * Promote (or insert) an entry to the front of the list, refreshing
     * its [displayName] and [safTier] in the process.
     */
    suspend fun recordOpen(uri: String, displayName: String, safTier: SafTier)

    /**
     * E5 surface: same dedupe-promote semantics as [recordOpen], but also
     * enforces the persistable-URI grant cap by releasing the *oldest*
     * persistable URI grant whenever a new entry would push the
     * persisted-list past [Recents.PERSISTABLE_URI_CAP]. Default impl
     * delegates to [recordOpen] so test fakes that don't model the OS
     * grant cap stay source-compatible.
     */
    suspend fun openOrTouch(uri: String, displayName: String, safTier: SafTier) {
        recordOpen(uri, displayName, safTier)
    }
}

/**
 * DataStore-Preferences-backed recents list.
 *
 * @param ctx Application or activity context — only `applicationContext`
 *   is captured to avoid leaking activity references through the DataStore
 *   instance.
 * @param prefsName File name (without extension) under
 *   `filesDir/datastore/`. Defaults to `"recents"`; tests pass a unique
 *   name to keep their state isolated.
 * @param maxEntries Hard cap before LRU eviction kicks in. Defaults to
 *   50; tests use small values (e.g. 3) to assert eviction without writing
 *   51 entries.
 */
class Recents(
    ctx: Context,
    prefsName: String = "recents",
    private val maxEntries: Int = 50,
    /**
     * Soft cap on the number of persistable URI grants we keep alive at a
     * time; defaults to [PERSISTABLE_URI_CAP] (480), the spec-mandated
     * 20-grant headroom under Android's ~500 ceiling. Tests override this
     * with a small value (e.g. 3) so the eviction path can be exercised
     * without fabricating 480 entries.
     *
     * The cap is enforced inside [openOrTouch]: when a fresh URI would
     * push the count past `persistableUriCap`, the oldest entry is
     * dropped from the in-memory list AND its grant is released via
     * `ContentResolver.releasePersistableUriPermission` so the OS-side
     * counter drops in lockstep. Skipping the OS-side release would leak
     * the grant — the row would be gone from DataStore but the OS would
     * still count it against our quota.
     */
    private val persistableUriCap: Int = PERSISTABLE_URI_CAP,
) : RecentsApi {
    // We capture only the application context to keep this class safe to
    // hold from any scope (singletons, ViewModels, BroadcastReceivers).
    private val appCtx = ctx.applicationContext

    // DataStore enforces "one active DataStore per file path per process"
    // — instantiating two stores against the same prefs file throws
    // IllegalStateException at first read. In production we'd typically
    // hold a single Recents instance via DI, but production code also
    // routinely re-creates ViewModels (and therefore the wrapper) across
    // process restarts and config changes. We memoise the underlying
    // DataStore by file name in [stores] so multiple Recents wrappers
    // pointing at the same file share one storage object — matching the
    // singleton contract DataStore expects without forcing every caller
    // to thread a DI container through.
    private val store: DataStore<Preferences> = stores.getOrPut(prefsName) {
        PreferenceDataStoreFactory.create(
            scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
            produceFile = { appCtx.preferencesDataStoreFile(prefsName) },
        )
    }

    private val key = stringPreferencesKey("entries_json")

    // Compose-friendly observable view of the list. Subscribers re-render
    // whenever a `recordOpen` or `remove` lands a new write.
    override val flow: Flow<List<RecentEntry>> = store.data.map { prefs ->
        decode(prefs[key])
    }

    /** Snapshot of the current list, most-recent-first. Suspend so the
     *  caller threads through a coroutine instead of blocking the UI. */
    override suspend fun list(): List<RecentEntry> = flow.first()

    /** Returns the entry whose `uri` matches, or null if absent. */
    suspend fun get(uri: String): RecentEntry? = list().firstOrNull { it.uri == uri }

    /**
     * Promote (or insert) `uri` to the front of the list. If `uri` was
     * already present, its prior entry is removed first — this acts as
     * an LRU touch *and* a metadata refresh so a re-open with a renamed
     * displayName / changed safTier picks up the new values.
     *
     * The size cap is applied *after* the new entry is prepended so the
     * tail (oldest) entries fall off, never the head we just wrote.
     */
    override suspend fun recordOpen(uri: String, displayName: String, safTier: SafTier) {
        val now = System.currentTimeMillis()
        store.edit { prefs ->
            val current = decode(prefs[key])
            val without = current.filterNot { it.uri == uri }
            val updated = (listOf(RecentEntry(uri, displayName, now, safTier)) + without)
                .take(maxEntries)
            prefs[key] = json.encodeToString(serializer, updated)
        }
    }

    /**
     * E5: promote (or insert) `uri` and, when the resulting list would
     * cross [persistableUriCap], evict the *oldest* entries (lowest
     * `lastOpenedEpochMs`) AND release their persistable URI grants via
     * [android.content.ContentResolver.releasePersistableUriPermission]
     * so the OS-side counter stays in lockstep with our DataStore.
     *
     * Invariants:
     *   * The entry being inserted is never evicted — the list is sorted
     *     newest-first, then trimmed from the tail.
     *   * `releasePersistableUriPermission` raises `SecurityException` if
     *     we never held the grant (e.g. a transient share-intent URI).
     *     The eviction loop swallows that — the row eviction is the
     *     load-bearing outcome.
     *   * The trim runs *only* when crossing `persistableUriCap`. Below
     *     the cap we pay the same cost as plain [recordOpen] so the
     *     happy path doesn't churn DataStore.
     */
    override suspend fun openOrTouch(uri: String, displayName: String, safTier: SafTier) {
        val now = System.currentTimeMillis()
        val toRelease = mutableListOf<String>()
        store.edit { prefs ->
            val current = decode(prefs[key])
            val without = current.filterNot { it.uri == uri }
            val promoted = listOf(RecentEntry(uri, displayName, now, safTier)) + without

            // Apply the in-memory cap first (same semantics as recordOpen)
            // so we don't carry orphan rows past `maxEntries` even when
            // `persistableUriCap > maxEntries`.
            var trimmed = promoted.take(maxEntries)

            // Then apply the persistable-URI cap, collecting the URIs we
            // need to release outside the `edit { }` closure (release
            // calls do IO and shouldn't run inside the DataStore write).
            if (trimmed.size > persistableUriCap) {
                // Sort newest-first by timestamp, drop the tail. Stable
                // sort keeps insertion-order ties in the same order they
                // were prepended.
                val sortedNewestFirst = trimmed.sortedByDescending { it.lastOpenedEpochMs }
                val keep = sortedNewestFirst.take(persistableUriCap)
                val drop = sortedNewestFirst.drop(persistableUriCap)
                drop.forEach { toRelease += it.uri }
                trimmed = keep
            }

            prefs[key] = json.encodeToString(serializer, trimmed)
        }
        // Release evicted grants outside the DataStore write so a
        // SecurityException from one release doesn't roll back the
        // DataStore mutation. Each release is independent.
        toRelease.forEach { releaseGrant(it) }
    }

    /**
     * Releases both read and write persistable grants on [uriString] if
     * they exist. SecurityException is swallowed because:
     *
     *   * A transient URI never had a persistable grant in the first
     *     place — the eviction is purely in-memory, no leak.
     *   * The OS may have already released the grant on its own (e.g.
     *     after process death + revoked permission) — re-releasing is
     *     a no-op from our perspective.
     */
    private fun releaseGrant(uriString: String) {
        try {
            appCtx.contentResolver.releasePersistableUriPermission(
                Uri.parse(uriString),
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (_: SecurityException) {
            // Grant already absent; row eviction stands.
        }
    }

    /** Drop the entry whose `uri` matches; no-op if absent. */
    suspend fun remove(uri: String) {
        store.edit { prefs ->
            val current = decode(prefs[key])
            val filtered = current.filterNot { it.uri == uri }
            // Skip the write when nothing changed so we don't churn
            // DataStore's flow emissions for collectors.
            if (filtered.size != current.size) {
                prefs[key] = json.encodeToString(serializer, filtered)
            }
        }
    }

    private fun decode(raw: String?): List<RecentEntry> =
        if (raw.isNullOrEmpty()) emptyList() else json.decodeFromString(serializer, raw)

    // ListSerializer is the canonical way to express `List<T>` to
    // kotlinx-serialization without relying on the reified `inline`
    // overloads — those don't compose inside the `edit { prefs -> ... }`
    // closure where the receiver type binds the generic parameter to the
    // wrong target. Cached as a property to avoid rebuilding the descriptor
    // on every read/write.
    private val serializer = ListSerializer(RecentEntry.serializer())

    companion object {
        // Process-wide cache of DataStore instances keyed by file name.
        // ConcurrentHashMap keeps `getOrPut` thread-safe in the face of
        // ViewModel re-creation racing under config changes. Entries are
        // intentionally never evicted — a DataStore lives for the life
        // of the process, mirroring the singleton lifetime of the prefs
        // file underneath it.
        private val stores: java.util.concurrent.ConcurrentHashMap<String, DataStore<Preferences>> =
            java.util.concurrent.ConcurrentHashMap()

        // Android caps persistable URI grants at ~500 (varies by OEM).
        // Leave 20 of headroom so we never trip the SecurityException
        // ("Max number of permissions reached") in normal use. The C5/E5
        // reaper enforces this against the actual permission list; this
        // constant is the policy.
        const val PERSISTABLE_URI_CAP: Int = 480

        // Lenient JSON: ignoreUnknownKeys protects forward-compat when a
        // future schema adds fields we don't yet understand; encodeDefaults
        // keeps every field on disk so a downgrade can still parse.
        private val json: Json = Json {
            ignoreUnknownKeys = true
            encodeDefaults = true
        }
    }
}
