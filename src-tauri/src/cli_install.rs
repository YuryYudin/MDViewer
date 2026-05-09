//! macOS shell-tool installer.
//!
//! `.dmg` payloads can't run a postinstall hook, so on macOS the README's
//! `mdviewer notes.md` example doesn't work out of the box — the executable
//! lives inside `MDViewer.app/Contents/MacOS/MDViewer` and is not on `$PATH`.
//! The polished-app convention (VS Code, iTerm2, Sublime Text) is an in-app
//! menu item that drops a `/usr/local/bin/<name>` symlink to the running
//! binary, prompting the user for an admin password via `osascript`. This
//! module is the Rust side of that flow.
//!
//! The functions are macOS-only (`#[cfg(target_os = "macos")]`); the menu
//! never surfaces them on other platforms, so non-macOS builds don't even
//! compile this code.

#[cfg(target_os = "macos")]
pub const SYMLINK_PATH: &str = "/usr/local/bin/mdviewer";

/// Decide whether to surface the first-run "Install command line tool?" prompt.
///
/// Inputs are explicit so the function stays pure — callers pass the loaded
/// settings (so we don't reach into `SettingsStore` and complicate testing)
/// and a path-existence boolean (so unit tests don't depend on `/usr/local/bin`
/// being writable on the test runner's machine). The logic is:
///
/// - If a `mdviewer` symlink already exists at the canonical path, skip:
///   the user (or some prior install) already wired this up.
/// - If `cli_install_prompt_seen_for` matches the current prompt version,
///   skip: they already saw and answered this prompt.
/// - Otherwise, show.
///
/// This function is target-agnostic so the unit tests run on the Linux CI
/// runner; the *caller* gates the prompt to macOS at the menu/startup wiring.
pub fn should_show_first_run_prompt(
    seen_for: &str,
    current_version: &str,
    symlink_already_exists: bool,
) -> bool {
    if symlink_already_exists {
        return false;
    }
    seen_for != current_version
}

/// Build the AppleScript snippet that installs the symlink.
///
/// Single-quoted shell literals are used to defend against spaces in the
/// app path (e.g. iCloud-synced `~/Applications` paths can contain them).
/// The single embedded apostrophe escape `'\''` lets us round-trip an
/// apostrophe inside a single-quoted string in case the install path
/// contains one (`/Users/it's-mine/MDViewer.app/...`).
#[cfg(target_os = "macos")]
pub fn build_install_script(binary: &std::path::Path) -> String {
    let escaped = binary.display().to_string().replace('\'', "'\\''");
    format!(
        "do shell script \"mkdir -p /usr/local/bin && ln -sf '{escaped}' '{SYMLINK_PATH}'\" with administrator privileges"
    )
}

/// Build the AppleScript snippet that removes the symlink. Uses `rm -f` so
/// the operation is idempotent — clicking Uninstall when nothing is there
/// must succeed silently rather than surface an error.
#[cfg(target_os = "macos")]
pub fn build_uninstall_script() -> String {
    format!(
        "do shell script \"rm -f '{SYMLINK_PATH}'\" with administrator privileges"
    )
}

/// Outcome of an `osascript`-driven install/uninstall attempt.
///
/// `Cancelled` carries the AppleScript code -128 case so callers can stay
/// silent rather than annoy the user with a "you cancelled" dialog.
#[cfg(target_os = "macos")]
#[derive(Debug)]
pub enum CliInstallError {
    Cancelled,
    Failed(String),
}

#[cfg(target_os = "macos")]
impl std::fmt::Display for CliInstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("cancelled by user"),
            Self::Failed(s) => f.write_str(s),
        }
    }
}

/// Run a `do shell script ... with administrator privileges` AppleScript via
/// `osascript`. Returns Ok on exit 0, Cancelled when the user dismissed the
/// auth prompt, Failed otherwise.
#[cfg(target_os = "macos")]
fn run_osascript(script: &str) -> Result<(), CliInstallError> {
    let output = std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| CliInstallError::Failed(format!("osascript spawn failed: {e}")))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    // AppleScript code -128 is "User canceled" — the user clicked Cancel on
    // the admin prompt. We treat that as a no-op rather than an error.
    if stderr.contains("(-128)") || stderr.contains("User canceled") {
        return Err(CliInstallError::Cancelled);
    }
    Err(CliInstallError::Failed(format!(
        "osascript exit {}: {}",
        output.status,
        stderr.trim()
    )))
}

