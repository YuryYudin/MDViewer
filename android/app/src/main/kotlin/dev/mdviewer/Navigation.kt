package dev.mdviewer

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable

/**
 * Compose Navigation route registry.
 *
 * Phase B only stubs the destinations so MainActivity has a non-empty
 * NavGraph to mount. Phase C swaps each placeholder for the real
 * screen (RecentsScreen, DocumentScreen, SettingsScreen,
 * ProfileSetupScreen). Keeping the route literals here lets the
 * Phase A1 e2e tests reference them before screens exist — they
 * compile but stay RED until C lands.
 */
object Routes {
    const val Recents = "recents"

    /**
     * Document route carries the SAF URI as a path argument. Callers
     * MUST URL-encode the URI; see [document] for the canonical
     * builder.
     */
    const val Document = "document/{uri}"
    const val Settings = "settings"
    const val ProfileSetup = "profile_setup"

    /**
     * Build a navigable route to the document screen for a given
     * already-encoded URI. The encoding step belongs to the caller
     * because the URI source — system intent vs. SAF picker vs.
     * Recents tap — knows whether it already escaped slashes.
     */
    fun document(encodedUri: String): String = "document/$encodedUri"
}

/**
 * Mounts the placeholder NavHost. The real screen Composables land in
 * Phase C / D / E; we keep the placeholders deliberately stupid (just
 * a Text node naming the destination) so any accidental regression in
 * navigation wiring fails loud during manual smoke runs.
 */
@Composable
fun MdviewerNavHost(controller: NavHostController, startDestination: String) {
    NavHost(navController = controller, startDestination = startDestination) {
        composable(Routes.Recents) { Text("Recents (placeholder)") }
        composable(Routes.Document) { Text("Document (placeholder)") }
        composable(Routes.Settings) { Text("Settings (placeholder)") }
        composable(Routes.ProfileSetup) { Text("Profile setup (placeholder)") }
    }
}
