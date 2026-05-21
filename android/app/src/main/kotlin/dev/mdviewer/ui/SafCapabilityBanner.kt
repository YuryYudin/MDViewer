// ---------------------------------------------------------------------------
// SafCapabilityBanner — yellow-tinted Composable that surfaces the
// "comments saved on device only" affordance when the runtime
// SafCapability is SingleUri.
//
// Behavior contract:
//   * Visible only when DocumentViewModel reports
//     `SafCapability.SingleUri` (DocumentScreen branches on the state).
//   * Tap interaction triggers `onTap` which the parent screen wires to
//     the SaveSidecarToSource flow in E3.
//   * Style: full-width amber bar at the top of the document content,
//     under the AppBar. Padding 12.dp on all sides matches the spacing
//     scale used elsewhere in the screen.
//
// Two surfaces in this file:
//
//   1. [SafCapabilityBanner] — the bare visual + onTap callback. Kept
//      stateless so [SafCapabilityBannerTest] can mount it under
//      Robolectric without needing the activity-result plumbing
//      ACTION_OPEN_DOCUMENT_TREE requires.
//
//   2. [SafCapabilityBannerWithPromote] — the production wrapper that
//      registers an [androidx.activity.result.contract.ActivityResultContracts.OpenDocumentTree]
//      launcher and routes a successful tree grant through
//      [SaveSidecarToSource.onTreeGranted]. The wrapper is what
//      [DocumentScreen] mounts; the bare banner stays available for
//      tests + previews.
//
// We deliberately do NOT auto-launch the OPEN_DOCUMENT_TREE prompt when
// capability is SingleUri — see the C5 spec's "Avoid" section. The
// banner is the only entry point; user-initiated taps win over surprise
// system dialogs.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.saf.SaveSidecarToSource
import dev.mdviewer.saf.Sidecar
import dev.mdviewer.saf.SidecarMirror
import kotlinx.coroutines.launch

@Composable
fun SafCapabilityBanner(
    onTap: () -> Unit = {},
    text: String = "Comments saved on device — tap to share back",
    interactive: Boolean = true,
    onDismiss: (() -> Unit)? = null,
) {
    // v0.4.19: explicit dark-amber foreground for the light-yellow
    // background so the banner reads correctly under BOTH light and
    // dark themes. Compose's Text default color is the theme's
    // onSurface, which is white in dark mode — illegible on this
    // tonal background. The amber tone here is reused from the
    // standard Material "amber 900" palette point.
    val rowMod = Modifier
        .fillMaxWidth()
        .background(Color(0xFFFFF3CD))
        .let { if (interactive) it.clickable(onClick = onTap) else it }
    Row(modifier = rowMod) {
        Text(
            text = text,
            color = Color(0xFF332D00),
            modifier = Modifier
                .weight(1f)
                .padding(start = 12.dp, top = 12.dp, bottom = 12.dp, end = 4.dp),
        )
        // v0.4.19: explicit close affordance so the banner is
        // dismissible. Owner decides what dismiss means (persistent
        // hide per-doc vs session-only); the banner just surfaces
        // the action. When `onDismiss` is null the button hides so
        // legacy call sites (and the bare-banner unit test) stay
        // single-action.
        if (onDismiss != null) {
            IconButton(onClick = onDismiss) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = "Dismiss",
                    tint = Color(0xFF332D00),
                )
            }
        }
    }
}

/**
 * Production banner wired against [SaveSidecarToSource]. Registers an
 * [ActivityResultContracts.OpenDocumentTree] launcher at composition
 * time so a tap fires the system tree picker; on grant we coroutine-
 * launch the mirror -> tree flush and report the boolean outcome via
 * [onPromoted].
 *
 * Inputs:
 *   * [docUri] — the document URI the user opened. The mirror file is
 *     keyed off this URI; the granted tree is the destination.
 *   * [docFilename] — display name from the OpenedDocument; we need it
 *     to build the sibling sidecar filename via `sidecarFilename(...)`.
 *   * [sidecarPattern] — the user's configured sidecar filename pattern
 *     (defaulted in SettingsStore). DocumentViewModel already resolves
 *     this; the banner takes it as a value rather than re-reading the
 *     store so the banner stays Compose-context-free.
 *   * [onPromoted] — invoked with `true` when the flush succeeded (UI
 *     can dismiss the banner / refresh state) or `false` on benign
 *     failure (UI can keep the banner visible, optionally surface a
 *     snackbar). The wrapper does NOT itself emit a snackbar — the
 *     screen owns the SnackbarHost and decides the messaging.
 *
 * Why we construct a fresh [SidecarMirror] / [Sidecar] / [SaveSidecarToSource]
 * inside the Composable (rather than injecting them): both classes are
 * Context-bound + cheap to allocate; allocating once per recomposition
 * would matter for a hot Composable but the banner only mounts once
 * per document open. Hoisting to a ViewModel would introduce a third
 * collaborator on DocumentViewModel for a flow that's strictly
 * orthogonal to the document state machine.
 */
