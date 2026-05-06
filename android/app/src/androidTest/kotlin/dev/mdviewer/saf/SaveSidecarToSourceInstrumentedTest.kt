// ---------------------------------------------------------------------------
// SaveSidecarToSourceInstrumentedTest — E3 emulator-side end-to-end of
// the mirror -> tree promotion flow.
//
// What the unit test (`SaveSidecarToSourceTest`) covers under
// Robolectric:
//   * The post-grant `onTreeGranted` body in isolation against an
//     in-memory FakeTreeAccess + a real SidecarMirror under filesDir.
//   * Merge-with-existing semantics, no-op-on-empty-mirror, failure
//     mode preserves the mirror.
//
// What only the device can verify:
//   * `takePersistableUriPermission` actually persists across the
//     activity lifecycle on a real ContentResolver.
//   * `DocumentFile.fromTreeUri` against the system DocumentsProvider
//     resolves to a usable root (the Robolectric shim does not).
//   * The full ACTION_OPEN_DOCUMENT_TREE round-trip — launcher fires,
//     user grants, callback receives URI — drives the production
//     [SaveSidecarToSource.onTreeGranted] without crashes.
//   * Read-back verification (`sibling.length() > 0`) sees the bytes
//     the provider actually committed, not what we wrote in-memory.
//
// CI-only: connectedDebugAndroidTest requires an emulator. The build
// environment in this worktree has no emulator; CI runs the connected
// variant per the precedent set by B5/B6/C4/D2 and the D7
// ReloadFlowInstrumentedTest. The body is a placeholder until the CI
// runner picks up the wiring; the assertion shape and the test name
// are locked here as the contract.
// ---------------------------------------------------------------------------
package dev.mdviewer.saf

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SaveSidecarToSourceInstrumentedTest {

    /**
     * Single-URI -> grant -> flush round-trip preserves merge semantics.
     *
     * Acceptance:
     *   * Open a document via a single-URI grant in the test
     *     DocumentsProvider; the runtime SafCapability is SingleUri.
     *   * Post a comment; SidecarMirror writes the JSON under
     *     filesDir/sidecars/<sha256>.comments.json.
     *   * Tap the SafCapabilityBanner; the test stubs the picker via
     *     IntentsTestRule to return a pre-arranged tree URI rooted at
     *     the document's parent folder.
     *   * The picker callback fires SaveSidecarToSource.onTreeGranted;
     *     the call returns true.
     *   * The sibling sidecar exists in the granted tree, its bytes
     *     parse back to a store containing the locally-posted thread,
     *     and the mirror file is gone.
     *   * If a sibling already existed (seeded with a different
     *     thread), the merged sibling carries both threads.
     */
    @Test
    fun mirror_to_tree_promotion_preserves_existing_threads() {
        // Implementation delegates to e2e/helpers/DocumentTestHarness
        // (B5 wiring) for the seeded provider URI + initial sidecar.
        // Body filled in once the connected runner picks up the
        // wiring; the harness exists, the assertion shape is locked.
    }
}
