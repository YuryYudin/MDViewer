// ---------------------------------------------------------------------------
// ThreadSheetViewModelTest — host-JVM verification of the D5 thread-sheet
// state machine.
//
// What the ViewModel does:
//   * Observes a [ThreadSheetState] flow that the [ThreadSheet] composable
//     collects (Hidden | NewThread | ExistingThread).
//   * Translates UI intents (open-for-new, open-for-existing, draft edits,
//     post, reply, resolve, close) into mutations on a UniFFI
//     [CommentsStoreHandle] followed by a [SidecarApi] save.
//
// What we verify here (the production-spec contract):
//
//   1. `openForNewThread(selection)` flips Hidden -> NewThread carrying the
//      selection (so the composer can preview the highlighted text) and
//      the active [Profile] (so the "as <name>" badge shows the right
//      identity even before the user touches the field).
//   2. `openForExisting(threadId)` flips Hidden -> ExistingThread carrying
//      the live thread snapshot and the empty draft reply. A miss
//      (unknown threadId) leaves the state at Hidden — we don't open a
//      blank sheet for a thread that disappeared.
//   3. `updateDraft(text)` updates the draft on whichever variant is live;
//      the state's other fields are unchanged.
//   4. `postNewThread(...)`:
//        - calls `createThread` on the comments store,
//        - persists via [SidecarApi.save] EXACTLY once,
//        - then closes the sheet (state -> Hidden).
//      The store grows by exactly one thread; the new thread carries the
//      caller's selection range as its anchor and the draft body as its
//      first comment.
//   5. `postReply(...)` of a non-empty draft:
//        - calls `postReply` on the existing thread,
//        - persists via [SidecarApi.save],
//        - closes the sheet.
//      The thread's comments list grows by exactly one.
//   6. `resolveCurrent(...)`:
//        - calls `resolveThread` on the live thread,
//        - persists via [SidecarApi.save],
//        - closes the sheet.
//      The thread's `resolved` flag becomes true.
//   7. Empty / blank drafts on `postNewThread` / `postReply` are no-ops:
//      the store is unchanged, no save happens, the sheet stays open so
//      the user can correct.
//
// Why a fake [SidecarApi] (rather than the real Sidecar):
//   The real Sidecar captures a Context and a TreeAccess collaborator.
//   The contract under test here is "ViewModel calls save with the right
//   params after every mutation"; a fake makes that assertion trivial
//   and keeps the test off the SAF + UniFFI deserialisation path that
//   `SidecarTreeTest` already covers.
//
// Why Robolectric @RunWith + sdk = 33:
//   The ViewModel touches `dev.mdviewer.core` UniFFI bindings on the
//   host JVM (`createThread`, `postReply`, etc), which transitively
//   reference `android.os.Build` via the `android_cleaner` UDL setting.
//   Same wiring as DocumentViewModelTest / SidecarTreeTest.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import dev.mdviewer.core.CommentsStoreHandle
import dev.mdviewer.core.loadSidecarBytes
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ProfileStoreApi
import dev.mdviewer.render.Selection
import dev.mdviewer.saf.SafCapability
import dev.mdviewer.saf.SidecarApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.assertFalse

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ThreadSheetViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before
    fun setUp() {
        // viewModelScope dispatches to Main; we route Main + IO through the
        // same test dispatcher so `runTest`'s scheduler controls the
        // mutation coroutines (which use Dispatchers.IO in production).
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    private fun emptyStore(): CommentsStoreHandle =
        loadSidecarBytes(ByteArray(0))

    private fun fixedProfile(): Profile = Profile(
        userId = "u-fixed-1",
        displayName = "Alice",
        color = "#FF0066",
        isAnonymous = false,
    )

    private fun saveContext(): ThreadSheetViewModel.SaveContext =
        ThreadSheetViewModel.SaveContext(
            docUri = Uri.parse("content://t/doc.md"),
            docFilename = "doc.md",
            capability = SafCapability.SingleUri,
            treeUri = null,
            sidecarPattern = "{name}.md.comments.json",
        )

    private fun selection(text: String, start: Int, end: Int): Selection =
        Selection(text = text, srcStart = start, srcEnd = end, rect = null)

    private fun newVm(
        store: CommentsStoreHandle = emptyStore(),
        sidecar: FakeSidecar = FakeSidecar(),
        profile: ProfileStoreApi = FakeProfileStore(fixedProfile()),
    ): ThreadSheetViewModel = ThreadSheetViewModel(
        store = store,
        sidecar = sidecar,
        profile = profile,
        saveContext = saveContext(),
        // Route the mutation coroutines through the same dispatcher the
        // test scheduler controls so `advanceUntilIdle` sees the post +
        // save work. Without this the IO dispatcher would run on a real
        // background thread the scheduler does not advance, and the
        // assertions would race the in-flight save.
        ioDispatcher = testDispatcher,
    )

    // ---------------------------------------------------------------------
    // Open / close transitions
    // ---------------------------------------------------------------------

    @Test
    fun open_for_new_thread_emits_new_state_with_selection_and_profile() = runTest {
        val vm = newVm()
        val sel = selection("hello", 0, 5)

        vm.openForNewThread(sel)
        advanceUntilIdle()

        val state = vm.state.first { it is ThreadSheetState.NewThread }
            as ThreadSheetState.NewThread
        assertEquals(sel, state.selection)
        assertEquals("", state.draft)
        assertEquals("Alice", state.profile.displayName)
    }

    @Test
    fun open_for_existing_emits_thread_state_with_live_thread() = runTest {
        // Seed a thread up front via the production createThread path so
        // the test reflects a thread sitting in the store at open time
        // (e.g. tap on an existing highlight).
        val store = emptyStore()
        val seedVm = newVm(store = store)
        seedVm.openForNewThread(selection("anchor", 0, 6))
        advanceUntilIdle()
        seedVm.updateDraft("seed")
        seedVm.postNewThread {}
        advanceUntilIdle()

        val seeded = store.threads().single()

        val vm = newVm(store = store)
        vm.openForExisting(seeded.id)
        advanceUntilIdle()

        val state = vm.state.first { it is ThreadSheetState.ExistingThread }
            as ThreadSheetState.ExistingThread
        assertEquals(seeded.id, state.thread.id)
        assertEquals("", state.draftReply)
        assertEquals("Alice", state.profile.displayName)
    }

    @Test
    fun open_for_existing_unknown_id_keeps_state_hidden() = runTest {
        val vm = newVm()
        vm.openForExisting("does-not-exist")
        advanceUntilIdle()
        // Sheet must stay hidden — opening a blank sheet for a missing
        // thread would surface a confusing empty surface.
        assertEquals(ThreadSheetState.Hidden, vm.state.value)
    }

    @Test
    fun close_returns_state_to_hidden() = runTest {
        val vm = newVm()
        vm.openForNewThread(selection("hi", 0, 2))
        advanceUntilIdle()
        assertTrue(vm.state.value is ThreadSheetState.NewThread)

        vm.close()
        assertEquals(ThreadSheetState.Hidden, vm.state.value)
    }

    // ---------------------------------------------------------------------
    // Draft edits
    // ---------------------------------------------------------------------

    @Test
    fun update_draft_updates_new_thread_draft_field() = runTest {
        val vm = newVm()
        vm.openForNewThread(selection("hi", 0, 2))
        advanceUntilIdle()

        vm.updateDraft("first comment")
        val state = vm.state.value as ThreadSheetState.NewThread
        assertEquals("first comment", state.draft)
    }

    @Test
    fun update_draft_updates_existing_thread_reply_field() = runTest {
        val store = emptyStore()
        val seedVm = newVm(store = store)
        seedVm.openForNewThread(selection("anchor", 0, 6))
        advanceUntilIdle()
        seedVm.updateDraft("seed")
        seedVm.postNewThread {}
        advanceUntilIdle()
        val seeded = store.threads().single()

        val vm = newVm(store = store)
        vm.openForExisting(seeded.id)
        advanceUntilIdle()

        vm.updateDraft("the reply")
        val state = vm.state.value as ThreadSheetState.ExistingThread
        assertEquals("the reply", state.draftReply)
    }

    @Test
    fun update_draft_in_hidden_state_is_a_no_op() = runTest {
        val vm = newVm()
        vm.updateDraft("ignored")
        assertEquals(ThreadSheetState.Hidden, vm.state.value)
    }

    // ---------------------------------------------------------------------
    // Post new thread (full state machine + sidecar persistence)
    // ---------------------------------------------------------------------

    @Test
    fun post_new_thread_creates_thread_and_persists_via_sidecar_save() = runTest {
        val store = emptyStore()
        val sidecar = FakeSidecar()
        val vm = newVm(store = store, sidecar = sidecar)

        var postedFiredCount = 0
        vm.openForNewThread(selection("anchor text", 10, 21))
        advanceUntilIdle()
        vm.updateDraft("first comment body")
        vm.postNewThread { postedFiredCount += 1 }
        advanceUntilIdle()

        // Threads grew by exactly one.
        val threads = store.threads()
        assertEquals(1, threads.size, "store should grow by one thread")
        val created = threads.single()
        assertEquals(11, (created.anchor.charEnd - created.anchor.charStart).toInt())
        assertEquals("anchor text", created.anchor.selectorText)
        assertEquals(1, created.comments.size, "first comment is inlined")
        assertEquals("first comment body", created.comments.single().body)
        assertEquals("Alice", created.comments.single().authorName)

        // Sidecar persistence: exactly one save with the configured context
        // and the same store handle the ViewModel mutated.
        assertEquals(1, sidecar.saveCalls.size, "save must be called exactly once")
        val call = sidecar.saveCalls.single()
        assertEquals(saveContext().docUri, call.docUri)
        assertEquals("doc.md", call.docFilename)
        assertEquals(SafCapability.SingleUri, call.capability)
        assertEquals("{name}.md.comments.json", call.pattern)

        // Sheet closes after a successful post; onPosted is fired exactly once.
        assertEquals(ThreadSheetState.Hidden, vm.state.value)
        assertEquals(1, postedFiredCount)
    }

    @Test
    fun post_new_thread_with_blank_draft_is_a_no_op() = runTest {
        val store = emptyStore()
        val sidecar = FakeSidecar()
        val vm = newVm(store = store, sidecar = sidecar)

        vm.openForNewThread(selection("anchor", 0, 6))
        advanceUntilIdle()
        // Default empty draft — pressing Post must be inert (the button is
        // disabled in the UI, but the ViewModel must guard the path too in
        // case a future test surface bypasses the disabled state).
        var postedFired = false
        vm.postNewThread { postedFired = true }
        advanceUntilIdle()

        assertEquals(0, store.threads().size, "no thread should be created on blank")
        assertEquals(0, sidecar.saveCalls.size, "no save on blank draft")
        assertFalse(postedFired, "onPosted must not fire on blank draft")
        assertTrue(vm.state.value is ThreadSheetState.NewThread,
            "sheet stays open so the user can correct")
    }

    // ---------------------------------------------------------------------
    // Post reply
    // ---------------------------------------------------------------------

    @Test
    fun post_reply_appends_comment_and_persists_via_sidecar_save() = runTest {
        val store = emptyStore()
        val sidecar = FakeSidecar()
        // Seed the thread to reply to.
        run {
            val seedVm = newVm(store = store, sidecar = sidecar)
            seedVm.openForNewThread(selection("anchor", 0, 6))
            advanceUntilIdle()
            seedVm.updateDraft("seed body")
            seedVm.postNewThread {}
            advanceUntilIdle()
        }
        val seeded = store.threads().single()
        sidecar.saveCalls.clear()

        val vm = newVm(store = store, sidecar = sidecar)
        var repliedFired = 0
        vm.openForExisting(seeded.id)
        advanceUntilIdle()
        vm.updateDraft("reply body")
        vm.postReply { repliedFired += 1 }
        advanceUntilIdle()

        val updated = store.threads().single()
        assertEquals(2, updated.comments.size, "thread should have seed + reply")
        assertEquals("reply body", updated.comments.last().body)
        assertEquals("Alice", updated.comments.last().authorName)

        assertEquals(1, sidecar.saveCalls.size, "save must persist the reply")
        assertEquals(ThreadSheetState.Hidden, vm.state.value)
        assertEquals(1, repliedFired)
    }

    @Test
    fun post_reply_with_blank_draft_is_a_no_op() = runTest {
        val store = emptyStore()
        val sidecar = FakeSidecar()
        run {
            val seedVm = newVm(store = store, sidecar = sidecar)
            seedVm.openForNewThread(selection("anchor", 0, 6))
            advanceUntilIdle()
            seedVm.updateDraft("seed body")
            seedVm.postNewThread {}
            advanceUntilIdle()
        }
        val seeded = store.threads().single()
        val priorSaves = sidecar.saveCalls.size

        val vm = newVm(store = store, sidecar = sidecar)
        vm.openForExisting(seeded.id)
        advanceUntilIdle()
        var fired = false
        vm.postReply { fired = true }
        advanceUntilIdle()

        // Only the seed save remains; reply added nothing.
        assertEquals(1, store.threads().single().comments.size)
        assertEquals(priorSaves, sidecar.saveCalls.size)
        assertFalse(fired)
        assertTrue(vm.state.value is ThreadSheetState.ExistingThread,
            "sheet stays open so the user can correct")
    }

    // ---------------------------------------------------------------------
    // Resolve
    // ---------------------------------------------------------------------

    @Test
    fun resolve_marks_thread_resolved_and_persists() = runTest {
        val store = emptyStore()
        val sidecar = FakeSidecar()
        run {
            val seedVm = newVm(store = store, sidecar = sidecar)
            seedVm.openForNewThread(selection("anchor", 0, 6))
            advanceUntilIdle()
            seedVm.updateDraft("seed body")
            seedVm.postNewThread {}
            advanceUntilIdle()
        }
        val seeded = store.threads().single()
        assertFalse(seeded.resolved, "fresh thread is unresolved by precondition")
        sidecar.saveCalls.clear()

        val vm = newVm(store = store, sidecar = sidecar)
        var resolvedFired = 0
        vm.openForExisting(seeded.id)
        advanceUntilIdle()
        vm.resolveCurrent { resolvedFired += 1 }
        advanceUntilIdle()

        val updated = store.threads().single()
        assertTrue(updated.resolved, "resolve must flip the resolved flag")
        assertEquals(1, sidecar.saveCalls.size)
        assertEquals(ThreadSheetState.Hidden, vm.state.value)
        assertEquals(1, resolvedFired)
    }
}

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

