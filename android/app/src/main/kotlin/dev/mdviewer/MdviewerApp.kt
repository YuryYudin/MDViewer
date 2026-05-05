package dev.mdviewer

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable

/**
 * Top-level Material3 theme wrapper. Phase C will widen this with
 * dynamic-color support (Android 12+) and a typography scale tuned for
 * markdown body / heading rendering; for B4 the bare-bones light/dark
 * dispatch is sufficient to keep the placeholder screens legible on
 * both modes.
 */
@Composable
fun MdviewerApp(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()
    MaterialTheme(colorScheme = scheme, content = content)
}
