package dev.mdviewer.render

import android.annotation.SuppressLint
import android.content.Context
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader

/**
 * Theme variant the rendered document should display in. Maps to the
 * `data-theme` attribute on the `<body>` of `document-host.html`, which the
 * template's inline `<style>` block uses to switch between the light and
 * dark color tokens until D2's selection-bridge JS arrives.
 */
enum class HtmlTheme { Light, Dark }

private const val DOCUMENT_HOST_ASSET = "document-host.html"

/**
 * Compose host for the rendered Markdown document.
 *
 * Architecture:
 *   - An [AndroidView] wraps a stock [WebView]; we deliberately do NOT
 *     pull a Compose-WebView library because none currently shipped
 *     supports an [WebViewAssetLoader]-driven `WebViewClient` without
 *     re-implementing it.
 *   - On first composition, [buildWebView] configures the WebView once
 *     (settings, asset-loader-routing client). The `update` lambda runs
 *     on every recomposition and re-loads the host template with the
 *     current `html` body and `theme`.
 *   - The template is read once from assets and `remember`-cached so we
 *     don't re-open the asset stream on every recomposition.
 *
 * Behavioral guarantees pinned by the spec (and enforced by [buildWebView]):
 *   1. JavaScript is **disabled**. D2 turns this on for the selection
 *      bridge; until then the WebView is a static renderer.
 *   2. `file://` access is **disabled**. The asset loader is the *only*
 *      legal source of files inside the WebView.
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
 */
@Composable
fun MarkdownWebView(
    html: String,
    theme: HtmlTheme,
    modifier: Modifier = Modifier,
) {
    val ctx = LocalContext.current
    val loader = remember(ctx) { AssetLoaderFactory.create(ctx) }
    val template = remember(ctx) {
        ctx.assets.open(DOCUMENT_HOST_ASSET).bufferedReader().use { it.readText() }
    }

    AndroidView(
        modifier = modifier,
        factory = { c -> buildWebView(c, loader) },
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
}

/**
 * Build a fresh [WebView] hardened to the C4 contract:
 *   - `javaScriptEnabled = false` (D2 reverses this with care).
 *   - `allowFileAccess = false` and `allowContentAccess = false` close
 *     the two backdoors that bypass the asset loader.
 *   - `domStorageEnabled = false` since we host static content; turning
 *     it on without a use case grows the attack surface.
 *   - The [WebViewClient] funnels every request through the asset loader.
 *     `shouldInterceptRequest` returning `null` lets the WebView fall
 *     through to its default behavior (which, since file/content access
 *     is off and only `loadDataWithBaseURL` is ever called, means the
 *     request is denied — exactly what we want for unexpected URIs).
 *
 * [SuppressLint("SetJavaScriptEnabled")] is here defensively: we do *not*
 * enable JS in C4, but the lint rule fires on the negated
 * `javaScriptEnabled` line as well in some AGP versions.
 */
@SuppressLint("SetJavaScriptEnabled")
private fun buildWebView(c: Context, loader: WebViewAssetLoader): WebView =
    WebView(c).apply {
        settings.apply {
            javaScriptEnabled = false
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
    }
