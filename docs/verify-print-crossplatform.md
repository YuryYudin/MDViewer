# Cross-platform PDF-export verification

This document is the **repeatable connect-and-run procedure** for verifying that
the per-OS "Export to PDF" backend in `src-tauri/src/pdf.rs` produces a valid,
content-bearing PDF on each desktop platform.

It is a **connect-and-run verification against the team's existing build agents —
not standing CI.** There is deliberately no MDViewer Jenkins pipeline or GitHub
Actions workflow for this (see the phase Non-Goals): we run one portable smoke on
each real OS by hand and record the result.

## What is being verified

`export_pdf` (the Tauri IPC command and the headless `--export-pdf` entry point)
drives a different webview print backend per OS:

| OS | Backend (`src-tauri/src/pdf.rs`) | Print API |
| --- | --- | --- |
| Linux | WebKitGTK | `WebKitPrintOperation` → print-to-file PDF |
| Windows | WebView2 | `ICoreWebView2_7::PrintToPdf` |
| macOS | WKWebView | `NSPrintOperation` / `printOperation(with:)` (honors `@media print`) |

Because each backend is reachable only on its own OS, the only way to validate
all three is to run the **same** smoke on each platform. We use the portable
headless smoke D1 produced:

```
node e2e/export-pdf-smoke.mjs <binary>
# equivalently, via the npm script:
npm run test:e2e:pdf -- <binary>
```

The smoke spawns the built binary in headless export mode
(`<binary> --export-pdf e2e/fixtures/print-sample.md <tmp>/out.pdf`), starts its
own Vite dev server so the debug binary's WebView has a frontend to load, and then
asserts the output PDF:

1. exit code `0`,
2. starts with the `%PDF-` signature,
3. is above a blank-PDF size floor (3000 bytes), and
4. declares at least one `/Page` object plus a non-trivial `/Contents` stream.

A blank or empty-DOM export fails (2)-(4). The smoke prints
`[export-pdf-smoke] PASS: valid, content-bearing PDF` and exits `0` on success.

**The smoke command is identical on every OS.** Do not fork a platform-specific
variant. Only the binary path and the display-server wrapping differ.

## Binary path convention

The cargo workspace shares a single target tree at the **workspace root**
`target/` (not `src-tauri/target/`). `npm run build:e2e`
(`cd src-tauri && cargo build --features e2e`) produces:

| OS | Binary path (relative to repo root) |
| --- | --- |
| Linux / macOS | `target/debug/mdviewer` |
| Windows | `target\debug\mdviewer.exe` |

A release build (`npm run tauri build`) produces the bundled binary instead; the
smoke accepts any path, so either works as long as it is built with a frontend it
can load (the debug binary loads `http://localhost:1420`, which the smoke serves).

---

## Linux (local dev host) — VERIFIED PASSING

Linux runs locally; no remote agent needed. The debug WebView needs a display, so
wrap the smoke in `xvfb-run`:

```bash
export PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH"
npm install
npm run build:e2e
xvfb-run -a npm run test:e2e:pdf -- target/debug/mdviewer
```

Expected: the smoke prints `PASS: valid, content-bearing PDF` and exits `0`.
**Verified passing — produced a 2.1 MB PDF.** (Recorded as the Linux evidence in
`phase-e/completion.md`.)

---

## macOS — `mbook` agent (S12)

The macOS backend is `NSPrintOperation` (WKWebView). It is validated on the
`mbook` agent (macOS 14, arm64).

### Connection & delivery

`mbook` is reachable over SSH and logs in as user `jjb`:

```bash
ssh mbook
```

`mbook` has Node 20+, Rust/cargo, and the WebDriver toolchain (`tauri-wd`) already
installed, but it has **no GitHub access for this repo** — you cannot `git clone`
or `git pull` there. Deliver the branch by `rsync` from the dev host instead:

```bash
# from the dev host, inside the worktree:
rsync -az --exclude node_modules --exclude target \
  ./ mbook:~/mdviewer-e2e/
```

`--exclude node_modules --exclude target` keeps the transfer small; both are
rebuilt on the agent. Re-run this rsync to push subsequent changes.

### Build & smoke on `mbook`

macOS has a native display, so **no `xvfb` is needed**:

```bash
ssh mbook
cd ~/mdviewer-e2e
npm ci
npm run build:e2e            # → target/debug/mdviewer
npm run test:e2e:pdf -- target/debug/mdviewer
```

(A release build via `npm run tauri build` also works; point the smoke at the
bundled binary path instead.)

### Pass criteria

The smoke prints `PASS: valid, content-bearing PDF` and exits `0`. That is the
**S12** evidence — record the exit code, the `PASS` line, and the reported PDF
size in `phase-e/completion.md`.

> The mac-only WDIO suite (`e2e/printing/e1.spec.ts` and the rest) can also be run
> here with `npm run build:e2e && npm run test:e2e`, since `tauri-wd` is mac-only.
> But the substantive S12 verification is the smoke run above — the WDIO spec is
> only the portability ownership guard.

---

## Windows — `pockeo-windows` agent (S11)

The Windows backend is WebView2 `PrintToPdf`. It is validated on the Jenkins
Windows agent labelled `pockeo-windows`.

> **Connection details are TBD / operator-supplied.** Unlike `mbook`, the exact
> transport to `pockeo-windows` (RDP, WinRM, an interactive Jenkins job, or an
> SSH server if one is configured) is filled in by the orchestrator/operator at
> verification time. The steps below are the OS-specific procedure; substitute
> your actual connection and delivery mechanism.

### Prerequisites on the agent

- **Node 20+** (`node --version`).
- **Rust stable** (`rustup` / `cargo`), MSVC toolchain.
- **WebView2 Runtime** — the Evergreen runtime ships with current Windows 10/11
  and Edge; confirm it is present (the backend fails without it). No Android
  toolchain is relevant; only the desktop target matters.

### Delivery

Deliver this branch to the agent by whatever mechanism the operator uses (a
Jenkins SCM checkout of the branch, an artifact copy, or `rsync`/`scp` mirroring
the `mbook` approach). As with macOS, exclude `node_modules` and `target` — they
are rebuilt on the agent.

### Build & smoke

In a Windows shell at the repo root:

```powershell
npm ci
npm run build:e2e                 # → target\debug\mdviewer.exe
npm run test:e2e:pdf -- target\debug\mdviewer.exe
```

Windows has a native display server, so no `xvfb` wrapper is needed.

### Pass criteria

The smoke prints `PASS: valid, content-bearing PDF` and exits `0`. That is the
**S11** evidence — record the exit code, the `PASS` line, and the reported PDF
size in `phase-e/completion.md`.

---

## Recording results

After each agent run, capture the evidence in **`phase-e/completion.md`**:

- the OS and agent (`mbook` / `pockeo-windows` / local Linux),
- the exact smoke command run,
- the process exit code,
- the smoke's `[export-pdf-smoke] PASS: valid, content-bearing PDF` line, and
- the reported PDF size (`output size: <n> bytes`).

A passing run on `pockeo-windows` is the **S11** evidence; a passing run on
`mbook` is the **S12** evidence; the local Linux run is the S10/Linux evidence.

If an agent run **fails**, that is a per-OS backend bug to fix in the
`src-tauri/src/pdf.rs` code path (phase C) before the phase is considered done —
do not edit the smoke or the doc to make a red run pass.
