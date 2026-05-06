// ---------------------------------------------------------------------------
// RecentsViewModelTest — host-JVM verification of the snapshot pull from
// [RecentsApi] into the screen-side [StateFlow<List<RecentEntry>>].
//
// We pin three behaviors:
//
//   1. The initial state is the empty list when the underlying recents
//      store has no entries — the screen relies on this to draw the
//      "No documents yet" empty state without flickering through a
//      stale list.
//
//   2. After `recordOpen` lands on the fake (mid-test) and the VM is
//      explicitly refresh()ed, the entries flow surfaces the new entry.
//
//   3. Order matches what the underlying RecentsApi.list() returns —
//      the ViewModel does not re-sort. Two recordOpen calls produce a
//      most-recent-first list, the head being the last open, which is
//      the contract `FakeRecents` (and the production `Recents` class)
//      both honour.
//
// We use Robolectric@33 for the same reason as the DocumentViewModel
// test: the test runs on the JVM but exercises ViewModel + viewModelScope
// + StandardTestDispatcher, and the @Config keeps Robolectric's shadow
// framework on the API level :core's UniFFI bindings expect (mirrors
// SidecarTreeTest's setup, even though no UniFFI calls happen here).
// ---------------------------------------------------------------------------
@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.mdviewer.ui

import dev.mdviewer.data.SafTier
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
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class RecentsViewModelTest {

    private val testDispatcher = StandardTestDispatcher()

    @Before fun setUp() { Dispatchers.setMain(testDispatcher) }
    @After fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun empty_recents_yields_empty_entries() = runTest {
        val recents = FakeRecents()
        val vm = RecentsViewModel(recents)

        advanceUntilIdle()
        val entries = vm.entries.first()
        assertTrue(entries.isEmpty(), "expected empty list, got: $entries")
    }

    @Test
    fun refresh_picks_up_new_entries() = runTest {
        val recents = FakeRecents()
        val vm = RecentsViewModel(recents)

        recents.recordOpen("content://t/a", "a.md", SafTier.SingleUri)

        vm.refresh()
        advanceUntilIdle()
        val entries = vm.entries.first()
        assertEquals(1, entries.size)
        assertEquals("content://t/a", entries.first().uri)
        assertEquals("a.md", entries.first().displayName)
    }

    @Test
    fun entries_match_recents_list_order_most_recent_first() = runTest {
        val recents = FakeRecents()
        recents.recordOpen("content://t/a", "a.md", SafTier.SingleUri)
        recents.recordOpen("content://t/b", "b.md", SafTier.TreeAccess)

        val vm = RecentsViewModel(recents)
        advanceUntilIdle()
        val entries = vm.entries.first()
        assertEquals(2, entries.size)
        // Most-recent-first: the second recordOpen lands at the head.
        assertEquals("content://t/b", entries.first().uri)
        assertEquals("content://t/a", entries.last().uri)
    }
}
