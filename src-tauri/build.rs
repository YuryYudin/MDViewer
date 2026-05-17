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
    // Windows targets need the `.exe` suffix — tauri_build's externalBin
    // resolver appends it on Windows. Without it, Windows release builds
    // fail with `resource path 'binaries\mdviewer-askpass-...exe' doesn't
    // exist` even though the placeholder under `binaries/` is present.
    let suffix = if target_triple.contains("windows") { ".exe" } else { "" };
    let helper_dest =
        binaries_dir.join(format!("mdviewer-askpass-{}{}", target_triple, suffix));

    // Tauri's `externalBin` codegen resolves the suffixed file at compile
    // time. A 0-byte placeholder satisfies the existence check; cargo builds
    // the real `mdviewer-askpass` binary as a normal workspace bin in the
    // same pass (declared via [[bin]] in Cargo.toml), landing at
    // `target/<profile>/mdviewer-askpass` where dev-mode resource resolution
    // picks it up. Release builds (`cargo tauri build`) get the real bytes
    // via release.yml's explicit `cargo build --release --bin mdviewer-askpass`
    // step which copies the binary into `src-tauri/binaries/<triple>` before
    // `tauri build` runs.
    //
    // We deliberately do NOT invoke a recursive sub-cargo here: the inner
    // `cargo build --bin mdviewer-askpass` blocks on the outer cargo's
    // target-directory lock, deadlocking any nested invocation (e.g. the
    // codegen test in `tests/codegen.test.ts` and B5's WDIO suite).
    if !helper_dest.exists() {
        std::fs::write(&helper_dest, b"").expect("write askpass placeholder");
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
