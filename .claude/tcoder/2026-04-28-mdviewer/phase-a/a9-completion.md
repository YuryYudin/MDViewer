# A9 Completion Notes

**Summary:** Added the WebView shell and IPC adapter: `src/ipc.ts` re-exports the Rust-generated types and wraps every Tauri command in a typed `Ipc` interface; `src/keymap.ts` canonicalises both settings.shortcuts strings and KeyboardEvents into the same key (Cmd/Ctrl/Meta/CmdOrCtrl all map to `mod`); `src/views/{Workspace,TabBar,StartPage,ProfileSetup}.ts` build DOM via `createElement` + `textContent`; `src/main.ts` boots theme + keymap + chooses between ProfileSetup and Workspace based on `settings.profile.display_name`; `src/styles/{theme,app}.css` carry the CSS variables a single body class flips.

**Deviations:**
- E2E mode detection — Rule 1: The plan's spec checks `import.meta.env?.MDVIEWER_E2E === '1'`, but Vitest's jsdom environment cannot stub `import.meta.env` cleanly, and the Vite-rewritten env table is read-only at runtime. Added a `window.__MDVIEWER_E2E` escape hatch so `isE2eMode()` honours either signal — production e2e launchers still set `import.meta.env.MDVIEWER_E2E='1'`, while unit tests flip the window flag.
- ProfileSetup color picker — Rule 1: Wireframe 02 shows a swatch grid (`amber/teal/rose/...`). The plan only requires that name + color persist via `setSettings`, so I used a single `<input type="color">` and exposed it via `[data-test="profile-color"]`. The persistence contract is unchanged; the swatch grid can be layered on later without touching IPC.
- Exported `main()` and gated the auto-run on `MODE !== 'test'` — Rule 1: needed to make main.ts testable without spawning a real Tauri runtime. The production entry behaviour is identical (Vite's `import.meta.env.MODE === 'production'` for builds, `'development'` for dev — both run `main()`). Tests import `main` and provide stub IPC.
- Stubbed `globalThis.localStorage` in `tests/main.test.ts` — Rule 3: jsdom in this configuration ships a Storage property but its prototype methods are missing, so a minimal in-memory replacement was needed for the bootstrap's theme cache to round-trip.

**Files Changed:**
- Created: `src/ipc.ts`, `src/keymap.ts`, `src/styles/theme.css`, `src/styles/app.css`, `src/views/Workspace.ts`, `src/views/TabBar.ts`, `src/views/StartPage.ts`, `src/views/ProfileSetup.ts`
- Created tests: `tests/ipc.test.ts`, `tests/keymap.test.ts`, `tests/main.test.ts`, `tests/views/Workspace.test.ts`, `tests/views/TabBar.test.ts`, `tests/views/StartPage.test.ts`, `tests/views/ProfileSetup.test.ts`
- Modified: `src/main.ts` (replaced the A2 stub with theme + keymap bootstrap + ProfileSetup/Workspace routing)
- Untouched: `src/index.html` (already had `<div id="app"></div>` from A2)

**Test Results:**
- Verification command (`npm run test -- tests/views/...`): 28/28 passing
- Full suite (`npm run test`): 62/62 passing
- Coverage (touched src/ files): 98.83% lines, 95.74% branches, 100% funcs, 98.83% statements — global threshold is 90%, all clear
- Per-file coverage: ipc.ts 100%, TabBar.ts 100%, Workspace.ts 100%, ProfileSetup.ts 100%, keymap.ts 100% lines / 94.7% branches, StartPage.ts 100% lines / 94.1% branches, main.ts 93.4% lines / 91.7% branches

**Deferred Issues:**
- `tsc --noEmit` reports pre-existing errors in `src/types-generated.ts` (ts-rs emits `import type` statements pointing at sibling files that ts-rs does not also emit — an A2b carry-over) and in `e2e/*` (missing `browser` global typings, an A2 carry-over). These were verified pre-existing by stashing my changes and re-running `tsc`. Unrelated to A9.
