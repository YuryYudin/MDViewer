// ---------------------------------------------------------------------------
// ShareIntents — bidirectional ACTION_SEND glue.
//
// Inbound: when the user picks "MDViewer" from the system share sheet
// (Drive's three-dot menu, Files' share button, etc.), the activity
// receives an Intent.ACTION_SEND with EXTRA_STREAM holding the document
// URI. [extractDocumentUri] pulls that URI out so [IntentDispatcher]
// can route to NavDestination.Document(uri) — the same destination
// ACTION_VIEW lands on, which keeps the Document screen oblivious to
// how the URI arrived.
//
// Outbound: when the user taps "Share back" inside MDViewer (today
// surfaced from SafCapabilityBanner; v2 will add an explicit overflow
// item once tree-access docs need an outbound path too), [buildOutbound]
// produces the ACTION_SEND intent the chooser launches. The intent
// carries:
//
//   * `type = "text/markdown"` so receivers that filter on the markdown
//     MIME accept the share. Receivers that filter on `text/*` or `*/*`
//     pick it up via the broader filter overlap.
//   * `EXTRA_STREAM = uri` — the document URI. The receiver opens this
//     through ContentResolver, so we don't need to load any bytes
//     ourselves.
//   * `EXTRA_TITLE = displayName` — surfaces above the chooser sheet.
//   * `FLAG_GRANT_READ_URI_PERMISSION` — required for Android 7+ so the
//     receiver can read the URI without a SecurityException.
//
// What this file deliberately does NOT do:
//
//   * **Parse EXTRA_TEXT.** Plain-text shares (Gmail "share text"
//     button, etc.) carry their payload inline rather than as a URI.
//     v1 supports stream-mode only; turning a text body into a virtual
//     document is out of scope (would need a synthetic provider URI +
//     content store, which is a lot of plumbing for a niche use case).
//
//   * **Persist a grant.** ACTION_SEND grants are by design transient —
//     they expire when the receiving activity finishes. The
//     DocumentRepository.open path that ultimately reads the URI wraps
//     `takePersistableUriPermission` in a try/catch precisely because
//     SEND-sourced URIs deny persistence. No special-case here.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import android.content.Intent
import android.net.Uri
import android.os.Build

object ShareIntents {

    /**
     * Returns the document URI from an inbound [Intent.ACTION_SEND] when
     * present, or `null` for any other action / for SEND intents that
     * don't carry an EXTRA_STREAM.
     *
     * The defensive null path covers two real-world cases:
     *
     *   1. **Wrong action** — a refactor that calls this with an
     *      ACTION_VIEW intent shouldn't accidentally treat the
     *      `intent.data` URI as if it had been EXTRA_STREAM-shared.
     *      Returning null forces the caller to use the right helper.
     *   2. **Text-only SEND** — [Intent.EXTRA_TEXT] is the inline-text
     *      path (no URI). v1 does not parse text into a virtual
     *      document; the dispatcher falls through to the cold-start
     *      default.
     */
    fun extractDocumentUri(intent: Intent): Uri? {
        if (intent.action != Intent.ACTION_SEND) return null
        // API 33+ deprecates the un-typed getParcelableExtra in favour
        // of the typed overload; minSdk is 26 so we branch.
        @Suppress("DEPRECATION")
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
        }
    }

    /**
     * Builds the outbound [Intent.ACTION_SEND] intent for sharing
     * [uri] (a document URI inside MDViewer's process) to another
     * app. [displayName] is surfaced as the chooser title.
     *
     * The caller is expected to wrap this in `Intent.createChooser(...)`
     * before launching — MDViewer doesn't bake the chooser wrapper in
     * here so a future caller (e.g. a "Send to specific contact" flow)
     * can use the bare intent.
     */
    fun buildOutbound(uri: Uri, displayName: String): Intent =
        Intent(Intent.ACTION_SEND).apply {
            type = "text/markdown"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, displayName)
            // FLAG_GRANT_READ_URI_PERMISSION is the only flag the
            // receiver legitimately needs. We do NOT add WRITE — the
            // document is shared read-only; the receiver mirrors any
            // edits into its own sidecar (if it's another MDViewer)
            // or treats the share as a one-shot read.
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
}
