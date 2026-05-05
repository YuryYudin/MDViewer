package dev.mdviewer.e2e.helpers

/**
 * Fixture-reset helper used by the A1 e2e specs.
 *
 * **B5 contract:** every method here intentionally throws
 * `NotImplementedError`. The e2e specs from A1 must stay RED on the emulator
 * (that's the rule-5 contract — those specs are the red→green proof for
 * Phase C/D/E), but the androidTest source set has to *compile* so that the
 * placeholder instrumentation test plus the JaCoCo wiring in B5 are
 * exercisable. Stub bodies here satisfy the compiler; runtime calls fail
 * loudly so nobody mistakes a green CI run for a passing e2e suite.
 *
 * Real implementations land alongside the screens that need them:
 *  - [clearProfileAndRecents]: C1 (profile DataStore + recents store)
 *  - [completeProfileSetupWithDefaults]: C2 (ProfileSetupScreen)
 *  - [setLightTheme]: D6 (theme settings)
 */
object ResetState {
    /**
     * Wipes the profile DataStore and the recents list so the runner starts
     * each spec on a clean install-equivalent state.
     */
    fun clearProfileAndRecents(): Unit =
        throw NotImplementedError("ResetState.clearProfileAndRecents lands in C1")

    /**
     * Walks the profile-setup wizard with default display name + initials so
     * specs that don't care about the wizard can skip past it.
     */
    fun completeProfileSetupWithDefaults(): Unit =
        throw NotImplementedError("ResetState.completeProfileSetupWithDefaults lands in C2")

    /**
     * Forces the light theme regardless of system Dark Mode, so theme-
     * dependent assertions in [dev.mdviewer.e2e.ThemeSwitchTest] start from
     * a known baseline.
     */
    fun setLightTheme(): Unit =
        throw NotImplementedError("ResetState.setLightTheme lands in D6")
}
