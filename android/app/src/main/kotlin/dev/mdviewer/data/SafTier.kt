// ---------------------------------------------------------------------------
// SafTier — categorises how the user reached a markdown document so the
// rest of the app can reason about what the framework will let us do
// next without re-prompting.
//
// SAF (Storage Access Framework) hands out two flavours of grant:
//
//   * `TreeAccess` — the user picked a *folder* via ACTION_OPEN_DOCUMENT_TREE,
//     which means we can walk siblings, list children, and (importantly for
//     comments) write `.md.comments.json` next to the source file without
//     re-prompting. This is the path the in-app FAB takes.
//
//   * `SingleUri` — the user (or another app, e.g. Drive's ACTION_VIEW)
//     handed us a single document URI. We can read/write THAT file, but
//     touching its sibling sidecar requires either DocumentFile.fromTreeUri
//     (which needs an enclosing tree grant we don't have) or a fresh
//     ACTION_OPEN_DOCUMENT prompt. The downstream comments flow uses this
//     bit to decide whether to surface a "grant folder access" nudge.
//
// The enum is persisted as part of every Recents entry so the bit is stable
// across cold starts: knowing how a doc was originally opened lets us
// pre-flight the right reload pathway when the user taps it from history.
// ---------------------------------------------------------------------------
package dev.mdviewer.data

enum class SafTier {
    TreeAccess,
    SingleUri,
}
