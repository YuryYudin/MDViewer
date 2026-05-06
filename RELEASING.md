# Releasing

Cutting an MDViewer release is a tag push. CI does the rest.

## What ships

`.github/workflows/release.yml` runs four jobs in parallel on a tag push:

| Job | Runner | Bundles |
|---|---|---|
| macOS (Apple Silicon) | `macos-14`     | `MDViewer_<ver>_aarch64.dmg` |
| Windows               | `windows-latest` | `MDViewer_<ver>_x64_en-US.msi` |
| Linux                 | `ubuntu-22.04` | `MDViewer_<ver>_amd64.deb`, `MDViewer_<ver>_amd64.AppImage`, `MDViewer-<ver>-1.x86_64.rpm` |
| Android (sideload)    | `ubuntu-latest` | `mdviewer-android-v<ver>.apk` |

Each artifact is uploaded to a **draft** GitHub Release named `MDViewer v<ver>`. The release stays in draft until you click _Publish_ in the GitHub UI — that's the one-step gate that turns "I tagged a release" into "users see this exists." Both the desktop bundle matrix and the Android job must finish green before that Publish click ships anything; a failed Android build leaves the draft missing the APK so it's obvious before users see it.

Intel macOS, desktop code signing, and notarization are intentionally out of scope for now (see the TODO block at the bottom of `release.yml`). Unsigned DMG / MSI work; users get a one-time Gatekeeper / SmartScreen warning.

### Android sideload

The Android APK is signed at build time using a release keystore decoded from CI secrets (see `android/keystore/README.md` for the env-var contract). Users sideload by downloading `mdviewer-android-v<ver>.apk` from the Release page and tapping it in a file manager — Android prompts for "Install unknown apps" the first time the source app (Files / Drive / etc.) tries to launch an installer.

Required CI secrets, configured under **Settings → Secrets and variables → Actions**:

| Secret | Description |
|---|---|
| `ANDROID_RELEASE_KEYSTORE_BASE64` | base64 of the JKS keystore file (no line wrap, e.g. `base64 -w0`) |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_RELEASE_KEY_ALIAS` | key alias inside the keystore |
| `ANDROID_RELEASE_KEY_PASSWORD` | key password (often the same as the keystore password) |

Keep the JKS file itself off the repo and out of CI logs; only the base64 and the passwords flow through Actions. The release-cut workflow decodes the keystore into `android/app/build/release-keystore.jks`, signs `app-release.apk`, and a Gradle finalizer deletes the tmp keystore on success and failure (a workflow step then fails the job if the file somehow survives — leaked keystores are a security incident).

If any of the four secrets are missing, the release `signingConfig` falls back to debug signing for local convenience. The release-cut workflow still uploads the APK, but Play Protect will refuse to install it on non-developer devices — easy to spot during smoke-test before publish.

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

The `tags: ['v*']` trigger fires the moment the tag lands. CI takes ~15–20 minutes cold (or ~5 min warm) to populate the four bundles (desktop trio + Android APK).

## After CI finishes

1. Go to https://github.com/YuryYudin/MDViewer/releases — your draft release should be at the top, with the artifacts attached.
2. Skim the auto-generated notes (you can replace them with a curated changelog).
3. Smoke-test at least one bundle on its native OS:
   - macOS: download the DMG, drag to Applications. With ad-hoc signing
     (in tauri.conf.json since `v0.1.1`), Gatekeeper shows "developer
     cannot be verified" — click OK, go to System Settings → Privacy &
     Security → "Open Anyway". `v0.1.0` was unsigned and shows the
     misleading "is damaged" dialog; users need `xattr -cr
     /Applications/MDViewer.app` for that single release. Confirm the
     status bar reads `MDViewer v$NEW`.
   - Windows / Linux: similar (Windows SmartScreen → "More info → Run anyway").
   - Android: download `mdviewer-android-v$NEW.apk`, transfer to a phone
     (USB / Drive / email) and tap it in a file manager. On first install
     the system prompts for "Install unknown apps" permission for the
     source app (Files, Drive, etc.). Open a `.md` from Drive via
     "Open with → MDViewer" to confirm intent routing works on a real
     device, then verify the Settings screen reads `Version v$NEW` and
     a sample doc renders with the expected theme.
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
