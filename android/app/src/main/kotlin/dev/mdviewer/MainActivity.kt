package dev.mdviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.navigation.compose.rememberNavController

/**
 * Single-activity host. The design spec is explicit that the Android
 * client is one Activity + a Compose NavHost — multi-activity stacks
 * make the popover / sheet hand-off in Phase D harder, and they
 * complicate ACTION_VIEW intent dispatch (each duplicate filter would
 * need its own activity-alias).
 *
 * The intent inspection that picks between Recents and Document
 * destinations based on `intent.action` lands in Phase C5; for B4
 * we always start at Recents so the placeholder graph mounts.
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MdviewerApp {
                val nav = rememberNavController()
                MdviewerNavHost(controller = nav, startDestination = Routes.Recents)
            }
        }
    }
}
