// ---------------------------------------------------------------------------
// ProfileSetupScreen — first-launch onboarding surface (E1, wireframe
// `wireframes/02-profile-setup.html`). The user supplies a display name +
// picks one of the eight [AuthorPalette] swatches, then taps Continue OR
// taps Skip-for-now to bypass the form. Either action persists a profile;
// the persistence is what trips `ProfileStore.isInitialized()` so the
// next cold start lands on Recents instead of looping the setup screen.
//
// Visual layout matches the wireframe:
//   * Heading "Set up MDViewer" (toolbar copy).
//   * "Pick a display name" supporting heading.
//   * OutlinedTextField labeled "Display name" (semantic label is what the
//     e2e specs target via `onNodeWithText("Display name")`).
//   * "Pick a color" supporting heading.
//   * Eight clickable swatches in a Row. Each carries a stable
//     content-description ("Color swatch 1".."Color swatch 8") so the e2e
//     spec can target a specific swatch without needing a positional
//     query.
//   * Bottom button row: TextButton "Skip for now" + filled Button
//     "Continue". Continue's `enabled` is bound to `vm.canContinue`.
//
// Why content descriptions are stable strings and not generated:
//   * The A1 e2e spec hardcodes "Color swatch 1" — that string is part of
//     the red→green contract and rule-5 forbids editing the spec to match
//     a different surface. So we mint the descriptions in 1-based form.
//
// Why we mount the heading copy "Pick a display name" verbatim:
//   * Same rule — the e2e spec asserts the substring "Pick a display name"
//     is displayed. Using a fancier "What should we call you?" prompt
//     would force a spec edit.
//
// Selection feedback:
//   * The picked swatch grows from 40dp to 48dp and gains an outline ring.
//     This mirrors the wireframe's `.swatch--selected` rule (a 4px ring
//     and a slight scale-up) without trying to be pixel-faithful — the
//     wireframe is a design reference, not a render contract.
// ---------------------------------------------------------------------------
package dev.mdviewer.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileSetupScreen(vm: ProfileSetupViewModel, onDone: () -> Unit) {
    val displayName by vm.displayName.collectAsState()
    val selectedColor by vm.color.collectAsState()
    val canContinue by vm.canContinue.collectAsState()

    Scaffold(
        topBar = { TopAppBar(title = { Text("Set up MDViewer") }) },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Intro blurb mirroring the wireframe — keeps the user informed
            // that everything stays on-device, which matters because the
            // form has no "sign in" affordance and the user might
            // reasonably wonder where their data is going.
            Text(
                "Your name and color are written into every comment you post " +
                    "so collaborators can tell threads apart. Both stay on this " +
                    "device — no account, no sign-in.",
                style = MaterialTheme.typography.bodyMedium,
            )

            // Section heading — substring-match target for the A1 e2e spec.
            // Keep the literal text or update both sides in the same PR.
            Text(
                "Pick a display name",
                style = MaterialTheme.typography.titleMedium,
            )

            OutlinedTextField(
                value = displayName,
                onValueChange = vm::setDisplayName,
                label = { Text("Display name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            Text(
                "Pick a color",
                style = MaterialTheme.typography.titleMedium,
            )

            // Swatch row. The wireframe lays them out 4-up but the row also
            // fits on most phones because each swatch is 40dp; if a future
            // device shrinks below 360dp we can swap this for a FlowRow
            // without changing the persistence contract.
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                AuthorPalette.forEachIndexed { index, swatch ->
                    SwatchDot(
                        swatch = swatch,
                        // 1-based index in the content description so the
                        // e2e spec's "Color swatch 1" target is the FIRST
                        // wireframe swatch (red), not a 0-indexed surprise.
                        oneBasedIndex = index + 1,
                        selected = selectedColor == swatch.hex,
                        onClick = { vm.setColor(swatch.hex) },
                    )
                }
            }

            // Push the action row to the bottom of the form. We don't use
            // Spacer(weight=1f) inside an arrangement-spaced-by Column
            // because that interacts oddly with the inter-child spacing;
            // a fixed gap is fine for the single-screen layout.
            Spacer(modifier = Modifier.size(24.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
            ) {
                TextButton(onClick = { vm.skip(onDone) }) {
                    Text("Skip for now")
                }
                Button(
                    onClick = { vm.saveAndContinue(onDone) },
                    enabled = canContinue,
                ) {
                    Text("Continue")
                }
            }
        }
    }
}

/**
 * One swatch in the picker. Renders a 40dp circle (48dp + outline ring
 * when picked) backed by the swatch [color]. Clicks dispatch through
 * [onClick]; the content description "Color swatch N" carries the
 * 1-based index so the A1 e2e spec can target a specific swatch.
 */
@Composable
private fun SwatchDot(
    swatch: AuthorSwatch,
    oneBasedIndex: Int,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val ringColor: Color = MaterialTheme.colorScheme.primary
    val description = "Color swatch $oneBasedIndex"
    val sizeDp = if (selected) 48.dp else 40.dp

    // Box rather than Column with empty children: Box reports its modifier-
    // declared size even when it has no content, which is exactly what we
    // need for a swatch that's a coloured circle. An empty Column collapses
    // to zero size (Compose treats children-less containers as
    // visibility-collapsed in the test semantics tree), which would make
    // the assertIsDisplayed assertions in the screen test go red.
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
