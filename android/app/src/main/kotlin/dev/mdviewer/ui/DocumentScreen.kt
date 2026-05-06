// ---------------------------------------------------------------------------
// DocumentScreen — thin Compose shell over [DocumentViewModel]:
//
//   1. LaunchedEffect kicks the open() once per `uri` change. The
//      effect key is the URI itself, so re-entry to the screen with
//      the same URI is a no-op (Compose dedupes).
//   2. The top bar reflects the displayName from the Loaded state
//      (falls back to "MDViewer" pre-load).
//   3. The body branches on the three states. SafCapabilityBanner
//      shows above the WebView only when capability == SingleUri.
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import dev.mdviewer.render.MarkdownWebView
import dev.mdviewer.saf.SafCapability

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentScreen(uri: Uri, vm: DocumentViewModel) {
    LaunchedEffect(uri) { vm.open(uri) }
    val state by vm.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text((state as? DocumentUiState.Loaded)?.displayName ?: "MDViewer")
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
