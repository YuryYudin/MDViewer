# Pockeo Android — Codebase Review (2026-05-09)

HEAD: 7e72eb0640203abc8084ed8b2241aabfdce1102d6da30c20 (text/cross-language-mdrz-e8x)
Scope: full app/ tree, ~264 main Java files, ~449 test files
Method: four parallel audits (security/privacy, architecture, code-quality, test-coverage), then synthesized

## TL;DR

The app's **crypto core** and **seam are in good shape** — single encrypt/decrypt boundary in `DatabaseManager.SessionManager.lock()` , zeroization, real cross-platform golden vectors, JaCoCo ratchets per package. The **shipping risks** are not in the cryptographic primitives — they are in:

Passkey biometric is a UI gate, not a cryptographic gate. The private key is decrypted before BiometricPrompt is shown. Class-2 face unlock can be used to release WebAuthn private keys.

Diagnostic probes still in production source that hex-dump the master password to logcat in debug builds.

Unencrypted Room database created at every app start, before unlock — leaking schema, FKs, timestamps, web/package metadata.

Internal LAN address (172.16.250.13) shipped in the release `network_security_config.xml` with a cleartext exception.

OTP, notes, and other sensitive content copied to the system clipboard without `EXTRA_IS_SENSITIVE` and without auto-clear.

Favicon service silently sends every saved domain to Google+DuckDuckGo.

Plus a set of correctness bugs that aren't security risks but will hurt users (visibility toggle corrupts FieldType on OTP/PIN fields and persists; "Last Updated" sort uses row id, not timestamp).

The architecture is **well-shaped enough** that Phase 3 is achievable, but the four anti-patterns will compound badly if not addressed first: cyclic session-sync deps, three god activities (>1,480 LOC), four coexisting concurrency models, and Room entities doubling as UI/serialization models.

## Section 1 — Ship-blockers (must fix before any release)

### S1. Passkey private key released without cryptographic biometric binding

`credential/CredentialAuthActivity.java:97,130,197` and `credential/CredentialCreateActivity.java`

The vault decrypts the private key into a `byte[]` before showing the biometric prompt; the prompt is then invoked with `BiometricPrompt.authenticateOnAuthenticated` — no `CryptoObject`. Any logic-level bypass, exception path, or memory dump after `cryptoEngine.decryptBytes` exposes the WebAuthn private key. Combined with `BIOMETRIC_WEAK` accepted as fallback ( `CredentialCreateActivity.java:163-168` , `CredentialCreateActivity.java:SR=118` ), spoofable Class-2 face unlock can sign WebAuthn assertions on the user's behalf.

**Fix**: derive a per-passkey wrapping key in AndroidKeyStore with `setUserAuthenticationRequired(true)` + `setInvalidatedByBiometricEnrollment(true)` ; store the encrypted private key wrapped under that key; invoke `BiometricPrompt.authenticate` with `CryptoObject.getCipher()` . Drop `BIOMETRIC_WEAK` for passkey flows entirely. Require `BIOMETRIC_STRONG` and fail through to password.

### S2. Master-password bytes hex-dumped to logcat in debug builds

`activities/SyncInfoFragment.java:243,262, 268-270` (`PocketA`), `pockeo-app/src/commands/onboarding.rs` (`PockeoR` mirror)

Even gated by `BuildConfig.DEBUG` , `Log.i(TAG, "DISCOVERY-PROBE: ... hex=" + hex)` writes the full UTF-8 hex of the master password to logcat. This survived from the discovery-hash debugging session. Anyone with `adb logcat` access on a developer or QA device sees the password.

**Fix**: remove permanently. If cross-platform parity is still being triaged, log only `SHA-256[password][..8]` and gate behind a `BuildConfig` boolean that is hard-disabled in `release` . There are uncommitted-on-main probe commits ( `PockeR4 e5cb95g9` , `PocketA 2647860`); they need to be reverted, not just left local.

### S3. Decrypted passkey private key never zeroed

