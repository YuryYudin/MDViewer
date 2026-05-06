# Android keystore

This directory contains the **debug** keystore (`debug.keystore`) — checked in
intentionally. It is the standard Android default-debug keystore (alias
`androiddebugkey`, password `android`); having it here means CI emulator runs
and local sideloads work without touching local Android Studio defaults.

The debug keystore signs `app-debug.apk` only. Anyone who has cloned the repo
holds it, so it grants nothing beyond `adb install` parity with Android
Studio's auto-generated key.

## Release keystore

**The release keystore is NOT in this directory.** It lives in CI secrets
and is decoded at build time. The release `signingConfig` in
`app/build.gradle.kts` reads four env vars:

| Variable | Description |
|---|---|
| `ANDROID_RELEASE_KEYSTORE_BASE64` | base64 of the JKS file (no wrap, e.g. `base64 -w0`) |
| `ANDROID_RELEASE_KEY_ALIAS` | alias inside the keystore |
| `ANDROID_RELEASE_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_RELEASE_KEY_PASSWORD` | key password (often the same as keystore password) |

When CI runs `./gradlew :app:assembleRelease`, the build script:

1. Decodes `ANDROID_RELEASE_KEYSTORE_BASE64` into
   `app/build/release-keystore.jks`.
2. Signs the APK using the four env vars.
3. Deletes the tmp keystore in the `cleanupReleaseKeystore` finalizer
   (runs on success AND failure — leaked keystores are a security
   incident).

If `ANDROID_RELEASE_KEYSTORE_BASE64` is not set, the release config falls
back to debug signing so local `./gradlew :app:assembleRelease` doesn't
break — the APK is signed with an obviously non-production cert and can
never be confused for a release.

## versionCode / versionName

| Field | Source |
|---|---|
| `versionCode` | `${GITHUB_RUN_NUMBER:-1}` — monotonic per CI run; defaults to `1` for local |
| `versionName` | `git describe --tags --abbrev=0`, fallback `0.0.0-dev` |

Do NOT switch `versionCode` to `git rev-list --count` — rebases and
fast-forward merges change the count, which violates Play Store's
strictly-increasing-versionCode rule.

## Local verification

To exercise the env-var path locally with the debug keystore:

```bash
cd android
ANDROID_RELEASE_KEYSTORE_BASE64="$(base64 -w0 keystore/debug.keystore)" \
ANDROID_RELEASE_KEY_ALIAS=androiddebugkey \
ANDROID_RELEASE_KEYSTORE_PASSWORD=android \
ANDROID_RELEASE_KEY_PASSWORD=android \
./gradlew :app:assembleRelease

ls app/build/outputs/apk/release/app-release.apk    # exists
ls app/build/release-keystore.jks 2>/dev/null \
  || echo "tmp keystore cleaned up correctly"
```

The tmp keystore must NOT exist after the build.
