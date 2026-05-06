// ---------------------------------------------------------------------------
// DocumentScreen — thin Compose shell over [DocumentViewModel]:
//
//   1. LaunchedEffect kicks the open() once per `uri` change. The
//      effect key is the URI itself, so re-entry to the screen with
//      the same URI is a no-op (Compose dedupes).
//   2. The top bar reflects the displayName from the Loaded state
//      (falls back to "MDViewer" pre-load) and hosts the D7 overflow
//      menu — currently a single "Reload" entry.
//   3. The body branches on the three states. SafCapabilityBanner
//      shows above the WebView only when capability == SingleUri.
//   4. A [SnackbarHost] is mounted on the Scaffold; the screen
//      collects [DocumentViewModel.snackbarMessage] in a LaunchedEffect
//      and forwards each emission to `snackbarHostState.showSnackbar`.
//      Wireframe 10's "$N new comments" / "No changes" copy is
//      produced inside the ViewModel — the screen is just the bus.
//
// Why no rendering / capability logic in here: the ViewModel owns the
// state machine. The screen's job is to translate states into the right
// Compose tree. Pulling business logic up here would defeat the unit
// tests (which fake the ViewModel collaborators, not the screen).
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.net.Uri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import dev.mdviewer.render.MarkdownWebView
import dev.mdviewer.saf.SafCapability

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentScreen(uri: Uri, vm: DocumentViewModel) {
    LaunchedEffect(uri) { vm.open(uri) }
    val state by vm.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    // One LaunchedEffect for the lifetime of the composition collects
    // every snackbar emission and forwards it to the host. Re-keying on
    // the ViewModel rather than `Unit` would re-subscribe on every
    // recomposition that happens to allocate a new vm reference; we tie
    // the collection to the activity-scoped vm via a stable key.
    LaunchedEffect(vm) {
        vm.snackbarMessage.collect { msg ->
            snackbarHostState.showSnackbar(msg)
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Text((state as? DocumentUiState.Loaded)?.displayName ?: "MDViewer")
                },
                actions = {
                    var menuOpen by remember { mutableStateOf(false) }
                    // contentDescription = "More" matches the e2e
                    // ManualReloadTest's locator (`onNodeWithContentDescription("More")`).
                    IconButton(onClick = { menuOpen = true }) {
                        Icon(Icons.Default.MoreVert, contentDescription = "More")
                    }
                    DropdownMenu(
                        expanded = menuOpen,
                        onDismissRequest = { menuOpen = false },
                    ) {
                        ReloadOverflowItem(onReload = {
                            menuOpen = false
                            vm.reload()
                        })
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when (val s = state) {
                DocumentUiState.Loading -> CircularProgressIndicator()
                is DocumentUiState.Error -> Text("Could not open: ${s.message}")
                is DocumentUiState.Loaded -> {
                    if (s.capability == SafCapability.SingleUri) {
                        SafCapabilityBanner()
                    }
                    // D8: anchorRanges flow through MarkdownWebView's
                    // LaunchedEffect into HighlightInjector. Orphan
                    // threads are NOT in this list — they're surfaced
                    // separately via the orphanThreadIds StateFlow that
                    // D6's CommentsListSheet collects.
                    val ranges by vm.anchorRanges.collectAsState()
                    MarkdownWebView(
                        html = s.html,
                        theme = s.theme,
                        anchorRanges = ranges,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        }
    }
}
