package dev.mdviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.navigation.compose.rememberNavController
import dev.mdviewer.data.ProfileStore
import dev.mdviewer.data.SettingsStore
import kotlinx.coroutines.runBlocking

/**
 * Single-activity host. The design spec is explicit that the Android
 * client is one Activity + a Compose NavHost — multi-activity stacks
 * make the popover / sheet hand-off in Phase D harder, and they
 * complicate ACTION_VIEW intent dispatch (each duplicate filter would
 * need its own activity-alias).
 *
 * Cold-start sequence (C6):
 *   1. Read whether a profile has been persisted via [ProfileStore]. The
 *      read is synchronous on the main thread; see the `runBlocking`
 *      note below for why that's acceptable.
 *   2. Hand the launch intent + profile bit to [IntentDispatcher.resolve]
 *      to compute a [NavDestination].
 *   3. Translate the destination into a Compose-Navigation route string
 *      and pass it as the NavHost's `startDestination`.
 *
 * Why not deep-link the URI through Navigation arguments instead of
 * baking it into the start route: the start-destination route is the
 * stable handle Compose's NavController uses for back-stack
 * provisioning. If we used `controller.navigate()` after first composition
 * to push the document, hitting "back" would land the user on whatever
 * the placeholder start was (Recents) — not on the cold-start surface
 * the user expected. Passing the route as `startDestination` makes Back
 * exit the activity directly, which is the desktop-equivalent behavior.
 *
 * About `runBlocking { ProfileStore(applicationContext).isInitialized() }`:
 * DataStore-Preferences reads on cold start are dominated by file IO
 * (sub-millisecond when the prefs file is in the FS cache, single-digit
 * ms otherwise). The dispatcher needs the answer synchronously to pick
 * the start route — switching to a splash-with-loading pattern just to
 * avoid the runBlocking adds an extra Compose recomposition cycle for
 * no user-visible benefit. v2 (cloud-comments + dynamic theming) might
 * revisit this; v1 keeps it simple.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val hasProfile = runBlocking {
            ProfileStore(applicationContext).isInitialized()
        }
        val destination = IntentDispatcher.resolve(intent, hasProfile)
        val startRoute = routeFor(destination)

        // E2: hand the SettingsStore to MdviewerApp so the persisted
        // theme drives both MaterialTheme and the WebView CSS swap. We
        // share a single instance per Activity — the SettingsStore's
        // process-wide cache (keyed by prefsName) means a second
        // construction at any other call site returns the same backing
        // DataStore, but capturing once avoids redundant init plumbing.
        val settings = SettingsStore(applicationContext)

        setContent {
            MdviewerApp(settings) {
                val nav = rememberNavController()
                MdviewerNavHost(controller = nav, startDestination = startRoute)
            }
        }
    }

    /**
     * Translate the dispatcher's [NavDestination] into a Compose-
     * Navigation route. The Document case URL-encodes the URI to keep
     * SAF's `content://authority/document/...` slashes from being parsed
     * as path separators by the route matcher.
     */
    private fun routeFor(destination: NavDestination): String = when (destination) {
        is NavDestination.Document ->
            Routes.document(android.net.Uri.encode(destination.uri.toString()))
        NavDestination.ProfileSetup -> Routes.ProfileSetup
        NavDestination.Recents -> Routes.Recents
    }
}
