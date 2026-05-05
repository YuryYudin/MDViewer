package dev.mdviewer.e2e.helpers

/**
 * Mutates the on-disk sidecar between document opens so the manual-reload
 * spec can simulate a desktop edit landing while Android is on the same
 * file.
 *
 * **B5 contract:** stub-only. Real implementation lands in E5 alongside
 * `ReloadAction` + `merge_stores` plumbing. The fixture file content lives
 * under `androidTest/assets/reload-with-extra-thread.md.comments.json` and
 * is copy-on-write installed into the same directory the foreground
 * `DocumentRepository` is reading from.
 */
object ReloadFixtures {
    /**
     * Overwrites the active sidecar with `reload-with-extra-thread.md.comments.json`,
     * adding one new thread (id `t-reload-2`) at a freshly anchored location.
     */
    fun replaceSidecarWithExtraThreadFixture(): Unit =
        throw NotImplementedError(
            "ReloadFixtures.replaceSidecarWithExtraThreadFixture lands in E5",
        )
}
