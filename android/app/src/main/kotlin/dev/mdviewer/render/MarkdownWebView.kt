package dev.mdviewer.render

import android.annotation.SuppressLint
import android.content.Context
import android.util.AttributeSet
import android.view.ActionMode
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import kotlinx.coroutines.delay

/**
 * Theme variant the rendered document should display in. Maps to the
 * `data-theme` attribute on the `<body>` of `document-host.html`, which the
 * template's inline `<style>` block uses to switch between the light and
 * dark color tokens.
 */
enum class HtmlTheme { Light, Dark }

private const val DOCUMENT_HOST_ASSET = "document-host.html"

/**
 * The JS-side global name under which the [SelectionJsBridge]
 * `@JavascriptInterface` is exposed. `selection-bridge.js` reads
 * `window.MdvSelection.onMessage` to post messages back into the JVM, so
 * this string must match the JS bridge's lookup. Pulled out as a constant
 * so the JS asset and the Kotlin wiring can drift only intentionally.
 */
internal const val JS_INTERFACE_NAME = "MdvSelection"

/**
 * Compose host for the rendered Markdown document.
 *
 * Architecture:
 *   - An [AndroidView] wraps a [SelectionWebView] subclass — a stock
 *     [WebView] is insufficient because the only reliable way to suppress
 *     the system long-press menu (Copy / Share / Web Search / Translate)
 *     is to intercept `startActionMode(callback, type)` at the View layer
 *     and substitute our [SuppressingActionModeCallback] for the
 *     framework's. See [SelectionWebView] for the rationale.
 *   - On first composition, [buildWebView] configures the WebView once
 *     (settings, asset-loader-routing client, and — when [bridge] is
 *     non-null — the JS interface + ActionMode override).
 *   - The `update` lambda runs on every recomposition and re-loads the
 *     host template with the current `html` body and `theme`.
 *   - The template is read once from assets and `remember`-cached so we
 *     don't re-open the asset stream on every recomposition.
 *
 * Behavioral guarantees pinned by the spec (and enforced by [buildWebView]):
 *   1. JavaScript is enabled **only when [bridge] is non-null**. Phase C
 *      callers (the screen smoke test, the TopBar preview) pass `null` and
 *      keep the WebView a static renderer; D2's selection flow opts into
 *      the JS bridge by passing a [SelectionBridge] instance.
 *   2. `file://` access is **disabled** unconditionally. The asset loader
 *      is the *only* legal source of files inside the WebView.
 *   3. `loadDataWithBaseURL` is used (not `loadData`) so the relative
 *      stylesheet href in [DOCUMENT_HOST_ASSET] resolves against
 *      [AssetLoaderFactory.BASE_URL]. `loadData` strips the document
 *      origin and would break the `<link rel="stylesheet">` reference.
 *
 * The `__THEME__`/`__BODY__` placeholder substitution is intentionally
 * naive: the body HTML comes from `mdviewer-core::render_markdown`, which
 * already escapes user input (the Rust crate is the security boundary for
 * Markdown -> HTML conversion). The placeholder strings are *not* present
 * in legal rendered HTML, so a `replace` is sufficient and avoids pulling
 * in a templating dependency.
 *
 * @param bridge optional [SelectionBridge] instance. When provided, the
 *               WebView enables JavaScript, registers
 *               [SelectionJsBridge] under `window.MdvSelection`, and
 *               installs the ActionMode override that suppresses the
 *               system Copy/Share menu and forwards the rect via
 *               `onGetContentRect`. When null, the WebView stays in the
 *               C4 read-only mode.
 */
