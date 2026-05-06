// ---------------------------------------------------------------------------
// ManifestGoldenTest — pin the MainActivity intent-filter set against a
// golden captured from `aapt2 dump xmltree` over the assembled APK.
//
// What this guards:
//   * Accidental drops of one of the two ACTION_VIEW filters (the
//     `text/markdown` clean path OR the `*/*` + path-pattern fallback).
//     A reflexive copy-paste edit could remove the second filter and the
//     manifest would still parse — but Drive's behavior matters here:
//     Drive sends `*/*` for `.md` files most of the time, so dropping
//     the wildcard arm breaks the open-from-Drive flow silently.
//   * A future maintainer adding an ACTION_SEND filter (E3) to the same
//     activity will cause this test to fail until the golden is updated.
//     The test failure is the prompt to think about whether the new
//     filter changed any of the existing behavior.
//
// What this does NOT guard:
//   * The dispatcher's runtime decisions — those are in
//     IntentDispatcherTest. The manifest is hint-level; the resolver is
//     the actual gate.
//
// Skip-on-precondition strategy: this test runs as part of `:app:testDebugUnitTest`
// but unit tests do NOT depend on `:app:assembleDebug`. If the APK isn't
// built yet (clean dev box, or someone running just unit tests) the test
// is `Assume`d away rather than failing — the verification command in
// the plan runs assembleDebug first, so CI always exercises the gate.
//
// aapt2 discovery: SDK location comes from `local.properties` -> `sdk.dir`,
// or from ANDROID_HOME/ANDROID_SDK_ROOT env vars (matches AGP's resolver).
// We probe `build-tools/<latest>/aapt2`. If aapt2 isn't found anywhere,
// the test fails loudly with a remediation hint — silent skipping there
// would let a CI runner without build-tools sneak past the gate.
// ---------------------------------------------------------------------------
package dev.mdviewer

import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.Properties
import kotlin.test.assertEquals

class ManifestGoldenTest {

    @Test
    fun main_activity_intent_filter_set_matches_golden() {
        val apk = locateDebugApk() ?: run {
            assumeTrue(
                "Debug APK not built; run :app:assembleDebug to exercise this gate.",
                false,
            )
            return
        }
        val aapt2 = locateAapt2()
            ?: error(
                "aapt2 not found under sdk.dir/build-tools or ANDROID_SDK_ROOT. " +
                    "Either install build-tools or pin sdk.dir in local.properties.",
            )

        val xmltree = ProcessBuilder(
            aapt2.absolutePath,
            "dump",
            "xmltree",
            apk.absolutePath,
            "--file",
            "AndroidManifest.xml",
        ).redirectErrorStream(true).start().let { proc ->
            val out = proc.inputStream.bufferedReader().readText()
            check(proc.waitFor() == 0) { "aapt2 dump xmltree failed:\n$out" }
            out
        }

        val actual = extractMainActivitySection(xmltree)
        val golden = javaClass.classLoader!!
            .getResource("manifest-goldens.xml")!!
            .readText()
            .trimEnd()

        assertEquals(
            golden,
            actual.trimEnd(),
            "MainActivity intent-filter set drifted from golden. " +
                "If the change is intentional, regenerate the golden via:\n" +
                "  aapt2 dump xmltree app/build/outputs/apk/debug/app-debug.apk " +
                "--file AndroidManifest.xml | (extract MainActivity section)",
        )
    }

    /**
     * Strip line numbers (`(line=NN)`) and slice from the MainActivity
     * activity element to the next sibling activity. Line numbers track
     * positions in the source manifest, which can shift if a comment is
     * added higher up; the golden therefore captures only the structure +
     * attribute values.
     */
    private fun extractMainActivitySection(xmltree: String): String {
        val lines = xmltree.lines().map { it.replace(Regex(" \\(line=\\d+\\)"), "") }
        val startIdx = lines.indexOfFirst { it.contains("E: activity") } - 0
        // The first activity element after the application open is MainActivity
        // (other activities — AppAuth, Compose Preview — are merged in below).
        // Walk forward until the first activity whose name attribute is
        // dev.mdviewer.MainActivity, then slice through to the next
        // sibling activity.
        var mainStart = -1
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (line.trimStart().startsWith("E: activity") &&
                i + 1 < lines.size &&
                lines[i + 1].contains("\"dev.mdviewer.MainActivity\"")
            ) {
                mainStart = i
                break
            }
            i++
        }
        check(mainStart >= 0) { "MainActivity not found in xmltree:\n$xmltree" }

        // Find the next sibling activity at the same indentation level.
        val mainIndent = lines[mainStart].takeWhile { it == ' ' }.length
        var mainEnd = lines.size
        for (j in (mainStart + 1) until lines.size) {
            val l = lines[j]
            val indent = l.takeWhile { it == ' ' }.length
            if (indent == mainIndent && l.trimStart().startsWith("E: ")) {
                mainEnd = j
                break
            }
        }
        return lines.subList(mainStart, mainEnd).joinToString("\n")
    }

    private fun locateDebugApk(): File? {
        // The :app module sits at android/app/. The unit test's CWD is
        // android/app/ when Gradle runs it (per AGP convention), so the
        // APK lives under build/outputs/apk/debug/.
        val candidates = listOf(
            File("build/outputs/apk/debug/app-debug.apk"),
            File("app/build/outputs/apk/debug/app-debug.apk"),
        )
        return candidates.firstOrNull { it.exists() }?.absoluteFile
    }

    private fun locateAapt2(): File? {
        val sdk = sdkRoot() ?: return null
        val buildTools = File(sdk, "build-tools")
        if (!buildTools.isDirectory) return null
        // Pick the highest version subdirectory that has aapt2 in it.
        val versions = buildTools.listFiles()?.filter { it.isDirectory }.orEmpty()
            .sortedByDescending { it.name }
        return versions.asSequence()
            .map { File(it, "aapt2") }
            .firstOrNull { it.canExecute() }
    }

    private fun sdkRoot(): File? {
        // Try local.properties first (matches AGP's resolver order).
        // The unit test runs with CWD = android/app, so walk up to find
        // the closest local.properties — that's what the IDE uses too.
        val cwd = File(System.getProperty("user.dir"))
        var here: File? = cwd
        while (here != null) {
            val props = File(here, "local.properties")
            if (props.isFile) {
                val sdk = Properties().apply { props.inputStream().use { load(it) } }["sdk.dir"]
                if (sdk is String && sdk.isNotBlank()) {
                    val f = File(sdk)
                    if (f.isDirectory) return f
                }
            }
            here = here.parentFile
        }
        // Fall back to env vars.
        listOf("ANDROID_HOME", "ANDROID_SDK_ROOT").forEach { name ->
            val v: String? = System.getenv(name)
            if (v != null && File(v).isDirectory) return File(v)
        }
        return null
    }
}
