package dev.mdviewer

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Sanity gate for the androidTest source set.
 *
 * The 10 e2e specs from A1 stay RED at runtime (they reference screens that
 * don't exist yet). This test is the trivial-but-passing companion that
 * proves the runner, the AndroidJUnit4 wiring, and the target-context
 * resolution are intact end-to-end. Once the C/D/E phases land, this test
 * becomes redundant — but until then it's the only assertion the
 * `connectedDebugAndroidTest` task can succeed on, and CI uses that signal
 * to gate the runner itself.
 */
@RunWith(AndroidJUnit4::class)
class PlaceholderInstrumentationTest {
    @Test
    fun app_package_is_dev_mdviewer() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("dev.mdviewer", ctx.packageName)
    }
}