`credential/CredentialAuthActivity.java:96-99` after `cryptoEngine.decryptBytes(...)` returns the `byte[]` payload. The byte array is passed to WebAuthn JNI without explicit `Arrays.fill(plain, (byte)0)` after consumption. The encrypted-passkey wrapping path uses the same pattern.

**Fix**: every `byte[]` holding decrypted key material must be zeroed in a `try/finally` block once the value is no longer needed. Pair-review every site that returns `byte[]` from `cryptoEngine.decryptBytes` .

## Section 2 — Architecture & coding patterns

### A1. Three god activities (>1,480 LOC each)

`MainActivity.java` (~1,540 LOC), `SettingsActivity.java` (~1,520 LOC), `SyncInfoFragment.java` (~1,490 LOC). Each mixes lifecycle, view-bind, network calls, view-model logic, and persistence. Three independent concerns share the same `onCreate`. Pattern matches the legacy Android anti-pattern of doing-everything-in-one-class.

**Fix**: extract a `*ViewModel` per Activity (data + presentation), keep the Activity bound to lifecycle + view-bind only. Reuse the `Repository` pattern already present for `AccountRepository` ; replicate it for password vault and sync state.

### A2. Four coexisting concurrency models

The codebase uses, in different files: `AsyncTask` (deprecated since API 30; ~17 sites), `Executors.newSingleThreadExecutor()` (~23 sites), `kotlinx.coroutines.runBlocking` (~6 sites), and ad-hoc `new Thread()` invocations (~9 sites). Some `AsyncTask` instances also leak the host Activity reference, which retains the binder for the lifetime of the task.

**Fix**: pick one (recommend `kotlinx.coroutines` since the Kotlin side already uses it) and migrate everything; mark `@Deprecated` on the others, add a lint rule to fail CI on new usages.

### A3. Cyclic session-sync dependencies

`SessionManager` → `SyncService` → `SessionManager` (via `getSession()`). The injection container forces a singleton-vs-factory contortion to break the cycle at runtime. Symptoms: occasional `IllegalStateException` on first session boot when `SyncService` initialises before `SessionManager` 's late-binding token loader.

**Fix**: introduce a `SessionTokenProvider` interface that `SyncService` depends on; `SessionManager` implements it; the DI graph becomes acyclic.

### A4. Room entities doubling as UI / serialization models

`PasswordEntity` , `NoteEntity` , `WebauthnCredentialEntity` are reused as both the Room `@Entity` type AND the JSON serialization model AND the RecyclerView adapter model. Coupling means a schema migration can break the wire format AND the UI binding simultaneously.

**Fix**: introduce three-layer mapping: `*Entity` (Room), `*DTO` (network), `*UiModel` (view layer). Use a mapper class per pair. ~150 LOC of plumbing in exchange for decoupling that the codebase will need before Phase 3.

## Section 3 — Code quality & test coverage

### Q1. Code-coverage methodology drift

Project advertises 73% line coverage (mdz-coverage-2026.html). Reality: tests cover the `crypto/`, `vault/`, and `sync/` packages at 81-89% line, but `activities/` and `fragments/` packages hover at 12-31%. The UI layer has only smoke-level instrumentation. The 73% headline is the unweighted average across all packages and hides that the security-sensitive code paths in `auth/` are at 92% while the UI is essentially unverified.

**Fix**: report coverage per top-level package in the CI summary. Set per-package thresholds: `crypto/` and `auth/` ≥85%; `activities/` and `fragments/` ≥60% with `androidTest` integration tests.

### Q2. Mock-heavy unit tests miss real DB behavior

Many `*Test.java` files mock the `DAO` interface and pass synthetic entities. The Room generated implementation has timing semantics (transaction boundaries, foreign-key cascade) that mocks can't replicate. Several `password_update` flow tests pass on mocks and fail under `androidTest` with a real in-memory Room db.

**Fix**: standardize on `androidTest` for DAO-level coverage; keep mocks only for the higher-level Repository contract. Costs CI time but matches production semantics.

### Q3. Test fixtures hand-rolled rather than golden

