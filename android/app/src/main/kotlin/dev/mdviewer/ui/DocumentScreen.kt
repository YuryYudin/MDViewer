// ---------------------------------------------------------------------------
// DocumentScreen — Compose shell over [DocumentViewModel] that mounts the
// full read+comment+navigate surface.
//
// Layout (Box-stacked over the WebView so highlights, popovers, and sheets
// all share the same coordinate space):
//
//   1. LaunchedEffect kicks the open() once per `uri` change.
//   2. The top bar hosts: title + "Comments" drawer-toggle + "Open
//      settings" navigator + "More" overflow (Reload).
//   3. Body branches Loading / Error / Loaded; Loaded mounts MarkdownWebView,
//      ThreadOverlay (popover + drawer), and ThreadSheet (read+post+reply
//      bottom sheet).
//   4. A [SnackbarHost] receives reload-delta messages from the ViewModel.
//
// E7 wiring (closes the deferred-from-D integration gap):
//
//   * A [SelectionBridge] is `remember`-allocated per document open and
//     handed both to [MarkdownWebView] (so the WebView's JS interface +
//     ActionMode override route here) AND to [ThreadOverlay] (so the
//     popover renders when a selection exists, and the drawer mounts when
//     the host opens it). This is the only place the bridge is
//     instantiated — there is no module-wide singleton.
//   * A [ThreadSheetViewModel] is constructed once a Loaded state lands.
//     We construct it directly from the Loaded snapshot rather than
//     `viewModel(factory = ...)` because the per-document save context
//     (uri, capability, treeUri) is only known after `open()` resolves; a
//     factory keyed on Compose ViewModelStore would cache stale collabs
//     across opens. Re-keying with `remember(s.uri, ...)` ties the VM's
//     lifetime to the loaded doc.
//   * Bridge → sheet: a LaunchedEffect on `bridge.state` watches for
//     [SelectionEvent.HighlightTapped] and dispatches into
//     `threadSheetVm.openForExisting(threadId)`. The popover's Comment
//     action dispatches into `openForNewThread(selection)`.
//   * Drawer ↔ sheet: tapping a row in CommentsListSheet hands the
//     thread id back; the screen closes the drawer and opens
//     `openForExisting(threadId)`.
//   * Persistence: after every successful post/reply/resolve the sheet's
//     ViewModel calls back into `onPosted`, which we route to
//     `documentVm.refreshAnchors()` so the new highlights paint.
//
// Why no rendering / capability logic in here: the ViewModel owns the
// state machine. The screen's job is to translate states into the right
// Compose tree.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import android.content.Context
import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import dev.mdviewer.core.Thread
import dev.mdviewer.data.ProfileStore
import dev.mdviewer.data.SettingsStore
import dev.mdviewer.render.HtmlTheme
import dev.mdviewer.render.MarkdownWebView
import dev.mdviewer.render.SelectionBridge
import dev.mdviewer.render.SelectionEvent
import dev.mdviewer.saf.SafCapability
import dev.mdviewer.saf.Sidecar
import kotlinx.coroutines.launch
// E2: LocalHtmlTheme is provided by MdviewerApp at the activity root and
// derived live from SettingsStore + system dark-mode. Reading it here
// instead of using the per-Loaded-state `theme` field means a theme
// flip while the document is on-screen propagates through Compose
// recomposition into MarkdownWebView's evaluateJavascript swap.

/**
 * Map an [HtmlTheme] to the content description the [ThemeSwitchTest]
 * E2E spec asserts on. The string ("Theme: light" / "Theme: dark") is a
 * load-bearing locator — the spec uses
 * `onNodeWithContentDescription("Theme: dark", substring = true)` to
 * verify a theme flip propagated to the document surface without an
 * Activity restart. Pulled out into a function so the wiring stays
 * trivially unit-testable.
 */
