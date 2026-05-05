package dev.mdviewer.e2e.helpers

import android.net.Uri

/**
 * Stages the `sample.md` androidTest asset as a `content://` URI so the
 * Drive ACTION_VIEW + in-app picker specs can hand the runner a real URI
 * the system can resolve.
 *
 * **B5 contract:** stub-only. The real implementation (lands in C5) will
 * copy the asset to a `FileProvider`-backed cache and return the resulting
 * `content://dev.mdviewer.test.fileprovider/...` URI. Until then the method
 * throws so emulator runs of the e2e specs fail loudly rather than silently
 * misbehaving on a `null` URI.
 */
object SampleAssets {
    /**
     * Returns a `content://` URI pointing at the staged `sample.md`. Callers
     * are responsible for granting `FLAG_GRANT_READ_URI_PERMISSION` on any
     * Intent that carries the URI (the framework does not infer it from the
     * provider definition).
     */
    fun stageSampleMarkdownAsContentUri(): Uri =
        throw NotImplementedError("SampleAssets.stageSampleMarkdownAsContentUri lands in C5")
}
