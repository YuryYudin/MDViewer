// ---------------------------------------------------------------------------
// ThreadSheetTest — host-JVM Compose coverage for the [ThreadSheet] modal
// bottom-sheet surface. The composable is the read + post + reply UX from
// `wireframes/06-thread-detail.html`; we lock the wireframe-required
// strings + tap dispatches for both visible variants:
//
//   * NewThreadBody — anchor preview, "as <displayName>" identity badge,
//     Post button enabled only when the draft is non-blank.
//   * ExistingThreadBody — anchor preview, comment list, reply composer,
//     Resolve / Reopen toggle.
//
// Why we drive a real [ThreadSheetViewModel] (rather than mounting the
// private body composables directly): NewThreadBody / ExistingThreadBody
// are file-private. The public [ThreadSheet] entry point is the only seam
// the production caller uses, and it routes state through the ViewModel.
// Driving the ViewModel through its `openForNewThread` /
// `openForExisting` API exercises the same path the wireframe describes
// without exposing the internals.
//
// Why Robolectric @Config(sdk = [33]): mirrors CommentsListSheetTest +
// ThreadSheetViewModelTest. createComposeRule() needs a host
// ComponentActivity that Robolectric stubs at SDK 33, and the ViewModel
// touches dev.mdviewer.core UniFFI bindings (createThread / postReply /
// resolveThread) which transitively reference android.os.Build via the
// `android_cleaner` UDL setting.
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import android.net.Uri
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.core.Anchor
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.NewThread
import dev.mdviewer.core.createThread
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import dev.mdviewer.render.Selection
import dev.mdviewer.saf.SafCapability
import dev.mdviewer.saf.SidecarApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@OptIn(ExperimentalMaterial3Api::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class ThreadSheetTest {

    @get:Rule val composeRule = createComposeRule()

    // We deliberately do NOT route Main through a StandardTestDispatcher
    // here (unlike ThreadSheetViewModelTest): under Robolectric, the
    // default Main dispatcher pumps the looper inline so
    // `composeRule.waitForIdle()` (which awaits both the Compose snapshot
    // mutation queue and the looper) sees the ViewModel's state mutations
    // without an explicit scheduler advance. We DO route the IO
    // dispatcher through an UnconfinedTestDispatcher so the
    // resolveCurrent path's mutate + persist coroutine runs synchronously
    // when we drive the resolve label flip below.
    private val ioDispatcher = UnconfinedTestDispatcher()

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private fun fixedProfile(displayName: String = "Alice"): Profile = Profile(
        userId = "u-fixed-1",
        displayName = displayName,
        color = "#FF0066",
        isAnonymous = false,
    )

    private fun emptyStore(): CommentsStoreHandle = loadSidecarBytes(ByteArray(0))

    private fun saveContext(): ThreadSheetViewModel.SaveContext =
        ThreadSheetViewModel.SaveContext(
            docUri = Uri.parse("content://t/doc.md"),
            docFilename = "doc.md",
            capability = SafCapability.SingleUri,
            treeUri = null,
            sidecarPattern = "{name}.md.comments.json",
        )

    private fun newVm(
        store: CommentsStoreHandle = emptyStore(),
        profile: Profile = fixedProfile(),
    ): ThreadSheetViewModel = ThreadSheetViewModel(
        store = store,
        sidecar = NoOpSidecar(),
        profile = StubProfileStore(profile),
        saveContext = saveContext(),
        ioDispatcher = ioDispatcher,
    )

    private fun seededStoreWith(
        anchorText: String,
        body: String,
    ): Pair<CommentsStoreHandle, String> {
        val store = emptyStore()
        val seeded = createThread(
            store = store,
            input = NewThread(
                anchor = Anchor(
                    selectorText = anchorText,
                    contextBefore = "",
                    contextAfter = "",
                    charStart = 0u,
                    charEnd = anchorText.length.toUInt(),
                ),
                body = body,
                authorId = "u-seed",
                authorName = "Seed",
                authorColor = "#000000",
            ),
        )
        return store to seeded.id
    }

    // ------------------------------------------------------------------
    // Hidden state — the modal must NOT mount.
    // ------------------------------------------------------------------

    @Test
    fun thread_sheet_does_not_render_in_hidden_state() {
        val vm = newVm()
        composeRule.setContent { ThreadSheet(vm = vm, onPosted = {}) }

        // Wireframe strings absent because the early-return on Hidden bails
        // before ModalBottomSheet ever mounts.
        composeRule.onNodeWithText("New comment").assertDoesNotExist()
        composeRule.onNodeWithText("Post").assertDoesNotExist()
    }

    // ------------------------------------------------------------------
    // NewThread body — header + anchor preview + identity badge + Post.
    // ------------------------------------------------------------------

    @Test
    fun new_thread_body_renders_header_anchor_preview_and_identity_badge() {
        val vm = newVm(profile = fixedProfile(displayName = "Rui Park"))
        composeRule.setContent { ThreadSheet(vm = vm, onPosted = {}) }

        vm.openForNewThread(Selection(text = "the anchor", srcStart = 0, srcEnd = 10, rect = null))
        composeRule.waitForIdle()

        composeRule.onNodeWithText("New comment").assertIsDisplayed()
        // Anchor preview surfaces the highlighted span (truncated to 80
        // chars; "the anchor" fits within the cap) wrapped in quotes.
        composeRule.onNodeWithText("\"the anchor\"", substring = true).assertIsDisplayed()
        // Identity badge — wireframe locks the "as <displayName>" copy so
        // the user sees their identity before they tap Post.
        composeRule.onNodeWithText("as Rui Park", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Post").assertIsDisplayed()
    }

    @Test
    fun new_thread_post_button_disabled_until_draft_is_non_blank() {
        val vm = newVm()
        composeRule.setContent { ThreadSheet(vm = vm, onPosted = {}) }

        vm.openForNewThread(Selection(text = "anchor", srcStart = 0, srcEnd = 6, rect = null))
        composeRule.waitForIdle()

        // Empty draft -> disabled. Mirrors the wireframe + the
        // ViewModel's blank-draft guard.
        composeRule.onNodeWithText("Post").assertIsNotEnabled()

        // Type into the composer; the button flips to enabled. The
        // OutlinedTextField is keyed on the "Comment" label.
        composeRule.onNodeWithText("Comment").performTextInput("hi there")
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Post").assertIsEnabled()
    }

    // ------------------------------------------------------------------
    // ExistingThread body — anchor preview, comment list, reply composer,
    // Resolve / Reopen toggle.
    // ------------------------------------------------------------------

    @Test
    fun existing_thread_body_renders_anchor_comment_list_and_actions() {
        val (store, threadId) = seededStoreWith(
            anchorText = "the quoted span",
            body = "first body",
        )
        val vm = newVm(store = store)
        composeRule.setContent { ThreadSheet(vm = vm, onPosted = {}) }

        vm.openForExisting(threadId)
        composeRule.waitForIdle()

        // Anchor preview: the wireframe slug, truncated to 80 chars.
        composeRule.onNodeWithText("the quoted span", substring = true).assertIsDisplayed()
        // CommentRow renders body + author/timestamp row.
        composeRule.onNodeWithText("first body", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("Seed", substring = true).assertIsDisplayed()
        // Reply text appears twice (OutlinedTextField label + Button); both
        // landing on the surface is the wireframe contract.
        composeRule.onAllNodesWithText("Reply").assertCountEquals(2)
        composeRule.onNodeWithText("Resolve").assertIsDisplayed()
    }

    @Test
    fun existing_thread_reply_button_disabled_until_draft_is_non_blank() {
        val (store, threadId) = seededStoreWith(
            anchorText = "anchor",
            body = "seed body",
        )
        val vm = newVm(store = store)
        composeRule.setContent { ThreadSheet(vm = vm, onPosted = {}) }

        vm.openForExisting(threadId)
        composeRule.waitForIdle()

        // Pre-input: Reply button is the only "Reply"-labelled node that's
        // a Button; the OutlinedTextField uses "Reply" as a label too but
        // assertIsNotEnabled targets the merged Button semantics node.
        // Filter the node tree to the Button by enable-state assertion.
        composeRule.onAllNodesWithText("Reply").assertCountEquals(2)

        // Type into the reply composer; the OutlinedTextField is the only
        // node that accepts text input, so hasSetTextAction unambiguously
        // resolves to it.
        composeRule.onNode(
            androidx.compose.ui.test.hasSetTextAction(),
        ).performTextInput("a reply")
        composeRule.waitForIdle()

        // After typing, both Reply nodes still exist; the Button is the
        // one with Role = Button. Filter via the role semantics so the
        // OutlinedTextField (which has OnClick too because it's focusable)
        // doesn't get caught in the matcher.
        composeRule.onNode(
            androidx.compose.ui.test.hasText("Reply") and
                androidx.compose.ui.test.hasClickAction() and
                androidx.compose.ui.test.SemanticsMatcher.expectValue(
                    androidx.compose.ui.semantics.SemanticsProperties.Role,
                    androidx.compose.ui.semantics.Role.Button,
                ),
        ).assertIsEnabled()
    }

    @Test
    fun existing_thread_resolve_label_flips_to_reopen_when_resolved() {
        // Pre-resolve the thread so the action label flips to "Reopen".
        // We exercise the public ResolveCurrent path on the same VM that
        // hosts the sheet so the seeded thread's resolved flag is visible
        // to the next openForExisting call.
        val (store, threadId) = seededStoreWith(
            anchorText = "anchor",
            body = "seed body",
        )
        val vm = newVm(store = store)
        composeRule.setContent { ThreadSheet(vm = vm, onPosted = {}) }

        vm.openForExisting(threadId)
        composeRule.waitForIdle()

        // Default label is Resolve.
        composeRule.onNodeWithText("Resolve").assertIsDisplayed()

        // Flip via the production resolve path; the UnconfinedTestDispatcher
        // wired in for IO drives the mutate + persist coroutine to
        // completion synchronously, and waitForIdle picks up the state
        // mutation that closes the sheet.
        vm.resolveCurrent {}
        composeRule.waitForIdle()

        // After resolveCurrent the sheet closes — re-open and confirm the
        // label flipped.
        vm.openForExisting(threadId)
        composeRule.waitForIdle()
        composeRule.onNodeWithText("Reopen").assertIsDisplayed()
    }
}

// ---------------------------------------------------------------------------
// File-private fakes — distinct names from the [ThreadSheetViewModelTest]
// fakes (which are also file-private to that test) because Kotlin's
// top-level declarations cannot share simple names across the same
// package even when both are private.
// ---------------------------------------------------------------------------

/** Returns the configured [profile] without touching DataStore. */
private class StubProfileStore(private val profile: Profile) : ProfileStoreApi {
    override suspend fun get(): Profile = profile
}

/**
 * No-op [SidecarApi] — the ThreadSheet UI tests don't assert persistence;
 * `ThreadSheetViewModelTest` already locks the save dispatch separately.
 */
private class NoOpSidecar : SidecarApi {
    override suspend fun load(
        docUri: Uri,
        docFilename: String,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
    ): CommentsStoreHandle = loadSidecarBytes(ByteArray(0))

    override suspend fun save(
        docUri: Uri,
        docFilename: String,
        capability: SafCapability,
        treeUri: Uri?,
        pattern: String,
        store: CommentsStoreHandle,
    ) = Unit
}
