package dev.mdviewer.core

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertTrue
import kotlin.test.assertEquals

/**
 * JVM smoke test that exercises the UniFFI-generated Kotlin bindings
 * against the host build of `mdviewer-jni`. The point isn't to retest
 * the renderer or sidecar logic (Rust unit tests in `mdviewer-core`
 * cover that) — it's to prove that:
 *
 *   1. The UDL -> Kotlin codegen ran (`renderMarkdown`, `RenderOptions`,
 *      `loadSidecarBytes`, `saveSidecarBytes`, `sidecarFilename` exist
 *      under `dev.mdviewer.core`).
 *   2. The host `.so` is loadable from the JVM (`UnsatisfiedLinkError`
 *      would point at a JNA / library-path mismatch, not at the
 *      Kotlin / Rust API itself).
 *   3. Round-tripping bytes through `loadSidecarBytes` -> `saveSidecarBytes`
 *      preserves the thread snapshot length, proving the opaque
 *      `CommentsStoreHandle` survives the FFI boundary.
 *
 * The Android-cross-compiled `.so` files live in the AAR and are
 * exercised via instrumentation tests on a real device (Phase E2E).
 *
 * ## Why Robolectric
 *
 * `crates/mdviewer-core/uniffi.toml` sets `android_cleaner = true` so
 * the generated Kotlin code imports `android.os.Build` and uses its
 * `VERSION.SDK_INT` constant to pick a cleanup strategy. That import
 * is unresolved on a plain JVM classpath; Robolectric provides a
 * shadow Android framework so the bindings load on the host without
 * needing a second `android_cleaner = false` UDL pass.
 *
 * ## Why we override the library
 *
 * UniFFI's Kotlin runtime calls `Native.load("mdviewer_jni", …)` which
 * normally looks up `libmdviewer_jni.so` from `java.library.path`. The
 * Gradle script copies the host build of `libmdviewer_jni.so` into the
 * test resources and surfaces its directory via the `jna.library.path`
 * system property; JNA prepends that to its search path before falling
 * back to the OS library path.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class UniffiSmokeTest {
    @Test
    fun render_markdown_returns_html() {
        val result = renderMarkdown(
            source = "# Hello",
            opts = RenderOptions(syntaxHighlighting = false, mermaidEnabled = false),
        )
        assertTrue(result.html.contains("<h1"), "expected <h1 in: ${result.html}")
    }

    @Test
    fun load_then_save_round_trips_empty_sidecar() {
        val store = loadSidecarBytes(ByteArray(0))
        val bytes = saveSidecarBytes(store)
        val restored = loadSidecarBytes(bytes)
        assertEquals(store.threads().size, restored.threads().size)
    }

    @Test
    fun sidecar_filename_default_pattern() {
        assertEquals(
            "notes.md.comments.json",
            sidecarFilename("notes.md", "{name}.md.comments.json"),
        )
    }
}
