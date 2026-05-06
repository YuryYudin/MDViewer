// ---------------------------------------------------------------------------
// RecentsScreen — landing destination of the nav graph; renders the
// most-recent-first document list and surfaces the FAB that fires
// ACTION_OPEN_DOCUMENT for ad-hoc file pickers.
//
// Two visual states:
//
//   * Empty list — friendly call-to-action explaining that the user
//     can either tap the FAB or share a file in from another app.
//     The DriveNudgeCard from E5 will live here as a sibling element;
//     for C5 we leave a comment marker so the merge in E5 is mechanical.
//
//   * Non-empty list — LazyColumn of clickable rows. Each row shows
//     `displayName` as the headline and the URI as supporting text;
//     tapping a row routes to the Document destination via [onOpen].
//     Sorting is preserved verbatim from the underlying RecentsApi —
//     the production [Recents] class returns most-recent-first.
//
// FAB wiring: [rememberLauncherForActivityResult] with
// `ActivityResultContracts.OpenDocument()` returns a SAF URI from the
// system picker. We launch with three MIME hints — text/markdown is the
// canonical type, text/* covers .md from providers that don't know the
// markdown subtype (Drive sometimes serves it as text/plain), and */*
// is the absolute-fallback for the share-but-not-typed case (e.g. a
// .markdown file from a third-party file manager). The picker honors
// the FIRST type in the array as the visible filter; the others are
// accepted-but-not-promoted, which matches how Material3 expects
// "primary intent + fallback" to behave.
//
// We deliberately do NOT take a persistable URI permission here — the
// repository handles that on the open() path so the same logic applies
// whether the URI came from the picker, a share intent, or a recents
// re-open. Centralising the grant logic in the repository keeps this
// screen a thin shell.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.mdviewer.Placeholders

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RecentsScreen(vm: RecentsViewModel, onOpen: (android.net.Uri) -> Unit) {
    val entries by vm.entries.collectAsState()
    val pickFile = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> if (uri != null) onOpen(uri) }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Recents") }) },
        floatingActionButton = {
            FloatingActionButton(
                modifier = Modifier.testTag(Placeholders.FAB_OPEN_FILE_TAG),
                onClick = { pickFile.launch(arrayOf("text/markdown", "text/*", "*/*")) },
            ) {
                Icon(Icons.Default.Add, contentDescription = "Open file")
            }
        },
    ) { padding ->
        if (entries.isEmpty()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(32.dp),
            ) {
                Text("No documents yet")
                Spacer(Modifier.height(8.dp))
                Text("Open a .md from Drive or your file manager to get started.")
                // DriveNudgeCard rendered here in E5.
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                items(entries) { entry ->
                    ListItem(
                        headlineContent = { Text(entry.displayName) },
                        supportingContent = { Text(entry.uri) },
                        modifier = Modifier.clickable {
                            onOpen(android.net.Uri.parse(entry.uri))
                        },
                    )
                }
            }
        }
    }
}
