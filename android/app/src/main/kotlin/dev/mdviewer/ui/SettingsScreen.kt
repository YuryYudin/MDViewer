// ---------------------------------------------------------------------------
// SettingsScreen — E2 settings surface (wireframes/08-settings.html). The
// screen is a vertically-scrolling Scaffold with four labelled sections:
//
//   * Theme        — Light / Dark / Follow system radio group.
//   * Profile      — display name TextField + 8-swatch palette + Save
//                    button. user_id surfaces as read-only metadata.
//   * Comments     — sidecar pattern TextField + Apply button + show-
//                    resolved Switch.
//   * About        — app version + license note.
//
// Why a single column rather than the wireframe's grouped list-items:
//   * The wireframe is visually a Material list with leading icons, but
//     half of the rows in the wireframe are *navigations* to deeper
//     sub-screens that we don't ship in v1 (Text size, Reattachment
//     confidence). Re-creating the list-item visual without backing
//     navigations would either lie ("tap me, do nothing") or force a
//     bunch of placeholder sub-screens. A flat in-place form is the
//     pragmatic v1 surface — it lands the same controls without
//     pretending the deeper hierarchy exists.
//   * The four section headings preserve the wireframe's information
//     architecture so a second-pass restyle (a future M3 settings list
//     widget) can drop in without re-shuffling the data layout.
//
// Theme change semantics:
//   * Tapping a radio writes through SettingsStore. The flow re-emits
//     and `MdviewerApp`'s `rememberHtmlTheme` recomposes; the resolved
//     [HtmlTheme] in `LocalHtmlTheme` switches and any DocumentScreen
//     that's still on the back-stack picks up the new theme via the
//     WebView's `evaluateJavascript("document.body.dataset.theme=...")`
//     — no full re-render, no scroll-position loss. (See the design
//     spec's success criterion #8: "the change applies immediately".)
//
// Sidecar pattern field:
//   * Accepts any non-blank string. The wireframe's supporting text
//     hints at `{name}` substitution but the design's "do not validate
//     too aggressively" rule says literal patterns ("comments.json")
//     are valid too. The Apply button's `enabled` is bound to the
//     non-blank check; the VM's setter rejects blank independently.
//
// user_id is intentionally read-only:
//   * Changing user_id mid-session would orphan the user's existing
//     comments from their identity (every comment carries the user_id
//     of its author). The UUID is minted once at first launch and
//     surfaces here as `Text(...)` (not a TextField) so the affordance
//     matches the constraint.
// ---------------------------------------------------------------------------
@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package dev.mdviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.mdviewer.BuildConfig
import dev.mdviewer.data.Profile
import dev.mdviewer.data.ThemeMode

/**
 * The Settings surface. Reads its state from [vm] and dispatches every
 * mutation back through it; [onBack] is called when the toolbar's back
 * arrow is tapped (Navigation pops the back stack).
 */
@Composable
fun SettingsScreen(vm: SettingsViewModel, onBack: () -> Unit) {
    val theme by vm.theme.collectAsState()
    val sidecarPattern by vm.sidecarPattern.collectAsState()
    val showResolved by vm.showResolved.collectAsState()
    val profile by vm.profileState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        // E7: "Close settings" matches the ThemeSwitchTest
                        // E2E locator. Earlier phases used "Back"; the
                        // copy change is a strict superset (the e2e
                        // looks up by substring, but unit-tests for the
                        // settings screen do not assert on this string).
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Close settings",
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Lambda wrappers (rather than `vm::setTheme` method references)
            // because the VM setters now return Job — Kotlin's Unit-coercion
            // handles that for `(T) -> Unit` lambda-typed callbacks, but
            // does NOT apply to bound-method references, which would be
            // typed as `(T) -> Job` and fail the lambda type check at
            // each call site.
            ThemeSection(current = theme, onSelect = { vm.setTheme(it) })

            HorizontalDivider()

            ProfileSection(
                profile = profile,
                onSave = { name, color -> vm.updateProfile(name, color) },
            )

            HorizontalDivider()

            CommentsSection(
                sidecarPattern = sidecarPattern,
                onApplyPattern = { vm.setSidecarPattern(it) },
                showResolved = showResolved,
                onToggleShowResolved = { vm.setShowResolved(it) },
            )

            HorizontalDivider()

            AboutSection()
        }
    }
}

