// ---------------------------------------------------------------------------
// SafCapabilityBanner — yellow-tinted Composable that surfaces the
// "comments saved on device only" affordance when the runtime
// SafCapability is SingleUri.
//
// Behavior contract:
//   * Visible only when DocumentViewModel reports
//     `SafCapability.SingleUri` (DocumentScreen branches on the state).
//   * Tap interaction triggers `onTap` which the parent screen wires to
//     the SaveSidecarToSource flow in E3 — for C5 the lambda defaults to
//     a no-op so the screen mounts without crashing.
//   * Style: full-width amber bar at the top of the document content,
//     under the AppBar. Padding 12.dp on all sides matches the spacing
//     scale used elsewhere in the screen.
//
// We deliberately do NOT auto-launch the OPEN_DOCUMENT_TREE prompt when
// capability is SingleUri — see the C5 spec's "Avoid" section. The
// banner is the only entry point; user-initiated taps win over surprise
// system dialogs.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

@Composable
fun SafCapabilityBanner(onTap: () -> Unit = {}) {
    Text(
        text = "Comments saved on device — tap to share back",
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFFFFF3CD))
            .clickable(onClick = onTap)
            .padding(12.dp),
    )
    // Tap behavior wired in E3 (SaveSidecarToSource).
}
