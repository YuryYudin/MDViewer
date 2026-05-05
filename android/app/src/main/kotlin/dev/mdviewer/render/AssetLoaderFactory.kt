package dev.mdviewer.render

import android.content.Context
import androidx.webkit.WebViewAssetLoader

/**
 * Wraps the construction of a [WebViewAssetLoader] that serves the app's
 * bundled assets (the shared `document.css`, the `document-host.html`
 * template, and the future `selection-bridge.js` from D2) under a real
 * `https://` origin.
 *
 * Why a custom origin (and not `file://` or `loadData`):
 *   - `file://` access is disabled on the WebView (see [MarkdownWebView]):
 *     allowing it would broaden the attack surface to any local file the
 *     app happens to have read access to.
 *   - `loadData` strips the document of any origin, which breaks the
 *     `<link rel="stylesheet" href="document.css">` reference in
 *     `document-host.html`. We use `loadDataWithBaseURL([BASE_URL], ...)`
 *     so the WebView resolves the relative href against the asset loader.
 *   - The asset loader interprets the `/assets/<name>` path inside
 *     `BASE_URL` and proxies it to `Context.assets.open(<name>)`. Anything
 *     outside `/assets/` returns 404 to the WebView — no other surface is
 *     exposed.
 *
 * The host name `appassets.androidplatform.net` is the AndroidX-recommended
 * placeholder origin: it's reserved (RFC 6761 won't resolve it on the open
 * internet), so a misbehaving page that tries to escape the loader still
 * can't reach a real server.
 */
internal object AssetLoaderFactory {
    /**
     * The base URL passed to [android.webkit.WebView.loadDataWithBaseURL].
     * Relative paths inside the loaded HTML resolve against this prefix.
     *
     * Trailing slash matters: `loadDataWithBaseURL` joins the base URL and
     * the relative href textually, so `https://.../assets` + `document.css`
     * would parse to `https://.../assetsdocument.css` and 404. The trailing
     * slash makes `document.css` resolve to `/assets/document.css`.
     */
    const val BASE_URL: String = "https://appassets.androidplatform.net/assets/"

    /**
     * Builds a fresh [WebViewAssetLoader] bound to [ctx]'s asset manager.
     *
     * Callers should remember the result alongside the WebView instance —
     * the loader holds a reference to [ctx] and a per-WebView lifetime is
     * the simplest way to avoid leaking an Activity context if the
     * factory ever gets memoized.
     */
    fun create(ctx: Context): WebViewAssetLoader =
        WebViewAssetLoader.Builder()
            .addPathHandler(
                "/assets/",
                WebViewAssetLoader.AssetsPathHandler(ctx),
            )
            .build()
}
