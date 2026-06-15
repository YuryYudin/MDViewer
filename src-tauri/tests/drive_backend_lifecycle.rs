//! A7: Backend lifecycle tests — `Tab::compute_backend` flips between Local
//! and DriveDesktop based on (path, drive_connected). DriveApi tabs (set by
//! B2 from `drive_open_url`) are out of scope for `compute_backend` because
//! the upgrade decision needs a network round-trip; the recompute on
//! disconnect leaves them unchanged (they go read-only and prompt for
//! reconnect rather than downgrading to Local).

// These imports back the macOS-gated tests below. On other platforms the
// `compute_backend` assertions are skipped, so the symbols would otherwise
// look unused to clippy. Gating the imports keeps `-D warnings` clean
// without `#[allow(unused_imports)]`.
#[cfg(target_os = "macos")]
use mdviewer_lib::drive::TabBackend;
#[cfg(target_os = "macos")]
use mdviewer_lib::workspace::Tab;
#[cfg(target_os = "macos")]
use std::path::Path;

#[cfg(target_os = "macos")]
#[serial_test::serial]
#[test]
fn backend_lifecycle_local_upgrades_to_drive_desktop_on_connect() {
    // macOS Drive Desktop CloudStorage path. Setting HOME so detect.rs's
    // platform-specific prefix match resolves regardless of whose box runs
    // the test.
    //
    // Gated to macOS because Tab::compute_backend dispatches on
    // std::env::consts::OS, so the assertion would fail on Linux/Windows CI.
    // Tagged #[serial_test::serial] because it mutates the process-global
    // HOME env var, which is not thread-safe under cargo's default parallel
    // test runner.
    std::env::set_var("HOME", "/Users/alice");
    let drive_path = Path::new(
        "/Users/alice/Library/CloudStorage/GoogleDrive-alice@gmail.com/My Drive/notes.md",
    );

    // Disconnected → Local regardless of whether the path is under a Drive
    // Desktop mount. Connecting upgrades to DriveDesktop because the
    // detection function returns Some for that path.
    assert_eq!(
        Tab::compute_backend(drive_path, false),
        TabBackend::Local,
        "disconnected drive paths should be Local"
    );
    assert_eq!(
        Tab::compute_backend(drive_path, true),
        TabBackend::DriveDesktop,
        "connected drive-desktop paths should upgrade to DriveDesktop"
    );

    // A non-Drive path stays Local even when connected.
    let local_path = Path::new("/Users/alice/Documents/notes.md");
    assert_eq!(
        Tab::compute_backend(local_path, true),
        TabBackend::Local,
        "non-drive paths must stay Local even when connected"
    );
}

/// Fix 1 regression test: drive_disconnect must downgrade DriveDesktop tabs
/// back to Local. The bug fixed here was that drive_disconnect read the
/// settings.cloud.drive.connected flag (still true at the moment of call)
/// and passed that into `recompute_backends_after_connect_change`, leaving
/// DriveDesktop tabs incorrectly connected. The fix passes `false`
/// explicitly so the disconnect intent doesn't depend on a settings
/// round-trip.
///
/// Gated to macOS for the same reason as the test above (and because we
/// open a real tab whose path lives under a CloudStorage prefix that only
/// exists on macOS).
#[cfg(target_os = "macos")]
#[serial_test::serial]
#[test]
fn drive_disconnect_downgrades_drive_desktop_tab_to_local() {
    use mdviewer_lib::workspace::{OpenOpts, OpenOutcome, Workspace};

    std::env::set_var("HOME", "/Users/alice");

    // Build a temp data dir + a real markdown file inside a synthetic Drive
    // Desktop mount. We have to drop the file on disk first (open_document
    // reads it through the canonicalize+read_to_string pair) so we mirror
    // the CloudStorage layout under a tempdir HOME.
    //
    // We canonicalize the synthetic HOME because open_document calls
    // path.canonicalize() before computing the backend, and on macOS that
    // resolves `/var/folders/...` to `/private/var/folders/...`. Without
    // this matching round-trip the detect.rs prefix match would miss.
    let tmp = tempfile::TempDir::new().unwrap();
    let home_raw = tmp.path().join("alice-home");
    std::fs::create_dir_all(&home_raw).unwrap();
    let home = home_raw.canonicalize().unwrap();
    let drive_root = home
        .join("Library")
        .join("CloudStorage")
        .join("GoogleDrive-alice@gmail.com")
        .join("My Drive");
    std::fs::create_dir_all(&drive_root).unwrap();
    let doc_path = drive_root.join("notes.md");
    std::fs::write(&doc_path, "# hello").unwrap();

    // Point HOME at the canonicalized synthetic root so detect.rs's prefix
    // match resolves against the canonicalized doc path.
    std::env::set_var("HOME", &home);

    let data_dir = tmp.path().join("data");
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut ws = Workspace::new(&data_dir).unwrap();

    // Flip the connected flag so open_document picks DriveDesktop as the
    // backend for the new tab.
    ws.settings_store_mut()
        .update(|s| {
            s.cloud.drive.connected = true;
        })
        .unwrap();

    let outcome = ws.open_document(&doc_path, OpenOpts::default()).unwrap();
    let tab_id = match outcome {
        OpenOutcome::Document(r) => r.tab_id,
        OpenOutcome::Conflict { .. } => panic!("expected Document on first open"),
        OpenOutcome::ExternalReload { .. } => panic!("expected Document on first open"),
    };
    assert_eq!(
        ws.tab(&tab_id).unwrap().backend,
        TabBackend::DriveDesktop,
        "tab must start as DriveDesktop while connected"
    );

    // The bug: drive_disconnect was reading the still-true settings flag
    // and passing it to recompute, leaving the tab's backend at
    // DriveDesktop. The fix passes `false` explicitly. Note that we leave
    // the settings flag alone here on purpose — the regression test is
    // exactly that disconnect must NOT depend on the flag's current value.
    ws.drive_disconnect();

    assert_eq!(
        ws.tab(&tab_id).unwrap().backend,
        TabBackend::Local,
        "drive_disconnect must downgrade DriveDesktop tabs to Local even when the settings.connected flag has not yet been flipped"
    );
}