internal fun themeContentDescription(theme: HtmlTheme): String = when (theme) {
    HtmlTheme.Light -> "Theme: light"
    HtmlTheme.Dark -> "Theme: dark"
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentScreen(
    uri: Uri,
    vm: DocumentViewModel,
    onOpenSettings: () -> Unit = {},
) {
    LaunchedEffect(uri) { vm.open(uri) }
    val state by vm.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    // One LaunchedEffect for the lifetime of the composition collects
    // every snackbar emission and forwards it to the host.
    LaunchedEffect(vm) {
        vm.snackbarMessage.collect { msg ->
            snackbarHostState.showSnackbar(msg)
        }
    }

    // E7: SelectionBridge is per-screen, allocated once on first
    // composition. The bridge is what fuses JS-side selection events with
    // ActionMode rect updates; both MarkdownWebView and ThreadOverlay
    // subscribe to its state.
    val bridge: SelectionBridge = remember { SelectionBridge() }

    // E7: drawer visibility is local UI state — opening / dismissing the
    // CommentsListSheet does not invalidate any ViewModel data.
    var commentsListOpen by remember { mutableStateOf(false) }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    Text((state as? DocumentUiState.Loaded)?.displayName ?: "MDViewer")
                },
                actions = {
                    // E7: drawer entry — CommentsListSidebarTest locates
                    // this via `onNodeWithContentDescription("Comments")`.
                    IconButton(onClick = { commentsListOpen = true }) {
                        Icon(
                            Icons.AutoMirrored.Filled.List,
                            contentDescription = "Comments",
                        )
                    }
                    // E7: settings entry — ThemeSwitchTest locates this
                    // via `onNodeWithContentDescription("Open settings")`.
                    IconButton(onClick = onOpenSettings) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = "Open settings",
                        )
                    }
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
                        // E3: the banner here is the ACTION_OPEN_DOCUMENT_TREE
                        // entry point, wired to SaveSidecarToSource.
                        SafCapabilityBannerWithPromote(
                            docUri = s.uri,
                            docFilename = s.displayName,
                            sidecarPattern = vm.sidecarPatternValue,
                        )
                    }
                    // D8: anchorRanges flow through MarkdownWebView's
                    // LaunchedEffect into HighlightInjector.
                    val ranges by vm.anchorRanges.collectAsState()
                    val liveTheme = LocalHtmlTheme.current
                    LoadedDocumentBody(
                        loaded = s,
                        liveTheme = liveTheme,
                        anchorRanges = ranges,
                        bridge = bridge,
                        commentsListOpen = commentsListOpen,
                        onCommentsListOpenChange = { commentsListOpen = it },
                        onAfterPost = { vm.refreshAnchors() },
                    )
                }
            }
        }
    }
}

/**
 * The Loaded-state body. Pulled out of [DocumentScreen] so the per-
 * document state (the [ThreadSheetViewModel] keyed on the Loaded
 * snapshot) lives in a Composable whose recomposition lifetime is bound
 * to a single open — re-opening with a different URI rebuilds the VM
 * naturally.
 *
 * Why split here (vs in DocumentScreen):
 *   * `remember(s.uri) { ThreadSheetViewModel(...) }` inside
 *     `DocumentScreen` would be evaluated every recomposition of the
 *     outer Scaffold; nesting it in `LoadedDocumentBody` keeps the
 *     `remember` keyed to the loaded doc rather than the wider screen.
 *   * The Loaded body is the only call site that actually has the
 *     non-null collaborators (store, capability, treeUri). Embedding the
 *     wiring in `DocumentScreen`'s `when` would force everything to
 *     dance around nullable types.
 */
