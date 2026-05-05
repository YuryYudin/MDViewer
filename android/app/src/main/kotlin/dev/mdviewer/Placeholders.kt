package dev.mdviewer

/**
 * Stable view-tag identifiers the e2e specs (Phase A1) reference symbolically.
 *
 * The specs were written before the screens that own these widgets — Phase
 * C/D/E will add `Modifier.testTag(Placeholders.FAB_OPEN_FILE_TAG)` to the
 * actual Composables. Pinning the strings here means the e2e specs and the
 * production Composables share a single source of truth: rename the constant
 * and both call sites move together.
 *
 * Keep this surface tiny. Only add a constant when there's an existing test
 * that can't unambiguously target a node by text or content-description; tag
 * proliferation is a bad smell in Compose UI tests.
 */
object Placeholders {
    /** Test tag for the "Open file" FAB on the Recents screen. */
    const val FAB_OPEN_FILE_TAG = "fab_open_file"

    /** Test tag for the "Connect Drive" nudge banner on the Recents screen. */
    const val DRIVE_NUDGE_TAG = "drive_nudge"
}
