//! Pure path-detection: `is_drive_desktop_path(path, target_os, home)` returns
//! `Some(DriveDesktopRoot)` when the absolute path lies under a known Drive
//! Desktop mount on the given OS. Linux returns `None` (no first-party Drive
//! client; design's stated non-goal).
//!
//! Why `target_os`/`home` are explicit args (not `std::env::consts::OS` /
//! `dirs::home_dir`): so a single CI host can run table-style tests for all
//! three platforms. Production callers pass `std::env::consts::OS` and the
//! resolved home directory; see `drive::file_id::resolve_file_id`.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveDesktopRoot {
    pub root: PathBuf,
    pub mount_kind: MountKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountKind(String);

impl MountKind {
    pub fn as_str(&self) -> &str {
        &self.0
    }
    fn new(s: &str) -> Self {
        Self(s.into())
    }
}

pub fn is_drive_desktop_path(
    path: &Path,
    target_os: &str,
    home: Option<&str>,
) -> Option<DriveDesktopRoot> {
    let s = path.to_string_lossy().to_string();
    match target_os {
        "macos" => {
            if let Some(home) = home {
                let prefix = format!("{}/Library/CloudStorage/GoogleDrive-", home);
                if s.starts_with(&prefix) {
                    let after = &s[prefix.len()..];
                    if let Some(end) = after.find('/') {
                        let root = format!("{}{}", prefix, &after[..end]);
                        return Some(DriveDesktopRoot {
                            root: PathBuf::from(root),
                            mount_kind: MountKind::new("macos-cloudstorage"),
                        });
                    }
                }
            }
            if s.starts_with("/Volumes/GoogleDrive/") {
                return Some(DriveDesktopRoot {
                    root: PathBuf::from("/Volumes/GoogleDrive"),
                    mount_kind: MountKind::new("macos-legacy-volumes"),
                });
            }
            None
        }
        "windows" => {
            // Drive-letter form: `<L>:\My Drive\...`
            if s.len() >= 4 {
                let bytes = s.as_bytes();
                if bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/') {
                    let lower = s.to_lowercase();
                    if lower.contains(r"\my drive\") || lower.contains("/my drive/") {
                        let root: String = s.chars().take(3).collect();
                        return Some(DriveDesktopRoot {
                            root: PathBuf::from(format!("{}My Drive", root)),
                            mount_kind: MountKind::new("windows-drive-letter"),
                        });
                    }
                }
            }
            if let Some(home) = home {
                let prefix = format!(r"{}\Google Drive\", home);
                if s.starts_with(&prefix) {
                    return Some(DriveDesktopRoot {
                        root: PathBuf::from(format!(r"{}\Google Drive", home)),
                        mount_kind: MountKind::new("windows-userprofile"),
                    });
                }
            }
            None
        }
        _ => None,
    }
}
