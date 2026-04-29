# Releasing

Cutting an MDViewer release is a tag push. CI does the rest.

## What ships

`.github/workflows/release.yml` runs three jobs in parallel on a tag push:

| Job | Runner | Bundles |
|---|---|---|
| macOS (Apple Silicon) | `macos-14`     | `MDViewer_<ver>_aarch64.dmg` |
| Windows               | `windows-latest` | `MDViewer_<ver>_x64_en-US.msi` |
| Linux                 | `ubuntu-22.04` | `MDViewer_<ver>_amd64.deb`, `MDViewer_<ver>_amd64.AppImage`, `MDViewer-<ver>-1.x86_64.rpm` |

Each artifact is uploaded to a **draft** GitHub Release named `MDViewer v<ver>`. The release stays in draft until you click _Publish_ in the GitHub UI — that's the one-step gate that turns "I tagged a release" into "users see this exists."

Intel macOS, code signing, and notarization are intentionally out of scope for now (see the TODO block at the bottom of `release.yml`). Unsigned DMG / MSI work; users get a one-time Gatekeeper / SmartScreen warning.

## The tag dance

Three files carry the version. Bump them together:

```bash
NEW=0.2.0
sed -i.bak -E 's/^(\s*"version"\s*:\s*)"[^"]+"/\1"'"$NEW"'"/' package.json
sed -i.bak -E 's/^(version\s*=\s*)"[^"]+"/\1"'"$NEW"'"/'   src-tauri/Cargo.toml
sed -i.bak -E 's/^(\s*"version"\s*:\s*)"[^"]+"/\1"'"$NEW"'"/' src-tauri/tauri.conf.json
rm -f package.json.bak src-tauri/Cargo.toml.bak src-tauri/tauri.conf.json.bak
```

Then commit + tag + push:

```bash
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore: release v$NEW"
git tag "v$NEW"
git push origin main "v$NEW"
```

The `tags: ['v*']` trigger fires the moment the tag lands. CI takes ~15–20 minutes cold (or ~5 min warm) to populate all three artifacts.

## After CI finishes

1. Go to https://github.com/YuryYudin/MDViewer/releases — your draft release should be at the top, with the artifacts attached.
2. Skim the auto-generated notes (you can replace them with a curated changelog).
3. Smoke-test at least one bundle on its native OS:
   - macOS: download the DMG, drag to Applications, right-click → Open (first-launch only). The status bar should read `MDViewer v$NEW`.
   - Windows / Linux: similar.
4. Click **Publish release** when satisfied.

## Pre-release / smoke-test runs

If you want to dry-run the pipeline without cutting a real release, push from the Actions tab:

1. **Actions → Release → Run workflow**
2. Pick the branch (usually `main`).
3. The job runs against `HEAD` and produces a draft Release with whatever ref name `github.ref_name` resolves to. Delete the draft afterward.

## Rolling back

If a published release is broken:

1. **Don't delete the tag.** Future builds may reference its SHA.
2. Cut a `v$NEW.1` patch release with the fix.
3. Optionally mark the broken release as a pre-release (less prominent in the GitHub UI) and edit its notes to point at the patch.

## Future work

- **Code signing** (`APPLE_CERTIFICATE`, `APPLE_ID`, Windows EV cert) — wires into `tauri-action`'s existing signing flags. The current unsigned bundles trigger user-visible warnings on first launch.
- **Intel macOS** — add a second matrix row for `x86_64-apple-darwin`. Justify the doubling of CI minutes against actual Intel user volume.
- **Auto-changelog** — generate notes from PR titles since the last tag (e.g. `release-drafter` action).
- **Homebrew tap / winget manifest** — once the release cadence is stable.
