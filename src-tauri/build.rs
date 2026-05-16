use std::path::PathBuf;
use std::process::Command;

fn main() {
    // ----------------------------------------------------------------------------
    // A9 review-cycle-1 fix: produce `binaries/mdviewer-askpass-<triple>` before
    // tauri_build::build() runs.
    //
    // The `externalBin` declaration in tauri.conf.json forces `tauri_build`'s
    // codegen step to resolve the target-triple-suffixed file at compile time
    // — even on plain `cargo build` (not just `cargo tauri build`). Without
    // the file in place, the first `cargo build -p mdviewer` after `git clone`
    // aborts with `resource path 'binaries/mdviewer-askpass-<triple>' doesn't
    // exist`.
    //
    // Strategy:
    //   1. Always create the destination file (empty placeholder if missing)
    //      BEFORE tauri_build::build() so codegen resolves on a fresh
    //      checkout.
    //   2. On Unix outer builds (sentinel env var absent), invoke a sub-cargo
    //      to build the helper bin and overwrite the placeholder with the
    //      real binary. The inner invocation re-enters this build.rs with
    //      the sentinel set, which skips step 2's recursion. The empty
    //      placeholder written in step 1 satisfies tauri_build for the
    //      inner build.
    //   3. On Windows, leave the placeholder empty — Windows uses the russh
    //      in-process auth callback and never invokes the helper. The bin
    //      target builds to a stub `main` that exits non-zero if accidentally
    //      called (see src-tauri/src/bin/mdviewer-askpass.rs `#[cfg(not(unix))]`).
    // ----------------------------------------------------------------------------
    let target_triple = std::env::var("TARGET").unwrap_or_default();
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binaries_dir = manifest_dir.join("binaries");
    std::fs::create_dir_all(&binaries_dir).expect("create src-tauri/binaries dir");
    let helper_dest = binaries_dir.join(format!("mdviewer-askpass-{}", target_triple));

    // Step 1: empty placeholder so tauri_build's resource-path check passes
    // even on the very first build (before the recursive cargo invocation
    // has produced the real bin).
    if !helper_dest.exists() {
        std::fs::write(&helper_dest, b"").expect("write askpass placeholder");
    }

    // Step 2: outer-build recursive helper build (Unix only).
    let is_recursive = std::env::var("MDVIEWER_BUILD_HELPER_RUNNING").is_ok();
    let is_windows_target = target_triple.contains("windows");
    if !is_recursive && !is_windows_target {
        let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".into());
        let cargo_bin = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let target_dir = std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| manifest_dir.parent().unwrap().join("target"));

        let mut cmd = Command::new(&cargo_bin);
        cmd.args(["build", "--bin", "mdviewer-askpass", "--manifest-path"])
            .arg(manifest_dir.join("Cargo.toml"));
        if profile == "release" {
            cmd.arg("--release");
        }
        let triple_subdir = std::env::var("CARGO_BUILD_TARGET").unwrap_or_default();
        if !triple_subdir.is_empty() {
            cmd.args(["--target", &triple_subdir]);
        }
        // Sentinel: the recursive build.rs invocation observes this env var
        // and skips both this whole helper-build block AND any other costly
        // outer-only work. Without it the recursion is unbounded.
        cmd.env("MDVIEWER_BUILD_HELPER_RUNNING", "1");
        let status = cmd
            .status()
            .expect("invoke cargo to build mdviewer-askpass helper bin");
        if !status.success() {
            panic!(
                "cargo build --bin mdviewer-askpass exited {:?}",
                status.code()
            );
        }
        let produced = if triple_subdir.is_empty() {
            target_dir.join(&profile).join("mdviewer-askpass")
        } else {
            target_dir
                .join(&triple_subdir)
                .join(&profile)
                .join("mdviewer-askpass")
        };
        if !produced.exists() {
            panic!(
                "mdviewer-askpass not found at {} after recursive cargo build",
                produced.display(),
            );
        }
        std::fs::copy(&produced, &helper_dest).unwrap_or_else(|e| {
            panic!(
                "copy {} -> {} failed: {e}",
                produced.display(),
                helper_dest.display()
            )
        });
    }
    println!("cargo:rerun-if-changed=src/bin/mdviewer-askpass.rs");

    tauri_build::build();

    let commit = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=MDVIEWER_COMMIT_HASH={}", commit);

    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
    println!("cargo:rustc-env=MDVIEWER_VERSION={}", version);

    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=Cargo.toml");
}