#[test]
fn ipc_main_rs_declares_seven_drive_commands() {
    // Source-level smoke that all seven IPC commands defined in this task
    // exist as `#[tauri::command] fn`s in main.rs and are registered in the
    // invoke_handler! macro. Mirrors the existing `ipc_registration` tests'
    // approach since the binary crate can't be linked from an integration
    // test crate.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    for cmd in [
        "drive_connect",
        "drive_disconnect",
        "drive_status",
        "drive_open_url",
        "drive_resolve_path",
        "drive_get_collaborators",
        "is_drive_desktop_path",
    ] {
        assert!(
            main_rs.contains(&format!("fn {cmd}(")),
            "main.rs must declare `fn {cmd}(...)`"
        );
        assert!(
            main_rs.contains(&format!("            {cmd},")),
            "main.rs must register `{cmd}` in the invoke_handler! list"
        );
    }
}

#[test]
fn drive_connect_handler_calls_spawn_replay_all() {
    // A7 left `// TODO(B6): replay queues here` markers behind in two
    // places (drive_connect + run_polling_loop) which B6 has since filled
    // in. The replacement is the `spawn_replay_all` fan-out call in
    // drive_connect plus an inline `drive::queue::replay(` call inside the
    // polling loop's spawn_blocking body. We assert *both* call sites are
    // present so a future regression that drops the wiring is caught at
    // build time. A6's free-form prose markers are no longer required.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    let workspace_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/workspace.rs"),
    )
    .expect("read workspace.rs");
    assert!(
        main_rs.contains("spawn_replay_all"),
        "main.rs drive_connect handler must call drive::queue::spawn_replay_all"
    );
    assert!(
        workspace_rs.contains("drive::queue::replay"),
        "workspace.rs run_polling_loop must call drive::queue::replay inline"
    );
}

#[test]
fn workspace_exposes_id_maps_arc_clone_for_b6_fanout() {
    // B6's `spawn_replay_all` fan-out calls this to clone the per-file_id
    // Arc<Mutex<IdMap>> handles without holding the Workspace lock for the
    // duration of every API roundtrip. A freshly-opened workspace returns
    // an empty map (nothing inserted yet), proving the accessor is callable
    // without panic before any Drive tab is opened.
    use mdviewer_lib::workspace::Workspace;
    let tmp = tempfile::TempDir::new().unwrap();
    let ws = Workspace::new(tmp.path()).unwrap();
    let arcs = ws.id_maps_arc_clone();
    assert!(arcs.is_empty(), "id_maps starts empty");
}

#[test]
fn workspace_source_declares_config_dir_and_pollable_state() {
    // Source-level smoke that the Workspace struct gained the new fields
    // A7's done-when calls out: `config_dir: PathBuf`, `drive_queues`,
    // `id_maps`, and `last_drive_status`. Mirrors the source-level pattern
    // used elsewhere in this test file since the visibility is `pub(crate)`
    // and integration tests can't observe crate-private fields directly.
    let workspace_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/workspace.rs"),
    )
    .expect("read workspace.rs");
    for needle in [
        "config_dir: PathBuf",
        "drive_queues: HashMap<String, DriveQueue>",
        "id_maps: HashMap<String, Arc<Mutex<IdMap>>>",
        "last_drive_status: Option<DriveStatus>",
        // B6 promoted `config_dir` from `pub(crate)` to `pub` so the
        // drive_connect IPC handler in main.rs can pass the path into
        // `spawn_replay_all` without a second managed-state slot.
        "pub fn config_dir(",
        "pub async fn run_polling_loop(",
    ] {
        assert!(
            workspace_rs.contains(needle),
            "workspace.rs must contain `{needle}`"
        );
    }
}
