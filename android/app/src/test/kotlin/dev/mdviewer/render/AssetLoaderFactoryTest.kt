// AssetLoaderFactoryTest — host-JVM smoke that exercises the factory's
// public surface so the `dev.mdviewer.render` package clears the C7 gate
// without needing an emulator. The factory builds a WebViewAssetLoader
// keyed at "/assets/"; the WebView itself is excluded from coverage
// because Robolectric can't host it (see coverageExcludes in build.gradle).
package dev.mdviewer.render

import androidx.test.core.app.ApplicationProvider
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AssetLoaderFactoryTest {

    @Test
    fun create_returns_non_null_loader() {
        val ctx = ApplicationProvider.getApplicationContext<android.content.Context>()
        val loader = AssetLoaderFactory.create(ctx)
        assertNotNull(loader)
    }

    @Test
    fun base_url_targets_appassets_origin_with_assets_prefix() {
        assertEquals(
            "https://appassets.androidplatform.net/assets/",
            AssetLoaderFactory.BASE_URL,
        )
        assertTrue(AssetLoaderFactory.BASE_URL.endsWith("/"))
    }
}