@Composable
fun MarkdownWebView(
    html: String,
    theme: HtmlTheme,
    modifier: Modifier = Modifier,
    bridge: SelectionBridge? = null,
    /**
     * D8: anchor ranges to inject after the WebView settles. The list is
     * passed straight to [HighlightInjector.inject] so the JS wrapper
     * walks every `[data-src-offset]` carrier and wraps the matching
     * spans in `<span class="anchored">`. An empty list (the default,
     * Phase C call sites) leaves the document with no highlight
     * decorations — exactly the C4 read-only mode.
     *
     * Re-injects on every change to the list reference: HighlightInjector's
     * idempotency contract (every call unwraps the prior `.anchored` set
     * before re-applying) means callers can pass the full thread list
     * unconditionally without diffing against the prior value.
     */
    anchorRanges: List<AnchorRange> = emptyList(),
) {
    val ctx = LocalContext.current
    val loader = remember(ctx) { AssetLoaderFactory.create(ctx) }
    val template = remember(ctx) {
        ctx.assets.open(DOCUMENT_HOST_ASSET).bufferedReader().use { it.readText() }
    }
    // Hand the WebView reference up to the LaunchedEffect below so it
    // can call HighlightInjector.inject without recomposing the WebView.
    // `mutableStateOf` is fine here because the `factory` lambda runs
    // once per AndroidView host, and the LaunchedEffect re-reads the
    // value on every key change rather than on Compose state reads.
    val webViewRef = remember { mutableStateOf<android.webkit.WebView?>(null) }

    AndroidView(
        modifier = modifier,
        factory = { c ->
            val wv = buildWebView(c, loader, bridge)
            webViewRef.value = wv
            wv
        },
        update = { wv ->
            val themed = template
                .replace("__THEME__", if (theme == HtmlTheme.Dark) "dark" else "light")
                .replace("__BODY__", html)
            wv.loadDataWithBaseURL(
                AssetLoaderFactory.BASE_URL,
                themed,
                "text/html",
                "utf-8",
                null,
            )
        },
    )

    // D8: inject highlights after every anchorRanges change. We re-key
    // on `html` too because a doc-reload reloads the WebView and the
    // freshly-parsed DOM has no `.anchored` wrappers to begin with;
    // re-running the effect on `html` change ensures the highlights
    // come back after every reload.
    LaunchedEffect(anchorRanges, html) {
        val wv = webViewRef.value ?: return@LaunchedEffect
        // The WebView's loadDataWithBaseURL above kicks off DOM parsing
        // asynchronously on the chrome thread. evaluateJavascript only
        // reaches `window.applyAnchors` after the script tag in
        // document-host.html has finished executing. A short delay is
        // the simplest robust gate that works across all WebView impls
        // we ship against; the alternative (polling for
        // `typeof applyAnchors === 'function'`) buys nothing because
        // the script tag is sync-loaded from the asset loader and
        // settles within one frame on every device we've tested.
        delay(50)
        HighlightInjector.inject(wv, anchorRanges)
    }
}