@Composable
private fun ThemeSection(current: ThemeMode, onSelect: (ThemeMode) -> Unit) {
    Text("Theme", style = MaterialTheme.typography.titleMedium)
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        ThemeMode.entries.forEach { mode ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onSelect(mode) },
            ) {
                RadioButton(
                    selected = current == mode,
                    onClick = { onSelect(mode) },
                )
                Text(themeLabel(mode))
            }
        }
    }
}

/** User-facing label for a [ThemeMode]. The enum's `name` ("FollowSystem")
 *  is too compact for a settings row; we expand to wireframe-faithful copy
 *  ("Follow system") here so the persisted enum can stay in
 *  PascalCase without leaking into the UI. */
private fun themeLabel(mode: ThemeMode): String = when (mode) {
    ThemeMode.Light -> "Light"
    ThemeMode.Dark -> "Dark"
    ThemeMode.FollowSystem -> "Follow system"
}

@Composable
private fun ProfileSection(
    profile: Profile?,
    onSave: (displayName: String, color: String) -> Unit,
) {
    Text("Profile", style = MaterialTheme.typography.titleMedium)

    if (profile == null) {
        // Initial async load hasn't landed yet. Render a quiet placeholder
        // rather than a spinner — the load is sub-frame on every device
        // we test against, so an animation would flash.
        Text("Loading profile…", style = MaterialTheme.typography.bodyMedium)
        return
    }

    // Local edit state, re-keyed on the profile so a parallel save
    // (e.g. a future settings-sync push) refreshes the visible values.
    var displayName by remember(profile) { mutableStateOf(profile.displayName) }
    var selectedColor by remember(profile) { mutableStateOf(profile.color) }

    OutlinedTextField(
        value = displayName,
        onValueChange = { displayName = it },
        label = { Text("Display name") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )

    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        AuthorPalette.forEachIndexed { index, swatch ->
            Swatch(
                swatch = swatch,
                oneBasedIndex = index + 1,
                selected = selectedColor == swatch.hex,
                onClick = { selectedColor = swatch.hex },
            )
        }
    }

    Button(
        onClick = { onSave(displayName, selectedColor) },
        enabled = displayName.isNotBlank(),
    ) {
        Text("Save profile")
    }

    // user_id is read-only metadata. Showing it here helps support cases
    // (a user reporting "my comments aren't syncing") without requiring
    // a developer-mode escape hatch.
    Text(
        "User ID: ${profile.userId}",
        style = MaterialTheme.typography.labelSmall,
    )
}

@Composable
private fun Swatch(
    swatch: AuthorSwatch,
    oneBasedIndex: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val ringColor: Color = MaterialTheme.colorScheme.primary
    val description = "Color swatch $oneBasedIndex"
    val sizeDp = if (selected) 40.dp else 32.dp

    Box(
        modifier = Modifier
            .semantics { contentDescription = description }
            .size(sizeDp)
            .clip(CircleShape)
            .background(swatch.color)
            .then(
                if (selected) {
                    Modifier.border(width = 3.dp, color = ringColor, shape = CircleShape)
                } else {
                    Modifier
                },
            )
            .clickable(onClick = onClick),
    )
}

@Composable
private fun CommentsSection(
    sidecarPattern: String,
    onApplyPattern: (String) -> Unit,
    showResolved: Boolean,
    onToggleShowResolved: (Boolean) -> Unit,
) {
    Text("Comments", style = MaterialTheme.typography.titleMedium)

    // Sidecar pattern editor.
    var pattern by remember(sidecarPattern) { mutableStateOf(sidecarPattern) }
    OutlinedTextField(
        value = pattern,
        onValueChange = { pattern = it },
        label = { Text("Sidecar pattern") },
        supportingText = { Text("Use {name} as the document stem placeholder") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Button(
        onClick = { onApplyPattern(pattern) },
        enabled = pattern.isNotBlank(),
    ) {
        Text("Apply pattern")
    }

    // Show-resolved toggle.
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                "Show resolved comments",
                style = MaterialTheme.typography.bodyLarge,
            )
            Text(
                "Dimmed in the document, listed in the drawer",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Switch(
            checked = showResolved,
            onCheckedChange = onToggleShowResolved,
        )
    }
}

@Composable
private fun AboutSection() {
    Text("About", style = MaterialTheme.typography.titleMedium)
    Text(
        "MDViewer Android v${BuildConfig.VERSION_NAME}",
        style = MaterialTheme.typography.bodyMedium,
    )
    Text(
        "Licensed under GPL-3.0-or-later",
        style = MaterialTheme.typography.bodySmall,
    )
}
