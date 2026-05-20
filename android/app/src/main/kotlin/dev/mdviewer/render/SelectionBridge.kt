// ---------------------------------------------------------------------------
// SelectionBridge — reconciler that fuses two asynchronous channels into a
// single [SelectionEvent] flow consumed by the document Compose tree.
//
// Channel A — JS-originated messages: `selection-bridge.js` listens for the
// browser's `selectionchange` event and the document's `click` events,
// shaping the payload into a typed [JsMessage] before posting it through
// `addJavascriptInterface`. The DOM offsets that come along the wire are
// **source byte offsets** (the `data-src-offset` / `data-src-end` attributes
// emitted by `mdviewer-core::document::render_markdown`), NOT DOM coordinates.
//
// Channel B — ActionMode rect: Android's WebView normally pops up a system
// ActionMode on long-press with Copy / Share / Web Search / Translate
// entries. The design rejects that menu (Phase D will replace it with a
// custom popover anchored to the selection). We override `Callback2` so:
//   - `onCreateActionMode` returns false  → suppresses the system menu
//   - `onPrepareActionMode` returns false  → keeps it suppressed across redraws
//   - `onActionItemClicked` returns false  → defensive (we never populate menu)
//   - `onGetContentRect` forwards the rect → tells the popover where to anchor
//
// Reconciliation rule:
//   - JS selectionchange + a later rect → [SelectionEvent.Updated] with both
//   - rect with no JS selection yet → silently held until JS fires
//   - JS selection with no rect yet → [SelectionEvent.Updated] with rect=null
//   - selectionCollapsed / selectionUnanchorable → [SelectionEvent.Collapsed]
//
// Why a [MutableStateFlow] (and not a Channel/SharedFlow):
//   - Compose collectors need the **latest** state on first subscription so
//     re-composing the popover doesn't lose the active selection. SharedFlow
//     with replay=1 would also work but adds buffer semantics we don't need.
//   - The reconciler holds at most one outstanding selection, so the
//     conflation behavior of StateFlow (drop intermediate values when a
//     collector is slow) is the correct one.
//
// Why the JS bridge takes a `(JsMessage) -> Unit` instead of exposing a Flow:
//   - The instrumented integration in [MarkdownWebView] wires the JS bridge
//     to the SelectionBridge synchronously: each JS post translates 1:1 into
//     a `bridge.onJsMessage(msg)` call. Threading a Channel + collector
//     between them buys nothing here and would force callers onto a
//     coroutine scope.
// ---------------------------------------------------------------------------
package dev.mdviewer.render

import android.graphics.Rect
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.View
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Snapshot of the user's current text selection inside the rendered Markdown
 * document, in source-coordinate space (NOT DOM coordinates).
 *
 * @property text       The literal selected substring as the user sees it.
 *                      Used by the Compose popover for the "create thread"
 *                      affordance preview.
 * @property srcStart   Inclusive byte offset into the original Markdown
 *                      source where the selection begins. Sourced from the
 *                      nearest ancestor span's `data-src-offset` attribute.
 * @property srcEnd     Exclusive byte offset where the selection ends.
 *                      Sourced from the ancestor's `data-src-end` attribute.
 * @property rect       The screen-space rectangle the popover should anchor
 *                      to. Provided asynchronously by `onGetContentRect`;
 *                      may be null if the rect hasn't been delivered yet.
 */
data class Selection(
    val text: String,
    val srcStart: Int,
    val srcEnd: Int,
    val rect: Rect?,
)

/**
 * Externally-visible reconciler output. Kept as a sealed interface so the
 * Compose collector can `when`-exhaust it without an `else` branch.
 */
sealed interface SelectionEvent {
    /** No active selection (initial state, after collapse, or after unanchorable). */
    data object Collapsed : SelectionEvent

    /** A live selection plus (optionally) the rect to anchor the popover to. */
    data class Updated(val selection: Selection) : SelectionEvent

    /** The user tapped a span carrying `data-thread-id`; route to comments. */
    data class HighlightTapped(val threadId: String) : SelectionEvent
}

/**
 * Strongly-typed mirror of the JSON shapes that `selection-bridge.js` posts
 * into the JavaScriptInterface. The JS bridge does the parsing; the rest of
 * the app speaks this type.
 *
 * Why a sealed interface (not @Serializable):
 *   - The wire format is JSON-with-discriminator-key (`kind`) which doesn't
 *     map cleanly onto kotlinx-serialization's polymorphic discriminator
 *     without re-shaping the object envelope. Hand-rolled parsing in
 *     [SelectionJsBridge.onMessage] is simpler and keeps the JS payload
 *     legible for anyone reading the assets file.
 */
sealed interface JsMessage {
    /** `selectionchange` fired with `sel.isCollapsed === true`. */
    data object SelectionCollapsed : JsMessage

    /** A non-collapsed selection that we couldn't anchor to source spans. */
    data object SelectionUnanchorable : JsMessage

    /**
     * A non-collapsed selection successfully anchored to source-offset spans.
     *
     * @param text     `window.getSelection().toString()` — the user-visible
     *                 substring, possibly with collapsed whitespace per the
     *                 browser's selection-stringification rules.
     * @param srcStart `data-src-offset` of the start container's nearest
     *                 anchored ancestor (inclusive byte offset).
     * @param srcEnd   `data-src-end` of the end container's nearest anchored
     *                 ancestor (exclusive byte offset).
     */
    data class SelectionChanged(
        val text: String,
        val srcStart: Int,
        val srcEnd: Int,
        /**
         * v0.4.17 addition: selection rect in device pixels relative to the
         * WebView viewport top-left, computed by the JS bridge via
         * `range.getBoundingClientRect()`. Nullable for backward compat
         * with older bridge.js payloads (none ship, but the JNI surface
         * tolerates absent keys cleanly).
         *
         * Replaces the dead ActionMode.onGetContentRect channel —
         * SuppressingActionModeCallback returns false from
         * onCreateActionMode (to suppress the system menu), so the
         * action mode never starts and the original rect signal never
         * fired. Threading the rect through JS sidesteps the issue.
         */
        val rect: Rect? = null,
    ) : JsMessage