/**
 * Build a fresh [WebView] hardened to the C4 contract (and extended for D2
 * when [bridge] is non-null):
 *   - `javaScriptEnabled = (bridge != null)` — JS only turns on for the
 *     selection-bridge path. Phase C callers that pass `null` get the
 *     read-only WebView from C4.
 *   - `allowFileAccess = false` and `allowContentAccess = false` close
 *     the two backdoors that bypass the asset loader.
 *   - `domStorageEnabled = false` since we host static content; turning
 *     it on without a use case grows the attack surface.
 *   - The [WebViewClient] funnels every request through the asset loader.
 *     `shouldInterceptRequest` returning `null` lets the WebView fall
 *     through to its default behavior (which, since file/content access
 *     is off and only `loadDataWithBaseURL` is ever called, means the
 *     request is denied — exactly what we want for unexpected URIs).
 *   - When [bridge] is non-null, [SelectionJsBridge] is registered as
 *     `window.MdvSelection` and the [SuppressingActionModeCallback] is
 *     installed via [SelectionWebView.suppressingCallback].
 *
 * [SuppressLint("SetJavaScriptEnabled")] suppresses the Android lint
 * warning for the `javaScriptEnabled = true` branch when [bridge] is
 * non-null. We mitigate the JS attack surface by keeping `allowFileAccess`
 * and `allowContentAccess` off and routing every fetch through the asset
 * loader — see [AssetLoaderFactory] for the origin-isolation rationale.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun buildWebView(
    c: Context,
    loader: WebViewAssetLoader,
    bridge: SelectionBridge?,
): WebView =
    SelectionWebView(c).apply {
        settings.apply {
            javaScriptEnabled = bridge != null
            allowFileAccess = false
            allowContentAccess = false
            domStorageEnabled = false
        }
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?,
            ): WebResourceResponse? =
                request?.url?.let { loader.shouldInterceptRequest(it) }
        }
        if (bridge != null) {
            // Install the JS-side adapter. The lambda runs on the WebView's
            // chrome thread (the thread that dispatches @JavascriptInterface
            // callbacks); SelectionBridge is thread-safe via its underlying
            // MutableStateFlow so a direct call is fine.
            val jsBridge = SelectionJsBridge(bridge::onJsMessage)
            addJavascriptInterface(jsBridge, JS_INTERFACE_NAME)

            // Install the ActionMode override on the WebView subclass.
            // SelectionWebView intercepts startActionMode(callback, type)
            // at the View layer and swaps in our suppressing callback so
            // the system menu never gets to populate Copy / Share / Web
            // Search / Translate.
            suppressingCallback = SuppressingActionModeCallback(bridge)
        }
    }

/**
 * [WebView] subclass that lets D2 override the long-press ActionMode
 * callback before WebView gets a chance to populate the system menu.
 *
 * Why subclassing is the only working approach:
 *   - [WebView] internally calls `startActionMode(callback, ActionMode.TYPE_FLOATING)`
 *     when the user long-presses on selectable text. The `callback` it
 *     supplies is WebView's own implementation that adds Copy / Share /
 *     Web Search / Translate items to the menu.
 *   - There is no public API to swap that callback. Reflection on
 *     `WebViewProvider` is a non-starter (private since API 21 and varies
 *     across OEM ROMs).
 *   - Overriding `startActionMode` here lets us intercept the call,
 *     discard WebView's callback, and start our own ActionMode using the
 *     [SuppressingActionModeCallback] field — which returns false from
 *     `onCreateActionMode`, suppressing the menu entirely while still
 *     delivering selection rects via `onGetContentRect`.
 *
 * When [suppressingCallback] is null (the C4 read-only path), the override
 * delegates to the base `View.startActionMode` so existing behaviour is
 * preserved.
 */
internal class SelectionWebView(
    context: Context,
    attrs: AttributeSet? = null,
) : WebView(context, attrs) {

    /**
     * The callback to substitute when the WebView attempts to start a
     * long-press ActionMode. Settable so [buildWebView] can install it
     * after construction; null means "preserve default behaviour".
     */
    var suppressingCallback: ActionMode.Callback2? = null

    override fun startActionMode(
        callback: ActionMode.Callback?,
        type: Int,
    ): ActionMode? {
        val override = suppressingCallback
        return if (override != null) {
            // Use the parent (the on-screen container) as the host so the
            // ActionMode's `getContentRect` is computed against a view
            // that is actually laid out — calling super.startActionMode
            // here would re-enter our own override and recurse.
            super.startActionMode(override, type)
        } else {
            super.startActionMode(callback, type)
        }
    }

    @Deprecated(
        message = "Pre-API-23 API; required override so the suppression also " +
            "covers the legacy startActionMode(Callback) entry point that " +
            "older WebView builds still call into.",
    )
    override fun startActionMode(callback: ActionMode.Callback?): ActionMode? {
        val override = suppressingCallback
        @Suppress("DEPRECATION")
        return if (override != null) {
            super.startActionMode(override)
        } else {
            super.startActionMode(callback)
        }
    }
}
