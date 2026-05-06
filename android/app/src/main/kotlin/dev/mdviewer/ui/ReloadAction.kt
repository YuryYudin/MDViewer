// ---------------------------------------------------------------------------
// ReloadAction — D7 manual-reload Compose surface.
//
// Two pieces, kept tiny on purpose:
//
//   * [ReloadOverflowItem] — the dropdown-menu entry the [DocumentScreen]
//     mounts behind its top-bar overflow icon. Wireframe 10 fixes the
//     copy as "Reload"; any restyle of the surface must keep that
//     literal so `onNodeWithText("Reload")` still finds it (the e2e
//     ManualReloadTest specs depend on this).
//
// What this file does NOT do:
//
//   * No business logic. The composable's only contract is "translate
//     the user tap into the supplied callback". The actual reload work
//     (re-read bytes, merge_stores, snackbar emit) lives on
//     [DocumentViewModel.reload] so the unit test can exercise the
//     state machine without a Context.
//
//   * No "reload spinner" state. Wireframe 10 explicitly hides the
//     spinner — the snackbar is the user-facing feedback that the
//     reload completed; a spinner alongside it would double-surface
//     the same event.
//
//   * No keyboard shortcut. Hardware-keyboard reload (Ctrl-R) is a
//     deferred enhancement; the wireframe surface is the overflow item
//     only.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable

/**
 * Dropdown-menu entry that fires [onReload] on tap.
 *
 * Mounted by [DocumentScreen] inside the top-app-bar overflow `DropdownMenu`.
 * The leading [Icons.Default.Refresh] icon mirrors the wireframe's iconography
 * (a circular arrow) without forcing the screen to plumb its own icon import.
 */
@Composable
fun ReloadOverflowItem(onReload: () -> Unit) {
    DropdownMenuItem(
        text = { Text("Reload") },
        leadingIcon = { Icon(Icons.Default.Refresh, contentDescription = null) },
        onClick = onReload,
    )
}