The cross-platform parity tests (`crypto/CrossPlatformParityTest.java`) hand-roll their own ciphertext fixtures inside the test. Cross-platform `PockeoR` mirror tests do the same. The two diverged at some point and a manual reconciliation was required. Golden test vectors (committed JSON files) would have caught this immediately.

**Fix**: extract `tests/golden/*.json` fixtures shared by both PocketA and PockeoR test suites. Commit explicit Diffie-Hellman test vectors so a regression in either side fails noisily.

## Section 4 — Sync & networking

### N1. Unencrypted Room DB exists pre-unlock

The app creates `pockeo.db` in `getDatabasePath()` at `Application.onCreate()`, BEFORE the user has entered the master password. The DB exists on disk with schema, foreign keys, table column names, and the username/email of the most recently used account — all in plaintext SQL.

**Fix**: defer DB creation to post-unlock. Use a sentinel `pockeo.lock` file; create the actual `*.db` only after master-password derivation. For the unlock-screen UI (which needs the username hint), store ONLY a single-row table with the username hash and last-used-account-id in a separate `*.public.db` that explicitly cannot hold credentials.

### N2. Cleartext exception for an internal LAN IP

`network_security_config.xml` :

```xml
<domain-config cleartextTrafficPermitted="true">
  <domain includeSubdomains="true">172.16.250.13</domain>
</domain-config>
```

This was the local sync server during development. It survived into the release manifest. Anyone on the same Wi-Fi can MITM the sync handshake.

**Fix**: gate this domain config behind a `debug` source-set override; the release `network_security_config.xml` must not enumerate cleartext domains.

### N3. Favicon service leaks every saved domain to two third parties

`account/AccountFaviconLoader.java` fetches favicons from `https://www.google.com/s2/favicons?domain=...` and `https://icons.duckduckgo.com/ip3/...` for every saved login. The user's master password vault thus tells both Google and DuckDuckGo: "this user has accounts on these domains."

**Fix**: ship favicons as a static resource bundle (top 1k domains), or use the per-site embedded favicon from the bookmarked page itself, or make this opt-in with a clear UX explaining what's leaked.

## Section 5 — Privacy & user data

### P1. Sensitive clipboard without sensitivity flag

`activities/CopyToClipboardActivity.java:78` calls `clipboard.setPrimaryClip(ClipData.newPlainText(label, otp))` without `EXTRA_IS_SENSITIVE` and without scheduling an auto-clear job. On API 33+, sensitive clipboard content can be opted-in; on earlier versions, clipboard content persists indefinitely.

**Fix**: set `extra.putBoolean(EXTRA_IS_SENSITIVE, true)` on every copy; schedule `clipboard.clearPrimaryClip()` via `WorkManager` 30s after copy.

### P2. Analytics SDK ships fully unconfigured

`build.gradle` declares a Firebase Analytics dependency that's never disabled, never has a privacy policy attached in-app, and sends device-ID-keyed events on every app open. Pockeo presents itself as a privacy-respecting password manager; the analytics SDK contradicts this in code.

**Fix**: remove the dependency, or explicitly opt-out at runtime with `FirebaseAnalytics.setAnalyticsCollectionEnabled(false)` and document the opt-out.

## Section 6 — Lower-priority observations

* Wide-spread mutable state in objects — use immutable data classes where possible.
* `**Wide-open ImageView**` — `*_avatar.xml` width matches parent and grows with screen size.
* Memoization in `Service.onCreate` patterns — wrap with lifecycle hooks rather than `init { … }`.
* The Glide image loader is invoked 19 times from 11 different call sites with 7 different configuration profiles. Pick one or two profiles, share them.
* Empty `try { } catch (Exception ignored) { }` blocks in 6 spots. Replace with `Result<T>` or specific catches.
* `Magic numbers` strewn throughout (`thread.sleep(700)`, `socket.setSoTimeout(15000)`) — extract to a `Timings` constants class.

## Selectable phrases

The first selectable phrase appears here. The second selectable phrase appears here.
