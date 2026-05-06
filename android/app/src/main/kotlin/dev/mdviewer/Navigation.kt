package dev.mdviewer

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.ui.DocumentScreen
import dev.mdviewer.ui.DocumentViewModel
import dev.mdviewer.ui.DocumentViewModelFactory
import dev.mdviewer.ui.RecentsScreen
import dev.mdviewer.ui.RecentsViewModel
import dev.mdviewer.ui.RecentsViewModelFactory

/**
 * Compose Navigation route registry.
 *
 * Phase B only stubs the destinations so MainActivity has a non-empty
 * NavGraph to mount. Phase C5 swaps Recents and Document for the real
 * screens; Settings and ProfileSetup remain placeholders until D7 / E1.
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
 * Mounts the NavHost.
 *
 * Recents and Document are real screens (C5); Settings and ProfileSetup
 * stay as placeholder Text nodes — they land in D7 / E1 respectively.
 * The placeholder pattern is intentional: any accidental regression in
 * navigation wiring fails loud during manual smoke runs because the
 * placeholder Text contradicts the screen the user asked for.
 *
 * ViewModels are instantiated through small factories ([RecentsViewModelFactory],
 * [DocumentViewModelFactory]) so the Context-bound dependencies (Recents,
 * DocumentRepository) get resolved without leaking the activity through
 * a long-lived ViewModel field.
 */
@Composable
fun MdviewerNavHost(controller: NavHostController, startDestination: String) {
    NavHost(navController = controller, startDestination = startDestination) {
        composable(Routes.Recents) {
            val ctx = LocalContext.current
            val vm: RecentsViewModel = viewModel(
                factory = RecentsViewModelFactory(ctx),
            )
            RecentsScreen(vm) { uri ->
                controller.navigate(
                    Routes.document(android.net.Uri.encode(uri.toString())),
                )
            }
        }
        composable(Routes.Document) { entry ->
            val encoded = entry.arguments?.getString("uri") ?: return@composable
            val uri = android.net.Uri.parse(android.net.Uri.decode(encoded))
            val ctx = LocalContext.current
            // Resolve the system theme to a concrete HtmlTheme at the
            // call site so the ViewModel never has to depend on Compose
            // for the theme bit. Settings overrides arrive in D7.
            val theme = if (isSystemInDarkTheme()) HtmlTheme.Dark else HtmlTheme.Light
            val vm: DocumentViewModel = viewModel(
                factory = DocumentViewModelFactory(ctx, theme),
            )
            DocumentScreen(uri, vm)
        }
        composable(Routes.Settings) { Text("Settings (placeholder)") }
        composable(Routes.ProfileSetup) { Text("Profile setup (placeholder)") }
    }
}
