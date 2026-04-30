//! A7: Backend lifecycle tests — `Tab::compute_backend` flips between Local
//! and DriveDesktop based on (path, drive_connected). DriveApi tabs (set by
//! B2 from `drive_open_url`) are out of scope for `compute_backend` because
//! the upgrade decision needs a network round-trip; the recompute on
//! disconnect leaves them unchanged (they go read-only and prompt for
//! reconnect rather than downgrading to Local).

use mdviewer_lib::drive::TabBackend;
use mdviewer_lib::workspace::Tab;
use std::path::Path;

#[test]
fn backend_lifecycle_local_upgrades_to_drive_desktop_on_connect() {
    // macOS Drive Desktop CloudStorage path. Setting HOME so detect.rs's
    // platform-specific prefix match resolves regardless of whose box runs
    // the test.
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
fn drive_connect_handler_leaves_b6_replay_marker() {
    // B6's first verification step requires that A7 leave EXACTLY two
    // `// TODO(B6): replay queues here` markers behind: one in main.rs's
    // drive_connect IPC handler body, and one inside run_polling_loop's
    // post-poll iteration body. We check the count is >= 2 here; B6 will
    // grep for it later and replace.
    let main_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs"),
    )
    .expect("read main.rs");
    let workspace_rs = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/workspace.rs"),
    )
    .expect("read workspace.rs");
    let total = main_rs.matches("TODO(B6): replay queues here").count()
        + workspace_rs.matches("TODO(B6): replay queues here").count();
    assert_eq!(
        total, 2,
        "expected exactly two `TODO(B6): replay queues here` markers across main.rs+workspace.rs (one in drive_connect, one in run_polling_loop), found {total}"
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
        "pub(crate) fn config_dir(",
        "pub async fn run_polling_loop(",
    ] {
        assert!(
            workspace_rs.contains(needle),
            "workspace.rs must contain `{needle}`"
        );
    }
}