@Composable
fun SafCapabilityBannerWithPromote(
    docUri: Uri,
    docFilename: String,
    sidecarPattern: String,
    onPromoted: (Boolean) -> Unit = {},
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    // Stable across recompositions — Sidecar(ctx) builds a default
    // production [TreeAccess] internally (DocumentFileTreeAccess) so the
    // verification step in onTreeGranted walks the same tree the save
    // call used. Re-allocation only happens if the activity Context
    // changes, which in practice means a process death + restore.
    val saveSidecarToSource = remember(ctx) {
        val mirror = SidecarMirror(ctx)
        val treeAccess = dev.mdviewer.saf.DocumentFileTreeAccess(ctx)
        val sidecar = Sidecar(ctx, mirror = mirror, treeAccess = treeAccess)
        SaveSidecarToSource(
            mirror = mirror,
            sidecar = sidecar,
            sidecarPattern = { sidecarPattern },
            treeAccess = treeAccess,
        )
    }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocumentTree(),
    ) { treeUri ->
        // Null = user dismissed the picker. Treat as a benign cancel —
        // the user can re-tap the banner if they change their mind.
        if (treeUri != null) {
            scope.launch {
                val ok = saveSidecarToSource.onTreeGranted(
                    ctx = ctx,
                    docUri = docUri,
                    docFilename = docFilename,
                    treeUri = treeUri,
                )
                onPromoted(ok)
            }
        }
    }

    // v0.4.18: Google Drive's storage provider does NOT support
    // ACTION_OPEN_DOCUMENT_TREE — only ACTION_OPEN_DOCUMENT (single-file).
    // Drive deliberately excludes itself from the tree picker because
    // tree-style folder grants don't fit its offline-sync model. The
    // user-visible bug (v0.4.17): the bottom-sheet "Grant access" button
    // opened a tree picker showing only local folders, no Drive.
    // Detecting Drive URIs by authority and skipping the sheet entirely
    // — with banner copy that names the limitation honestly — is the
    // best we can do without OAuth + Drive REST API (out of scope per
    // the design doc's non-goals; would land in v2).
    val docAuthority = docUri.authority.orEmpty()
    val isDrive = docAuthority.startsWith("com.google.android.apps.docs")

    // v0.4.17: gate between the bottom-sheet (first contact for this doc)
    // and the always-on banner (after the sheet has been dismissed). The
    // Android design doc names the bottom-sheet as the primary surface —
    // the persistent banner is the fallback for the declined state. Keying
    // by URI-hash means the same doc, picked again on a future open, does
    // NOT re-prompt; switching to a different doc re-prompts because each
    // open is a fresh consent moment. SHA-256 + Base64-URL keeps the
    // preferences file from carrying clear-text Drive doc IDs.
    val settings = remember(ctx) { SettingsStore(ctx.applicationContext) }
    val askedSet by settings.grantPromoAsked.collectAsState(initial = emptySet())
    val dismissedSet by settings.grantBannerDismissed.collectAsState(initial = emptySet())
    val uriHash = remember(docUri) {
        val sha = java.security.MessageDigest.getInstance("SHA-256")
            .digest(docUri.toString().toByteArray(Charsets.UTF_8))
        android.util.Base64.encodeToString(
            sha,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP,
        )
    }
    val asked = uriHash in askedSet
    val dismissed = uriHash in dismissedSet
    val recordAsked = {
        scope.launch { settings.recordGrantPromoAsked(uriHash) }
        Unit
    }
    val recordDismissed = {
        scope.launch { settings.recordGrantBannerDismissed(uriHash) }
        Unit
    }

    // null = let the picker open at the default location. Passing the
    // doc's parent URI as a hint would require resolving the parent
    // tree URI from the document URI, which is what the user is being
    // asked to grant in the first place — a chicken-and-egg setup.
    when {
        // Explicit close: render nothing for the rest of the doc's
        // lifetime. The user's "stop showing me this" signal wins over
        // every other state (asked, Drive, sheet-eligible).
        dismissed -> Unit
        isDrive -> SafCapabilityBanner(
            text = "Comments saved on this device. Google Drive doesn't support " +
                "folder access from third-party apps, so comments can't sync back " +
                "to the same folder as the document.",
            interactive = false,
            onDismiss = recordDismissed,
        )
        asked -> SafCapabilityBanner(
            onTap = { launcher.launch(null) },
            onDismiss = recordDismissed,
        )
        else -> GrantFolderAccessSheet(
            docFilename = docFilename,
            onGrant = {
                recordAsked()
                launcher.launch(null)
            },
            onDismiss = { recordAsked() },
        )
    }
}
