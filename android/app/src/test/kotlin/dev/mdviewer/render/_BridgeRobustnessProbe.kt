package dev.mdviewer.render

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertTrue
import kotlin.test.fail

@RunWith(AndroidJUnit4::class)
@Config(sdk = [33])
class BridgeRobustnessProbe {
    @Test
    fun text_as_object_must_not_throw() {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        try {
            js.onMessage("""{"kind":"selectionchange","text":{},"srcStart":0,"srcEnd":1}""")
        } catch (e: Throwable) {
            fail("onMessage must not throw: ${e::class.simpleName}: ${e.message}")
        }
        assertTrue(received.isEmpty())
    }

    @Test
    fun threadid_as_array_must_not_throw() {
        val received = mutableListOf<JsMessage>()
        val js = SelectionJsBridge { received += it }
        try {
            js.onMessage("""{"kind":"highlightTap","threadId":[1,2,3]}""")
        } catch (e: Throwable) {
            fail("onMessage must not throw: ${e::class.simpleName}: ${e.message}")
        }
        assertTrue(received.isEmpty())
    }
}
