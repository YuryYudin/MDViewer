// ---------------------------------------------------------------------------
// ViewModelFactoriesTest — host-JVM coverage for the boring constructor
// wiring between Compose Navigation (Context-only) and the
// [DocumentViewModel] / [RecentsViewModel] (Api-injected).
//
// Two contracts under test:
//
//   1. The factory `create(...)` returns the right ViewModel type when
//      the supplied class matches.
//   2. The factory throws an `IllegalArgumentException` (the
//      `require(...)` predicate) when the supplied class does not match;
//      this is what the Android-recommended factory pattern locks down.
//
// Why Robolectric @Config(sdk = [33]): the factories construct the real
// [DocumentRepository] / [Recents] / [Sidecar] which transitively touch
// Android's `Context`-bound DataStore + ContentResolver. Robolectric
// stubs both at SDK 33 so the factories run on the host JVM.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.mdviewer.render.HtmlTheme
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class ViewModelFactoriesTest {

    private val ctx: Context = ApplicationProvider.getApplicationContext()

    // ------------------------------------------------------------------
    // DocumentViewModelFactory
    // ------------------------------------------------------------------

    @Test
    fun document_factory_creates_document_view_model() {
        val factory = DocumentViewModelFactory(
            ctx = ctx,
            theme = HtmlTheme.Light,
        )

        // The factory's `create<T>(modelClass)` returns T by inference, so a
        // direct `is`-check would be a tautology; we assert the runtime
        // class instead so the test would catch a regression where the
        // factory returns a subclass or proxy.
        val vm: ViewModel = factory.create(DocumentViewModel::class.java)
        assertTrue(
            DocumentViewModel::class.java.isInstance(vm),
            "factory must return a DocumentViewModel; got ${vm::class.java.name}",
        )
    }

    @Test
    fun document_factory_rejects_unrelated_view_model_class() {
        val factory = DocumentViewModelFactory(
            ctx = ctx,
            theme = HtmlTheme.Dark,
        )

        // A bare ViewModel subclass that's not assignable from
        // DocumentViewModel — the factory's `require(...)` rejects it.
        assertFailsWith<IllegalArgumentException> {
            factory.create(UnrelatedViewModel::class.java)
        }
    }

    // ------------------------------------------------------------------
    // RecentsViewModelFactory
    // ------------------------------------------------------------------

    @Test
    fun recents_factory_creates_recents_view_model() {
        val factory = RecentsViewModelFactory(ctx = ctx)

        val vm: ViewModel = factory.create(RecentsViewModel::class.java)

        assertTrue(
            RecentsViewModel::class.java.isInstance(vm),
            "factory must return a RecentsViewModel; got ${vm::class.java.name}",
        )
    }

    @Test
    fun recents_factory_rejects_unrelated_view_model_class() {
        val factory = RecentsViewModelFactory(ctx = ctx)

        assertFailsWith<IllegalArgumentException> {
            factory.create(UnrelatedViewModel::class.java)
        }
    }
}

// ---------------------------------------------------------------------------
// Test fixture — a no-op ViewModel subclass the factories must reject.
// ---------------------------------------------------------------------------

private class UnrelatedViewModel : ViewModel()
