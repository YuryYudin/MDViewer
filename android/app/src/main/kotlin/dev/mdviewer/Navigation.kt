package dev.mdviewer

import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import dev.mdviewer.ui.DocumentScreen
import dev.mdviewer.ui.DocumentViewModel
import dev.mdviewer.ui.DocumentViewModelFactory
import dev.mdviewer.ui.LocalHtmlTheme
import dev.mdviewer.ui.ProfileSetupScreen
import dev.mdviewer.ui.ProfileSetupViewModel
import dev.mdviewer.ui.ProfileSetupViewModelFactory
import dev.mdviewer.ui.RecentsScreen
import dev.mdviewer.ui.RecentsViewModel
import dev.mdviewer.ui.RecentsViewModelFactory
import dev.mdviewer.ui.SettingsScreen
import dev.mdviewer.ui.SettingsViewModel
import dev.mdviewer.ui.SettingsViewModelFactory

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
                // Persist the SAF read grant NOW, while we're still in the
                // composition that received the ACTION_OPEN_DOCUMENT result
                // and the activity-scoped temp grant is still active.
                // Deferring this to DocumentRepository.readDocument breaks
                // on providers like Google Drive's StorageBackend that
                // require an explicitly-persisted grant before serving
                // openInputStream.
                //
                try {
                    ctx.contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION,
                    )
                } catch (_: SecurityException) {
                    // Transient grant; let readDocument's fallback path
                    // handle reporting. The v0.4.16 Toast was a one-shot
                    // diagnostic that's no longer needed now that the
                    // SavedStateHandle URI transport eliminated the
                    // string-roundtrip regression class.
                }
                // v0.4.16: pass the Uri as a Parcelable through
                // SavedStateHandle on the CURRENT back-stack entry. The
                // Document destination picks it up via previousBackStackEntry.
                // This skips the encode-toString/decode-parse round-trip
                // that previously stringified the URI through the route
                // path arg — a subtle canonicalization difference there
                // (especially under MIUI's framework variations) was the
                // remaining suspect for why Drive's provider couldn't
                // reconcile the post-roundtrip URI against its own grant
                // store. Route arg stays as a fallback so the destination
                // composable's signature doesn't change.
                controller.currentBackStackEntry
                    ?.savedStateHandle?.set("pickerUri", uri)
                controller.navigate(
                    Routes.document(android.net.Uri.encode(uri.toString())),
                )
            }
        }
        composable(Routes.Document) { entry ->
            // Prefer the Parcelable URI stashed by the previous destination
            // (RecentsScreen picker callback or MainActivity intent
            // dispatch) — that bypasses the string encode/decode round-trip
            // entirely. Fall back to the route arg for back-stack restore
            // and any future entrypoint that hasn't been migrated.
            val pickedUri: android.net.Uri? = controller.previousBackStackEntry
                ?.savedStateHandle?.get<android.net.Uri>("pickerUri")
            val uri = pickedUri ?: run {
                val encoded = entry.arguments?.getString("uri")
                    ?: return@composable
                android.net.Uri.parse(android.net.Uri.decode(encoded))
            }
            val ctx = LocalContext.current
            // E2: theme is now provided via LocalHtmlTheme by MdviewerApp,
            // which derives it from the persisted SettingsStore preference
            // + system-dark bit. We still pass the resolved HtmlTheme into
            // the ViewModel constructor (so it can stamp the initial
            // Loaded.theme), but the WebView itself reads the live value
            // from the CompositionLocal and dispatches an
            // `evaluateJavascript` swap when it changes — no
            // re-render, no lost scroll position.
            val theme = LocalHtmlTheme.current
            val vm: DocumentViewModel = viewModel(
                factory = DocumentViewModelFactory(ctx, theme),
            )
            DocumentScreen(
                uri = uri,
                vm = vm,
                // E7: gateway to the settings screen — the Compose
                // navigation root holds the controller so DocumentScreen
                // stays NavController-agnostic. The route push back-
                // stacks the document under the settings destination so
                // popping returns to the same scrolled position.
                onOpenSettings = { controller.navigate(Routes.Settings) },
            )
        }
        composable(Routes.Settings) {
            val ctx = LocalContext.current
            val vm: SettingsViewModel = viewModel(
                factory = SettingsViewModelFactory(ctx),
            )
            SettingsScreen(vm) { controller.popBackStack() }
        }
        composable(Routes.ProfileSetup) {
            val ctx = LocalContext.current
            val vm: ProfileSetupViewModel = viewModel(
                factory = ProfileSetupViewModelFactory(ctx),
            )
            // E1: tapping Continue or Skip persists a profile and routes to
            // Recents. We popUpTo(ProfileSetup, inclusive = true) so Back
            // from Recents exits the activity rather than re-entering the
            // setup screen — once the profile is initialised the user
            // should never see this surface again on this install.
            ProfileSetupScreen(vm) {
                controller.navigate(Routes.Recents) {
                    popUpTo(Routes.ProfileSetup) { inclusive = true }
                }
            }
        }
    }
}
