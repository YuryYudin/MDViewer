package dev.mdviewer.e2e.helpers

import androidx.compose.ui.test.junit4.AndroidComposeTestRule

/**
 * High-level e2e helpers that drive the document screen.
 *
 * **B5 contract:** stub-only. See [ResetState] for the rule-5 rationale.
 * Each method throws so runtime callers get a clear "not yet implemented"
 * signal while the source set still compiles. The signatures are pinned by
 * the A1 e2e specs and must not drift; landing the real implementations in
 * Phase C/D/E should be a body-only change.
 *
 * The compose-rule type uses a star projection because the specs construct
 * it via `createAndroidComposeRule<MainActivity>()`, but we don't want a
 * dependency on `MainActivity`'s exact generic shape leaking out of the
 * helper. Star-projection-of-star is the only signature that takes any
 * concrete `AndroidComposeTestRule<*, *>` produced by that factory.
 */
object DocumentTestHarness {
    /** Opens `sample.md` with the canonical existing-thread sidecar. */
    fun openSampleWithExistingSidecar(rule: AndroidComposeTestRule<*, *>): Unit =
        throw NotImplementedError("DocumentTestHarness.openSampleWithExistingSidecar lands in C5")

    /** Opens `sample.md` with no sidecar present (zero existing threads). */
    fun openSampleWithoutSidecar(rule: AndroidComposeTestRule<*, *>): Unit =
        throw NotImplementedError("DocumentTestHarness.openSampleWithoutSidecar lands in C5")

    /**
     * Opens `sample.md` with a sidecar containing one open thread and one
     * resolved thread — the fixture the comments-list filter test exercises.
     */
    fun openSampleWithMixedOpenAndResolvedThreads(rule: AndroidComposeTestRule<*, *>): Unit =
        throw NotImplementedError(
            "DocumentTestHarness.openSampleWithMixedOpenAndResolvedThreads lands in D4",
        )

    /** Long-press-selects the first paragraph of the rendered body. */
    fun longPressSelectFirstParagraph(rule: AndroidComposeTestRule<*, *>): Unit =
        throw NotImplementedError(
            "DocumentTestHarness.longPressSelectFirstParagraph lands in D2",
        )

    /** Dismisses any open thread sheet (sidebar or bottom sheet variant). */
    fun dismissThreadSheet(rule: AndroidComposeTestRule<*, *>): Unit =
        throw NotImplementedError("DocumentTestHarness.dismissThreadSheet lands in D3")

    /** Pops the back stack until the Recents screen is the top destination. */
    fun navigateBackToRecents(rule: AndroidComposeTestRule<*, *>): Unit =
        throw NotImplementedError("DocumentTestHarness.navigateBackToRecents lands in C4")

    /**
     * Drives the popover -> compose -> Post flow to land a brand-new local
     * thread on the currently-open document.
     */
    fun postLocalThread(rule: AndroidComposeTestRule<*, *>, body: String): Unit =
        throw NotImplementedError("DocumentTestHarness.postLocalThread lands in D3")
}