    /** A click landed on a span carrying `data-thread-id`. */
    data class HighlightTap(val threadId: String) : JsMessage
}

/**
 * Reconciler that joins JS messages and ActionMode rect updates into a
 * single [SelectionEvent] flow. Designed to be safe to call from the
 * WebView's JS thread (via [onJsMessage]) and from the UI thread (via
 * [onActionModeContentRect]) — [MutableStateFlow.value] is concurrent-safe.
 */
class SelectionBridge {
    private val _state = MutableStateFlow<SelectionEvent>(SelectionEvent.Collapsed)
    val state: StateFlow<SelectionEvent> = _state.asStateFlow()

    /**
     * Last successful JS-side selection. Reset to null on collapse so a
     * later rect update doesn't republish a stale selection.
     */
    private var lastJsSelection: JsMessage.SelectionChanged? = null

    /**
     * Last rect from `onGetContentRect`. Held across selection-change events
     * so a JS update right after layout still includes the anchor rect.
     * Reset on collapse for the same reason as `lastJsSelection`.
     */
    private var lastRect: Rect? = null

    fun onJsMessage(msg: JsMessage) {
        when (msg) {
            JsMessage.SelectionCollapsed,
            JsMessage.SelectionUnanchorable -> {
                lastJsSelection = null
                lastRect = null
                _state.value = SelectionEvent.Collapsed
            }
            is JsMessage.SelectionChanged -> {
                lastJsSelection = msg
                // v0.4.17: prefer the rect the JS bridge supplies over the
                // ActionMode one. ActionMode never fires today (callback
                // suppression) but if the platform ever does deliver an
                // onGetContentRect we don't want to overwrite a fresh JS
                // rect with a stale ActionMode rect on a later event.
                if (msg.rect != null) lastRect = msg.rect
                publish()
            }
            is JsMessage.HighlightTap -> {
                _state.value = SelectionEvent.HighlightTapped(msg.threadId)
            }
        }
    }

    fun onActionModeContentRect(rect: Rect) {
        lastRect = Rect(rect)  // copy: ActionMode reuses the Rect across calls
        // Don't synthesize an Updated event on rect alone — see the
        // `rect_before_selection_does_not_publish_until_selection_arrives`
        // unit test for the rationale.
        if (lastJsSelection != null) publish()
    }

    private fun publish() {
        val sel = lastJsSelection ?: return
        _state.value = SelectionEvent.Updated(
            Selection(
                text = sel.text,
                srcStart = sel.srcStart,
                srcEnd = sel.srcEnd,
                rect = lastRect,
            ),
        )
    }
}

/**
 * [ActionMode.Callback2] that swallows every menu-population call so the
 * WebView's default Copy / Share / Web Search / Translate entries never
 * appear. The single signal we keep is [onGetContentRect] which forwards
 * the selection rect to [bridge].
 *
 * Why we still subclass `Callback2` (and not just `Callback`):
 *   - The selection popover anchors to the rect that `onGetContentRect`
 *     produces. `Callback`'s `onCreateActionMode` cannot deliver a rect.
 *   - WebView's internal long-press handler types the parameter as
 *     `ActionMode.Callback`, but it instance-checks for `Callback2` at
 *     anchor time and silently skips the rect call if you only pass a
 *     `Callback`.
 */
class SuppressingActionModeCallback(
    private val bridge: SelectionBridge,
) : ActionMode.Callback2() {
    /**
     * MUST return true so the WebView keeps the underlying text selection
     * alive. Returning false aborts the ActionMode, and the WebView's
     * selection lifetime is tied to it on most Android implementations —
     * the user sees the highlight "blink" and immediately disappear,
     * which is exactly the v0.4.17 user-visible regression
     * (issue: "selection still blinks and doesn't do anything").
     *
     * To still suppress the visible Copy / Share / Web Search bar we
     * clear the menu in place. An action mode with an empty menu renders
     * as an invisible no-op floating bar on most themes from Android 8.0+
     * (the system collapses zero-item bars). The selection stays
     * highlighted and onGetContentRect / our JS-bridge selectionchange
     * path both fire normally.
     */
    override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean {
        menu?.clear()
        return true
    }

    /**
     * Re-clear on every prepare in case some platform code repopulates
     * the menu after onCreateActionMode. Returning true tells the system
     * the menu was modified so it re-measures the (empty) bar instead of
     * reusing the previous layout.
     */
    override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean {
        menu?.clear()
        return true
    }

    override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean = false

    override fun onDestroyActionMode(mode: ActionMode?) { /* no-op */ }

    override fun onGetContentRect(mode: ActionMode?, view: View?, outRect: Rect?) {
        // Call super first: the default impl seeds outRect with the view's
        // bounding box, which is what we want to forward when the WebView
        // hasn't computed a tighter selection rect yet.
        super.onGetContentRect(mode, view, outRect)
        outRect?.let { bridge.onActionModeContentRect(it) }
    }
}
