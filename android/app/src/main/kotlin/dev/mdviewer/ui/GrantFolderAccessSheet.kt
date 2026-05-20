// ---------------------------------------------------------------------------
// GrantFolderAccessSheet — Material 3 modal bottom-sheet that asks the user
// to grant ACTION_OPEN_DOCUMENT_TREE access for the folder containing the
// currently-open document.
//
// Mounted by DocumentScreen the first time it sees `SafCapability.SingleUri`
// for a given document URI (state persisted via SettingsStore.grantPromoAsked).
// Per the Android design doc — "a one-time bottom-sheet asks the user to
// grant folder access; if declined the sidecar is mirrored to app-private
// storage and a persistent banner re-surfaces the share-back flow" — this
// sheet replaces the always-on yellow banner as the *first* contact UI.
// SafCapabilityBanner stays available for the declined path.
//
// Why a stateless sheet that delegates the tree-grant flow:
//   * The OPEN_DOCUMENT_TREE launcher + SaveSidecarToSource wiring already
//     lives in SafCapabilityBannerWithPromote; replicating it here would
//     drift the two surfaces. Instead, the sheet accepts an `onGrant`
//     callback that fires after the user picks the primary action — the
//     caller (DocumentScreen) decides which composable hosts the actual
//     OpenDocumentTree launcher.
//   * Keeps the sheet trivially previewable / Robolectric-testable without
//     mounting the activity-result plumbing.
//
// UX choices vs the wireframe absence:
//   * The Android design doc references a bottom-sheet but ships no
//     dedicated wireframe HTML (the comments-thread sheet at
//     wireframes/06-thread-detail.html is structurally similar). The
//     copy chosen here is the shortest form that names BOTH the benefit
//     (comments save next to the file) AND the cost (folder grant); the
//     "Not now" affordance maps to the declined state the design
//     describes.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GrantFolderAccessSheet(
    docFilename: String,
    onGrant: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 16.dp),
        ) {
            Text(
                text = "Save comments next to this file?",
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = "Grant access to the folder containing \"$docFilename\" so " +
                    "comments save right next to the document. Without this, " +
                    "comments stay on this device only and you'll need to share " +
                    "them back manually.",
                modifier = Modifier.padding(top = 12.dp),
                style = MaterialTheme.typography.bodyMedium,
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 20.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                TextButton(onClick = onDismiss) {
                    Text("Not now")
                }
                Button(
                    onClick = onGrant,
                    modifier = Modifier.padding(start = 8.dp),
                ) {
                    Text("Grant access")
                }
            }
        }
    }
}
