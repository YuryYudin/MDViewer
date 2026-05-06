// ---------------------------------------------------------------------------
// DriveNudgeCard — empty-state instructional card explaining the canonical
// Drive entry-point: `Open with -> MDViewer`. Mirrors the copy in
// `wireframes/01-startup-empty.html` and is asserted against by the e2e
// `empty_recents_after_profile_setup_shows_fab_and_drive_nudge` spec.
//
// Behavior contract:
//   * Renders ONLY when [RecentsScreen] is in the empty state. Populated
//     recents replace it — clutter on a populated screen is hostile per
//     the E5 spec's "Avoid" section.
//   * Contains the "Open with" + "MDViewer" instructional substring the
//     e2e + unit tests both lock against. A future restyle that strips
//     these strings will fail the e2e too — keep them load-bearing.
//   * No tap handler in v1: this is purely an instructional card. We do
//     NOT recommend a Play Store install link because Drive is preinstalled
//     on virtually every Android device with Google Mobile Services, and
//     the link would dead-end on devices without GMS. (See E5 spec.)
//   * `Modifier.testTag(Placeholders.DRIVE_NUDGE_TAG)` is applied so the
//     e2e suite has a stable handle even if the user-visible copy ever
//     gets relocalised.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.mdviewer.Placeholders

/**
 * Empty-state nudge that explains the canonical Drive entry-point:
 * `Open with -> MDViewer` from the Drive app. Mirrors the copy in
 * `wireframes/01-startup-empty.html`.
 *
 * Only renders when recents is empty; populated recents replace it.
 */
@Composable
fun DriveNudgeCard(modifier: Modifier = Modifier) {
    OutlinedCard(
        modifier = modifier
            .fillMaxWidth()
            .testTag(Placeholders.DRIVE_NUDGE_TAG),
    ) {
        Column(
            Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                "Reading from Drive?",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                "In the Drive app, long-press a .md file and choose " +
                    "\"Open with -> MDViewer\". The file shows up here next time, " +
                    "with comments saved in the same Drive folder.",
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