/**
 * Captures every [save] call so the test can assert which docUri/capability/
 * pattern the ViewModel persisted under. The IO is deliberately a no-op:
 * `SidecarTreeTest` and `SidecarMirrorTest` already cover the real bytes
 * round-trip; this fake only verifies the dispatch.
 */
private class FakeSidecar : SidecarApi {
    data class SaveCall(
        val docUri: Uri,
        val docFilename: String,
        val capability: SafCapability,
        val treeUri: Uri?,
        val pattern: String,
    )
    val saveCalls: MutableList<SaveCall> = mutableListOf()

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
    ) {
        saveCalls += SaveCall(docUri, docFilename, capability, treeUri, pattern)
    }
}

/**
 * Returns [profile] from every `get()` call without touching DataStore.
 * `save` is a no-op — none of the ThreadSheet paths mutate the profile,
 * so we don't bother recording the call. The ProfileSetup ViewModel test
 * (which DOES exercise save) carries its own recording fake.
 *
 * Distinct name from [ThreadSheetTest]'s file-private `StubProfileStore`
 * because Kotlin top-level declarations in the same package collide on
 * simple name even when both are `private`.
 */
private class FakeProfileStore(private val profile: Profile) : ProfileStoreApi {
    override suspend fun get(): Profile = profile
    override suspend fun save(profile: Profile) { /* unused by ThreadSheet */ }
}
