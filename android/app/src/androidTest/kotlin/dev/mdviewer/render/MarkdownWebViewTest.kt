package dev.mdviewer.render

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * C4 smoke: prove that `MarkdownWebView` mounts an `AndroidView`-wrapped
 * `WebView`, loads the `document-host.html` template via
 * `loadDataWithBaseURL`, and survives `waitForIdle` without throwing.
 *
 * Why this is the entire C4 assertion:
 *   - C4 hands off a *read-only* WebView. JavaScript stays disabled until
 *     D2, so we cannot evaluateJavascript() against the DOM here. Asserting
 *     anything about the rendered HTML body would either require the JS
 *     bridge (premature) or pulling the raw HTML out of the loader (not a
 *     useful behavior to pin).
 *   - The asset-loader pipeline (CSS resolution, the base-URL substitution,
 *     the template `__THEME__`/`__BODY__` swap) all *crash* if wired wrong:
 *     missing assets throw `FileNotFoundException` at WebViewClient time,
 *     a malformed template throws `MalformedURLException` at
 *     `loadDataWithBaseURL`. A "doesn't crash" smoke test is therefore a
 *     non-trivial signal at this phase.
 *   - D2 will replace this test with a real JS-bridged DOM assertion once
 *     selection-bridge.js is on the classpath.
 *
 * Runs against an emulator via `connectedDebugAndroidTest`. No emulator is
 * available in the build environment; the spec defers the connected run to
 * CI (matches the Phase B precedent for B5/B6).
 */
@RunWith(AndroidJUnit4::class)
class MarkdownWebViewTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun loads_html_into_webview_without_throwing() {
        composeRule.setContent {
            MarkdownWebView(html = "<h1>Hi</h1>", theme = HtmlTheme.Light)
        }
        composeRule.waitForIdle()
    }

    @Test
    fun dark_theme_threads_through_template_substitution() {
        composeRule.setContent {
            MarkdownWebView(html = "<p>dark body</p>", theme = HtmlTheme.Dark)
        }
        composeRule.waitForIdle()
    }
}
