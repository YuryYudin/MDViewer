// ---------------------------------------------------------------------------
// SettingsStoreTest — pins the desktop-matching defaults for the three
// user-facing preferences (theme, sidecar pattern, show-resolved) and
// verifies suspend writes round-trip through the DataStore.
//
// The defaults matter: when a fresh install opens its first document, the
// SettingsStore is the single source of truth for sidecar resolution and
// theme. A drift here ripples into every other Phase C-E surface, so we
// pin them explicitly rather than reading from a constant that might
// change underneath the test.
// ---------------------------------------------------------------------------
package dev.mdviewer.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals

@RunWith(AndroidJUnit4::class)
class SettingsStoreTest {
    private val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun newStore(): SettingsStore =
        SettingsStore(ctx, prefsName = "settings-test-${System.nanoTime()}")

    @Test
    fun defaults_match_desktop() = runTest {
        val s = newStore()
        assertEquals(ThemeMode.FollowSystem, s.theme.first())
        assertEquals("{name}.md.comments.json", s.sidecarPattern.first())
        assertEquals(false, s.showResolved.first())
    }

    @Test
    fun theme_round_trips_dark() = runTest {
        val s = newStore()
        s.setTheme(ThemeMode.Dark)
        assertEquals(ThemeMode.Dark, s.theme.first())
    }

    @Test
    fun theme_round_trips_light() = runTest {
        val s = newStore()
        s.setTheme(ThemeMode.Light)
        assertEquals(ThemeMode.Light, s.theme.first())
    }

    @Test
    fun theme_round_trips_back_to_follow_system() = runTest {
        val s = newStore()
        s.setTheme(ThemeMode.Dark)
        s.setTheme(ThemeMode.FollowSystem)
        assertEquals(ThemeMode.FollowSystem, s.theme.first())
    }

    @Test
    fun sidecar_pattern_round_trips_custom_value() = runTest {
        val s = newStore()
        s.setSidecarPattern(".comments/{name}.json")
        assertEquals(".comments/{name}.json", s.sidecarPattern.first())
    }

    @Test
    fun show_resolved_round_trips_true() = runTest {
        val s = newStore()
        s.setShowResolved(true)
        assertEquals(true, s.showResolved.first())
    }

    @Test
    fun show_resolved_round_trips_false_after_true() = runTest {
        val s = newStore()
        s.setShowResolved(true)
        s.setShowResolved(false)
        assertEquals(false, s.showResolved.first())
    }

    @Test
    fun unknown_theme_string_falls_back_to_follow_system() = runTest {
        // Defensive: if a future migration writes a theme value we don't
        // recognise (or if the on-disk file is hand-edited), the Flow
        // should fall back to FollowSystem rather than throwing — that
        // matches the desktop's permissive parsing behaviour.
        val s = newStore()
        s.setThemeRaw("totally-unknown-mode")
        assertEquals(ThemeMode.FollowSystem, s.theme.first())
    }

    @Test
    fun settings_survive_new_store_instance() = runTest {
        val name = "settings-persist-${System.nanoTime()}"
        val s1 = SettingsStore(ctx, prefsName = name)
        s1.setTheme(ThemeMode.Dark)
        s1.setSidecarPattern("custom-{name}.json")
        s1.setShowResolved(true)
        val s2 = SettingsStore(ctx, prefsName = name)
        assertEquals(ThemeMode.Dark, s2.theme.first())
        assertEquals("custom-{name}.json", s2.sidecarPattern.first())
        assertEquals(true, s2.showResolved.first())
    }
}
