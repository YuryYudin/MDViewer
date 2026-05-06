package dev.mdviewer

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.ui.LocalHtmlTheme
import dev.mdviewer.ui.rememberHtmlTheme

/**
 * Top-level Material3 theme wrapper.
 *
 * E2 widens this to take a [SettingsStore] so the persisted theme
 * preference (Light / Dark / FollowSystem) drives both Compose's
 * [MaterialTheme] AND the WebView's `data-theme` body attribute via
 * [LocalHtmlTheme]. The `MarkdownWebView` reads the latter from a
 * [LaunchedEffect] keyed on the theme value and calls
 * `evaluateJavascript("document.body.dataset.theme = '...'")` so a theme
 * change applies without re-rendering (no scroll-position loss).
 *
 * Why we resolve `HtmlTheme` once at this level rather than re-resolving
 * inside DocumentScreen:
 *   * Both the Compose color scheme (light/dark Material colors) and the
 *     WebView CSS class need to agree on the same "dark or light" answer
 *     — resolving twice (here and again in the screen) risks them
 *     drifting if the SettingsStore flow emits at different recomposition
 *     boundaries.
 *   * The CompositionLocal makes the resolved value ambient so any
 *     surface deep in the tree can read it without parameter threading.
 */
@Composable
fun MdviewerApp(settings: SettingsStore, content: @Composable () -> Unit) {
    val systemDark = isSystemInDarkTheme()
    val htmlTheme = rememberHtmlTheme(settings, systemDark)
    val scheme = if (htmlTheme == HtmlTheme.Dark) darkColorScheme() else lightColorScheme()
    MaterialTheme(colorScheme = scheme) {
        CompositionLocalProvider(LocalHtmlTheme provides htmlTheme) {
            content()
        }
    }
}