/// Drop a `/usr/local/bin/mdviewer` symlink pointing at the currently-running
/// executable. Asks for admin privileges via the standard macOS auth prompt.
#[cfg(target_os = "macos")]
pub fn install_symlink() -> Result<std::path::PathBuf, CliInstallError> {
    let exe = std::env::current_exe()
        .map_err(|e| CliInstallError::Failed(format!("current_exe: {e}")))?;
    run_osascript(&build_install_script(&exe))?;
    Ok(SYMLINK_PATH.into())
}

/// Remove `/usr/local/bin/mdviewer`. Idempotent: succeeds even if nothing was
/// installed (the underlying `rm -f` is silent on a missing target).
#[cfg(target_os = "macos")]
pub fn uninstall_symlink() -> Result<(), CliInstallError> {
    run_osascript(&build_uninstall_script())
}

#[cfg(test)]
mod prompt_tests {
    use super::*;

    /// Fresh install: nothing on disk, never asked → prompt.
    #[test]
    fn fresh_user_gets_prompted() {
        assert!(should_show_first_run_prompt("", "v1", false));
    }

    /// Existing user upgrading from a pre-prompt version: their settings.toml
    /// has no `cli_install_prompt_seen_for` field, which deserializes to "".
    /// Equivalent to the fresh case from the predicate's POV.
    #[test]
    fn upgrading_user_gets_prompted_once() {
        assert!(should_show_first_run_prompt("", "v1", false));
    }

    /// User already saw and dismissed this prompt → silent on next launch.
    #[test]
    fn already_seen_skips_prompt() {
        assert!(!should_show_first_run_prompt("v1", "v1", false));
    }

    /// User installed via the menu (or a brew cask, or sideloaded) → don't
    /// pester them about installing something they already have.
    #[test]
    fn existing_symlink_skips_prompt_even_if_never_seen() {
        assert!(!should_show_first_run_prompt("", "v1", true));
    }

    /// Future release bumps `CURRENT_CLI_INSTALL_PROMPT_VERSION` to "v2";
    /// users whose stored value is still "v1" should be re-prompted —
    /// unless they already have the symlink installed.
    #[test]
    fn version_bump_reprompts_when_no_symlink() {
        assert!(should_show_first_run_prompt("v1", "v2", false));
    }

    #[test]
    fn version_bump_does_not_reprompt_when_symlink_present() {
        assert!(!should_show_first_run_prompt("v1", "v2", true));
    }
}

#[cfg(test)]
#[cfg(target_os = "macos")]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn install_script_contains_mkdir_ln_and_target_paths() {
        let s = build_install_script(Path::new(
            "/Applications/MDViewer.app/Contents/MacOS/MDViewer",
        ));
        assert!(s.contains("mkdir -p /usr/local/bin"), "script={s}");
        assert!(s.contains("ln -sf"), "script={s}");
        assert!(
            s.contains("/Applications/MDViewer.app/Contents/MacOS/MDViewer"),
            "script={s}",
        );
        assert!(s.contains(SYMLINK_PATH), "script={s}");
        assert!(
            s.contains("with administrator privileges"),
            "script={s}",
        );
    }

    #[test]
    fn install_script_escapes_apostrophes_in_binary_path() {
        // The shell snippet is single-quoted; an unescaped apostrophe in
        // the path would terminate the quoted string and break the command.
        // The escape sequence `'\''` closes, escapes, reopens.
        let s = build_install_script(Path::new("/Users/it's-mine/MDViewer"));
        assert!(s.contains("'\\''"), "script={s}");
        // The unescaped substring should not appear inside the single
        // quotes (i.e. there should be no bare `it's-mine` between two
        // matching single quotes).
        assert!(!s.contains("'it's-mine"), "script={s}");
    }

    #[test]
    fn uninstall_script_uses_force_remove() {
        let s = build_uninstall_script();
        // -f is what makes the operation idempotent. Without it a missing
        // symlink would surface as a non-zero exit and we'd show a spurious
        // failure dialog.
        assert!(s.contains("rm -f"), "script={s}");
        assert!(s.contains(SYMLINK_PATH), "script={s}");
        assert!(
            s.contains("with administrator privileges"),
            "script={s}",
        );
    }
}
