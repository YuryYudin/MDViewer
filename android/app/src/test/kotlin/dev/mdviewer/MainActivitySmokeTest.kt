package dev.mdviewer

import dev.mdviewer.core.RenderOptions
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * JVM smoke test that proves the MdviewerCore UniFFI facade — re-exposed
 * via the `:core` AAR — is reachable from the `:app` module's classpath.
 *
 * Scope is intentionally narrow: this test does NOT load the host
 * `libmdviewer_jni.so`. The `:core` module's [dev.mdviewer.core.UniffiSmokeTest]
 * is the canonical place where the host build path, JNA library
 * resolution, and the Rust ↔ Kotlin round-trip are exercised end-to-end.
 * Doing the same work here would force `:app` to wire `jna.library.path`
 * just to re-run a check that already passes one module away.
 *
 * What we DO assert:
 *   1. The generated Kotlin types from `mdviewer_core.udl` (e.g.
 *      [RenderOptions]) are visible under the `dev.mdviewer.core`
 *      package on `:app`'s classpath. If the AAR wiring drops in a
 *      future refactor, instantiating one of these data classes
 *      blows up at compile time, not at runtime on a real device.
 *   2. The top-level binding functions (`renderMarkdown`,
 *      `loadSidecarBytes`, `saveSidecarBytes`, `sidecarFilename`)
 *      resolve via reflection on the generated `Mdviewer_coreKt`
 *      facade class. `Class.forName` failing here would mean R8 /
 *      AGP packaging dropped the bindings.
 */
class MainActivitySmokeTest {

    @Test
    fun render_options_data_class_is_reachable() {
        // Constructing the data class proves the Kotlin compile saw the
        // generated bindings; field access proves they survived to the
        // test classpath rather than being filtered out as `apiLevel`-
        // gated stubs.
        val opts = RenderOptions(syntaxHighlighting = false, mermaidEnabled = false)
        assertEquals(false, opts.syntaxHighlighting)
        assertEquals(false, opts.mermaidEnabled)
    }

    @Test
    fun core_top_level_functions_are_visible_on_classpath() {
        // UniFFI emits top-level Kotlin functions into a synthetic
        // `<UdlName>Kt` class; we look it up by FQN and assert each
        // expected entry point exists. Using reflection (rather than
        // calling the function) avoids triggering `Native.load`, which
        // would need the host `.so` on `jna.library.path` — that's
        // :core's smoke job.
        val facade = Class.forName("dev.mdviewer.core.Mdviewer_coreKt")
        val names = facade.declaredMethods.map { it.name }.toSet()
        assertTrue(
            names.containsAll(
                listOf(
                    "renderMarkdown",
                    "loadSidecarBytes",
                    "saveSidecarBytes",
                    "sidecarFilename",
                ),
            ),
            "expected all UniFFI entry points; saw: $names",
        )
    }
}
