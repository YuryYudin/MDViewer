// ---------------------------------------------------------------------------
// IntentDispatcher — pure (Intent, Boolean) -> NavDestination function.
//
// Why pulled out of MainActivity: intent dispatch is the riskiest single
// piece of the open-from-Drive flow. Inlined in `onCreate` it sits in a
// place where the only test harness is a Compose UI rule on a real device
// (slow + emulator-only). As a free-standing object it's a one-line call
// from any unit test.
//
// Design contract:
//   * `null` intent (process-restart re-entry, ContentProvider activity
//     re-route) is NOT an error — fall back to the cold-start default.
//   * ACTION_VIEW with a content:// URI -> Document(uri). The manifest
//     filter narrows incoming URIs to .md/markdown/text-mime, but the
//     dispatcher must NOT trust that; a malicious sender can still hit
//     the activity with garbage. Validation that the URI bytes are
//     actually markdown happens downstream in DocumentRepository — this
//     dispatcher only routes.
//   * ACTION_VIEW with NO data -> default. Empty ACTION_VIEW shouldn't
//     drop the user on a Document screen with no source.
//   * ACTION_SEND with an EXTRA_STREAM URI -> Document(uri). Wired in
//     E3 — the SEND filter in the manifest gets the user here when
//     they pick MDViewer from a third-party share sheet. EXTRA_TEXT-
//     only shares fall through (v1 supports stream-mode shares only).
//   * ACTION_MAIN, anything else -> default.
//
// `defaultStart(hasProfile)` is the cold-start router:
//   * hasProfile=true  -> Recents (the user has done setup)
//   * hasProfile=false -> ProfileSetup (first launch, walk through setup)
//
// hasProfile is sourced from `ProfileStore.isInitialized()` in MainActivity;
// see the runBlocking note there for why it's safe to read synchronously.
// ---------------------------------------------------------------------------
package dev.mdviewer

import android.content.Intent
import android.net.Uri
import dev.mdviewer.saf.ShareIntents

/**
 * Top-level navigation target. Stays sealed so a future arm (e.g. the
 * E3 share handler returning Document(uri) without a recents bump) is
 * a compile error in every consumer until they add the case explicitly.
 */
sealed interface NavDestination {
    /** Land on the recents list (default for returning users). */
    data object Recents : NavDestination

    /**
     * Land on the profile-setup flow. Used on first launch (no profile
     * persisted) and again if a future settings reset clears the
     * profile.
     */
    data object ProfileSetup : NavDestination

    /**
     * Open a specific document. The URI is the SAF-grant URI exactly as
     * received; the navigation layer (Routes.document) URL-encodes it
     * before stuffing into the route string.
     */
    data class Document(val uri: Uri) : NavDestination
}

/**
 * Stateless intent -> destination resolver.
 *
 * The implementation is intentionally tiny: every defensive branch maps
 * to `defaultStart(hasProfile)` so a missing `when` arm in a future edit
 * surfaces as "user landed on Recents" rather than "user crashed". For
 * an open-from-Drive vertical, that's the right failure mode.
 */
object IntentDispatcher {
    /**
     * Resolve [intent] into a [NavDestination]. [hasProfile] is the
     * boolean view of `ProfileStore.isInitialized()` — true means the
     * user has completed (or skipped) profile setup at least once.
     */
    fun resolve(intent: Intent?, hasProfile: Boolean): NavDestination {
        if (intent == null) return defaultStart(hasProfile)
        return when (intent.action) {
            Intent.ACTION_VIEW -> intent.data
                ?.let { NavDestination.Document(it) }
                ?: defaultStart(hasProfile)
            // E3: ACTION_SEND with EXTRA_STREAM holding a markdown URI
            // routes to the same Document destination ACTION_VIEW lands
            // on. We delegate the extraction to [ShareIntents] so the
            // EXTRA_TEXT-only path (out of v1 scope) returns null and
            // we fall through to the cold-start default rather than
            // dropping the user on a doc-less Document screen.
            Intent.ACTION_SEND -> ShareIntents.extractDocumentUri(intent)
                ?.let { NavDestination.Document(it) }
                ?: defaultStart(hasProfile)
            else -> defaultStart(hasProfile)
        }
    }

    private fun defaultStart(hasProfile: Boolean): NavDestination =
        if (hasProfile) NavDestination.Recents else NavDestination.ProfileSetup
}
