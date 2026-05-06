// ---------------------------------------------------------------------------
// ThemeController — derives a concrete [HtmlTheme] from the persisted
// [SettingsStore.theme] preference and the device's system-dark setting.
//
// The controller lives in the UI layer so the data layer's [ThemeMode]
// enum (Light / Dark / FollowSystem) can stay Compose-free. Compose-side
// surfaces (MdviewerApp's MaterialTheme wrapper, MarkdownWebView's
// `data-theme` attribute) consume the resolved [HtmlTheme] directly.
//
// Why a Composable function rather than a long-lived object:
//   * The "follow system" branch needs Compose's `isSystemInDarkTheme()`
//     observable so a system-theme flip recomposes the tree without a
//     manual subscription. A plain `object ThemeController` would have
//     to reach for ConfigurationCompat / a BroadcastReceiver to learn
//     about system-theme changes, both of which are awkward to wire
//     and don't survive Compose previews.
//   * The flow-side reactivity (the persisted setting) is identical to
//     every other Compose-observed Flow in the app — `collectAsState` is
//     the canonical path.
//
// Why we expose `LocalHtmlTheme` rather than passing the theme through
// every call site:
//   * The Document screen renders inside a NavHost composable that has
//     its own ViewModel scope. Threading the theme as a parameter from
//     MainActivity through Navigation through DocumentScreen down into
//     MarkdownWebView would require N+1 composable signature changes
//     for any future theme-consuming surface. CompositionLocal is the
//     idiomatic Compose answer for "ambient" values like this.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.data.ThemeMode
import dev.mdviewer.render.HtmlTheme

/**
 * Resolve the persisted [ThemeMode] from [settings] against [systemDark]
 * (the device's current dark-mode bit) into a concrete [HtmlTheme]. The
 * resolved value re-emits whenever either input changes; Compose-side
 * consumers re-render automatically.
 *
 * @param settings reactive store of the user's persisted theme choice.
 * @param systemDark whether the device is currently in dark mode. Pass
 *                   Compose's [isSystemInDarkTheme] result; a non-Compose
 *                   call site can substitute its own boolean source.
 */
@Composable
fun rememberHtmlTheme(settings: SettingsStore, systemDark: Boolean): HtmlTheme {
    // collectAsState defaults to FollowSystem — the same fallback the
    // SettingsStore Flow uses for unrecognised values. This keeps the
    // first-frame render consistent with what a fresh-install user
    // would see.
    val mode by settings.theme.collectAsState(initial = ThemeMode.FollowSystem)
    return when (mode) {
        ThemeMode.Light -> HtmlTheme.Light
        ThemeMode.Dark -> HtmlTheme.Dark
        ThemeMode.FollowSystem -> if (systemDark) HtmlTheme.Dark else HtmlTheme.Light
    }
}

/**
 * Composition-scoped handle on the resolved [HtmlTheme]. Surfaces deep in
 * the tree (DocumentScreen -> MarkdownWebView) read this rather than
 * threading the theme through every parent composable.
 *
 * Default is [HtmlTheme.Light] so a preview / test that mounts a
 * composable without wrapping it in `MdviewerApp { ... }` still renders.
 * Production code always provides a value through MdviewerApp's
 * CompositionLocalProvider.
 */
val LocalHtmlTheme = compositionLocalOf { HtmlTheme.Light }