@Composable
private fun LoadedDocumentBody(
    loaded: DocumentUiState.Loaded,
    liveTheme: HtmlTheme,
    anchorRanges: List<dev.mdviewer.render.AnchorRange>,
    bridge: SelectionBridge,
    commentsListOpen: Boolean,
    onCommentsListOpenChange: (Boolean) -> Unit,
    onAfterPost: () -> Unit,
) {
    val ctx = LocalContext.current
    // Per-document ThreadSheetViewModel. Re-keyed on the loaded URI so a
    // different document open rebuilds the VM with the right SaveContext;
    // the store reference comes from Loaded.store which is the same
    // `Arc<CommentsStore>` handle the DocumentViewModel writes mutations
    // through.
    val threadSheetVm = remember(loaded.uri, loaded.store) {
        ThreadSheetViewModelFactory.build(ctx, loaded)
    }

    // E7: bridge → sheet. `HighlightTapped` events come from the JS
    // bridge when the user taps a `<span class="anchored" data-thread-id>`
    // in the rendered HTML. Translate that into an open-existing call.
    LaunchedEffect(bridge, threadSheetVm) {
        bridge.state.collect { event ->
            if (event is SelectionEvent.HighlightTapped) {
                threadSheetVm.openForExisting(event.threadId)
            }
        }
    }

    // E7: drawer thread snapshot. We pull `threads()` once per
    // commentsListOpen flip rather than collecting a Flow because the
    // store handle exposes a synchronous snapshot — re-pulling on
    // every drawer open is cheap and avoids holding a Compose state
    // that mutations would have to invalidate explicitly.
    val drawerThreads: List<Thread> = remember(commentsListOpen, anchorRanges) {
        if (commentsListOpen) loaded.store.threads() else emptyList()
    }

    // The settings flow controls show-resolved persistence. We collect
    // it as a Compose state so toggle flips re-emit through the drawer.
    val settings = remember(ctx) { SettingsStore(ctx.applicationContext) }
    val showResolved by settings.showResolved.collectAsState(initial = false)
    val scope = rememberSettingsCoroutineScope()

    // The whole document body sits in a Box so the WebView, the
    // SelectionPopover (inside ThreadOverlay), and the modal bottom
    // sheets share the same coordinate space and z-order.
    Box(
        modifier = Modifier
            .fillMaxSize()
            // E7: hidden semantic node carrying the active theme. The
            // ThemeSwitchTest E2E asserts on this string after picking
            // Dark in Settings — proves the theme flipped through to the
            // document surface without an Activity restart.
            .semantics { contentDescription = themeContentDescription(liveTheme) },
    ) {
        MarkdownWebView(
            html = loaded.html,
            theme = liveTheme,
            anchorRanges = anchorRanges,
            modifier = Modifier.fillMaxSize(),
            bridge = bridge,
        )

        // ThreadOverlay handles the SelectionPopover (Comment / Copy)
        // when the user has a live selection AND the drawer when the
        // host flips commentsListOpen on.
        ThreadOverlay(
            bridge = bridge,
            onComment = { selection -> threadSheetVm.openForNewThread(selection) },
            modifier = Modifier.fillMaxSize(),
            commentsListOpen = commentsListOpen,
            commentsListThreads = drawerThreads,
            showResolved = showResolved,
            onShowResolvedChange = { newValue ->
                scope.launchSettingsWrite { settings.setShowResolved(newValue) }
            },
            onCommentsListThreadClick = { threadId ->
                onCommentsListOpenChange(false)
                threadSheetVm.openForExisting(threadId)
            },
            onCommentsListDismiss = { onCommentsListOpenChange(false) },
        )

        // ThreadSheet — the bottom sheet that hosts read + post + reply.
        // The composable returns immediately when the VM's state is
        // [ThreadSheetState.Hidden], so it's safe to mount unconditionally.
        ThreadSheet(
            vm = threadSheetVm,
            onPosted = onAfterPost,
        )
    }
}

/**
 * Tiny helper that exposes a coroutine scope for one-shot SettingsStore
 * writes (the show-resolved toggle dispatches through this). Pulled into
 * a separate Composable so the call site reads cleanly and the scope is
 * remembered across recompositions.
 */
@Composable
private fun rememberSettingsCoroutineScope(): SettingsWriteScope {
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    return remember(scope) { SettingsWriteScope(scope) }
}

/**
 * Thin wrapper around a Compose [kotlinx.coroutines.CoroutineScope] that
 * exposes a single suspend-launching method. Keeping it separate from
 * the Composable lets the show-resolved-toggle callback be a stable
 * lambda rather than capturing a fresh scope on every recomposition.
 */
internal class SettingsWriteScope(
    private val scope: kotlinx.coroutines.CoroutineScope,
) {
    fun launchSettingsWrite(block: suspend () -> Unit) {
        scope.launch { block() }
    }
}

// ---------------------------------------------------------------------------
// ThreadSheetViewModelFactory — small builder that constructs a
// ThreadSheetViewModel from an Android [Context] + a Loaded document
// snapshot. We don't go through ViewModelProvider.Factory here because
// the per-document SaveContext changes shape on every open — a
// ViewModelStore-cached instance would carry stale capability/treeUri
// across reopens. The Compose layer's `remember(loaded.uri, loaded.store)`
// keys give us the right invalidation behavior.
// ---------------------------------------------------------------------------
internal object ThreadSheetViewModelFactory {
    fun build(
        ctx: Context,
        loaded: DocumentUiState.Loaded,
    ): ThreadSheetViewModel = ThreadSheetViewModel(
        store = loaded.store,
        sidecar = Sidecar(ctx.applicationContext),
        profile = ProfileStore(ctx.applicationContext),
        saveContext = ThreadSheetViewModel.SaveContext(
            docUri = loaded.uri,
            docFilename = loaded.displayName,
            capability = loaded.capability,
            treeUri = loaded.treeUri,
            sidecarPattern = "{name}.md.comments.json",
        ),
    )
}
