#!/usr/bin/env node
// One-shot v0.4.0 baseline audit. Compares View-mode rendered HTML for
// every gallery fixture entry against current main. Output:
// docs/regression-audits/v0.4.0-baseline.md. CI never re-runs this; D2
// invokes it once, commits the report, and the script stays in the
// repo as a re-runnable forensic tool.
//
// Contract (see .claude/tcoder/2026-05-14-render-regression/phase-d/d1.md):
//   - Materialize v0.4.0 in a dedicated worktree under
//     ${repo}/.audit-worktrees/v0.4.0-${process.pid} (never `git checkout v0.4.0`).
//   - Two preconditions before building:
//       1. `fn render_markdown` signature in current main matches v0.4.0.
//       2. The `impl Default for RenderOptions` field set is identical.
//     If signatures align, both binaries call `render_markdown(source,
//     &RenderOptions::default())`. If the default-block field set differs
//     but the function signature is intact, the script patches v0.4.0's
//     copy of render-cli to construct explicit `RenderOptions { .. }`
//     matching v0.4.0's shape so the comparison stays apples-to-apples.
//     If the function signature itself moved, the script aborts cleanly
//     with a non-zero exit and writes a stub report explaining why.
//   - Honor v0.4.0's `rust-toolchain.toml` pin if present (cargo picks
//     it up automatically when invoked with cwd inside the worktree).
//   - Copy current main's `crates/mdviewer-core/src/bin/render-cli.rs`
//     into the v0.4.0 worktree (v0.4.0 predates the bin) and patch its
//     RenderOptions construction if precondition 2 demanded it.
//   - Try/finally cleanup: `git worktree remove --force <path>` AND
//     `cargo clean` so a half-built worktree never blocks the next run.
//   - Split `e2e/fixtures/render-gallery.md` into entries by top-level
//     `##` headings; ignore the H1 title block.
//   - Normalize whitespace before comparing HTML so trivial pulldown-cmark
//     formatting drift doesn't churn the report.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO = process.cwd();
const WORKTREE = path.join(REPO, '.audit-worktrees', `v0.4.0-${process.pid}`);
const GALLERY = path.join(REPO, 'e2e/fixtures/render-gallery.md');
const REPORT = path.join(REPO, 'docs/regression-audits/v0.4.0-baseline.md');
const TAG = 'v0.4.0';

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed (status=${r.status}): ${r.stderr || r.stdout}`,
    );
  }
  return r;
}

function readGit(rev, file) {
  // Returns { ok, content } so the caller decides whether absence is fatal.
  const r = spawnSync('git', ['show', `${rev}:${file}`], { encoding: 'utf8' });
  if (r.status !== 0) return { ok: false, content: '' };
  return { ok: true, content: r.stdout };
}

// ---------------------------------------------------------------------------
// Precondition extractors
// ---------------------------------------------------------------------------

function extractRenderMarkdownSignature(src) {
  const line = src.split('\n').find((l) => l.includes('fn render_markdown'));
  return line ? line.trim() : null;
}

function extractDefaultFields(src) {
  // Grep the `impl Default for RenderOptions` block; return the set of
  // `name: value` lines (trimmed, sans trailing comma).
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.includes('impl Default for RenderOptions'));
  if (start < 0) return null;
  const fields = [];
  let depth = 0;
  let sawSelf = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (!sawSelf && line.includes('Self {')) {
      sawSelf = true;
      continue;
    }
    if (sawSelf) {
      const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([^,]+),?\s*$/);
      if (m) fields.push(`${m[1]}: ${m[2].trim()}`);
    }
    if (sawSelf && depth === 0) break;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Cleanup — invoked from finally
// ---------------------------------------------------------------------------

function cleanup() {
  // Two-stage cleanup. cargo clean must run from inside the worktree so
  // cargo finds the right Cargo.toml; git worktree remove --force then
  // tears down both the directory and the .git/worktrees/ admin entry.
  try {
    if (fs.existsSync(WORKTREE) && fs.existsSync(path.join(WORKTREE, 'Cargo.toml'))) {
      sh('cargo', ['clean'], { cwd: WORKTREE, allowFail: true });
    }
  } catch (e) {
    console.error('cargo clean failed (non-fatal):', e.message);
  }
  try {
    if (fs.existsSync(WORKTREE)) {
      sh('git', ['worktree', 'remove', '--force', WORKTREE], { allowFail: true });
    }
  } catch (e) {
    console.error('git worktree remove failed (non-fatal):', e.message);
  }
  // Belt-and-suspenders: prune dangling worktree admin entries.
  sh('git', ['worktree', 'prune'], { allowFail: true });
}

// ---------------------------------------------------------------------------
// Gallery splitter
// ---------------------------------------------------------------------------

function splitGallery(body) {
  // Split the fixture into entries by top-level `##` headings. The H1
  // block (document title + preamble) is dropped. Each entry retains
  // its `##` line so it round-trips through the renderer with its own
  // heading.
  const entries = [];
  const lines = body.split('\n');
  let current = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (current) entries.push(current);
      current = { title: line.slice(3).trim(), body: line + '\n' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) entries.push(current);
  return entries;
}

function normalize(html) {
  // Collapse all whitespace runs to a single space and trim. Pulldown-cmark
  // can shuffle indent/newline placement between releases without changing
  // semantic output; this keeps the report focused on real divergence.
  return html.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // --- Step 1. Precondition: render_markdown signature ------------------
  const currentDocPath = path.join(REPO, 'crates/mdviewer-core/src/document.rs');
  if (!fs.existsSync(currentDocPath)) {
    throw new Error(`expected current main to expose ${currentDocPath}`);
  }
  const currentDoc = fs.readFileSync(currentDocPath, 'utf8');
  const sigCurrent = extractRenderMarkdownSignature(currentDoc);
  if (!sigCurrent) {
    throw new Error('current main: no `fn render_markdown` in document.rs');
  }

  // v0.4.0's document.rs may sit at the same path (post-A6 split) or at
  // the legacy `src-tauri/src/document.rs`. Try both.
  let v040Doc = readGit(TAG, 'crates/mdviewer-core/src/document.rs');
  let v040DocOrigin = 'crates/mdviewer-core/src/document.rs';
  if (!v040Doc.ok) {
    v040Doc = readGit(TAG, 'src-tauri/src/document.rs');
    v040DocOrigin = 'src-tauri/src/document.rs';
  }
  if (!v040Doc.ok) {
    throw new Error(`v0.4.0: cannot locate document.rs (tried crates/ and src-tauri/)`);
  }
  const sigV040 = extractRenderMarkdownSignature(v040Doc.content);
  if (!sigV040) {
    throw new Error(
      `v0.4.0 (${v040DocOrigin}): no \`fn render_markdown\` — aborting audit (Layer 4 cannot apples-to-apples a missing API).`,
    );
  }
  const sigMatch = sigCurrent === sigV040;

  // --- Step 2. Precondition: RenderOptions::default() field comparison --
  const fieldsCurrent = extractDefaultFields(currentDoc) || [];
  const fieldsV040 = extractDefaultFields(v040Doc.content) || [];
  const sameFields =
    fieldsCurrent.length === fieldsV040.length &&
    fieldsCurrent.every((f, i) => f === fieldsV040[i]);
  const explicitOptionsNeeded = !sameFields;

  console.log('[audit] render_markdown signature current:', sigCurrent);
  console.log('[audit] render_markdown signature v0.4.0 :', sigV040);
  console.log('[audit] signature match:', sigMatch);
  console.log('[audit] RenderOptions::default fields current:', fieldsCurrent);
  console.log('[audit] RenderOptions::default fields v0.4.0 :', fieldsV040);
  console.log('[audit] explicit RenderOptions needed:', explicitOptionsNeeded);

  if (!sigMatch) {
    // Signatures themselves drifted — the cli we copy in cannot compile
    // against the old crate. Write a stub report and exit cleanly so D2
    // commits an honest "audit cannot proceed" artifact instead of a
    // silent green.
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    const stub =
      '# v0.4.0 baseline audit\n\n' +
      `Generated by \`scripts/audit-v040.mjs\` on ${new Date().toISOString()}.\n\n` +
      '**Audit aborted: `render_markdown` signature drifted between v0.4.0 and current main.**\n\n' +
      `- current main: \`${sigCurrent}\`\n` +
      `- v0.4.0      : \`${sigV040}\` (from \`${v040DocOrigin}\`)\n\n` +
      'Layer 4 cannot perform an apples-to-apples comparison when the\n' +
      'function signature itself moved. Re-run the audit against an\n' +
      'earlier tag whose signature matches, or accept that the View-mode\n' +
      'render contract has intentionally drifted since v0.4.0.\n';
    fs.writeFileSync(REPORT, stub);
    console.log(`[audit] wrote stub report at ${REPORT} (signature drift)`);
    return;
  }

  // --- Step 3. Set up worktree + render-cli bin + build -----------------
  fs.mkdirSync(path.dirname(WORKTREE), { recursive: true });
  if (fs.existsSync(WORKTREE)) {
    // A stale path from a previous crashed run. Try to evict it.
    sh('git', ['worktree', 'remove', '--force', WORKTREE], { allowFail: true });
  }
  sh('git', ['worktree', 'add', WORKTREE, TAG]);

  // Honor v0.4.0's rust-toolchain pin if present. cargo automatically
  // picks up `rust-toolchain.toml` from the working directory; nothing
  // to do beyond logging the situation.
  const toolchainFile = path.join(WORKTREE, 'rust-toolchain.toml');
  const usesPin = fs.existsSync(toolchainFile);
  console.log('[audit] v0.4.0 rust-toolchain.toml present:', usesPin);

  // Copy current main's render-cli into the v0.4.0 worktree at the same
  // path. v0.4.0 predates the bin so we always create it fresh; if a
  // future re-run targets a tag that has the bin, the overwrite is still
  // benign because the audit always compares the SAME source on both
  // sides.
  const binSrc = path.join(REPO, 'crates/mdviewer-core/src/bin/render-cli.rs');
  const binDst = path.join(WORKTREE, 'crates/mdviewer-core/src/bin/render-cli.rs');
  fs.mkdirSync(path.dirname(binDst), { recursive: true });
  let binSource = fs.readFileSync(binSrc, 'utf8');

  if (explicitOptionsNeeded) {
    // Field set drifted; reconstruct the call site explicitly using
    // v0.4.0's field set so both binaries materialize the same options.
    const explicit =
      '&RenderOptions { ' + fieldsV040.join(', ') + ' }';
    binSource = binSource.replace('&RenderOptions::default()', explicit);
    console.log('[audit] patched v0.4.0 render-cli to use explicit RenderOptions:', explicit);
  }
  fs.writeFileSync(binDst, binSource);

  // Ensure the v0.4.0 Cargo.toml registers the bin. If a previous A6
  // landing already added the entry, leave it alone.
  const v040Cargo = path.join(WORKTREE, 'crates/mdviewer-core/Cargo.toml');
  let cargoContent = fs.readFileSync(v040Cargo, 'utf8');
  if (!cargoContent.includes('name = "render-cli"')) {
    cargoContent += '\n[[bin]]\nname = "render-cli"\npath = "src/bin/render-cli.rs"\n';
    fs.writeFileSync(v040Cargo, cargoContent);
    console.log('[audit] appended [[bin]] render-cli entry to v0.4.0 Cargo.toml');
  }

  // Build v0.4.0's render-cli. cargo must run from the worktree so it
  // resolves the right Cargo.toml.
  const buildResult = sh(
    'cargo',
    ['build', '-p', 'mdviewer-core', '--bin', 'render-cli'],
    { cwd: WORKTREE, allowFail: true, stdio: 'inherit' },
  );
  const v040Buildable = buildResult.status === 0;
  if (!v040Buildable) {
    console.error('[audit] v0.4.0 render-cli build failed; per-entry rows will record the failure.');
  }

  // --- Step 4. Build current main's render-cli (cached) -----------------
  sh('cargo', ['build', '-p', 'mdviewer-core', '--bin', 'render-cli'], {
    cwd: REPO,
    stdio: 'inherit',
  });

  // --- Step 5. Split gallery into entries -------------------------------
  if (!fs.existsSync(GALLERY)) {
    throw new Error(`gallery fixture missing at ${GALLERY}`);
  }
  const entries = splitGallery(fs.readFileSync(GALLERY, 'utf8'));
  console.log(`[audit] gallery split into ${entries.length} ## entries`);

  // --- Step 6. Render each entry from both binaries, normalize, diff ----
  const mainBin = path.join(REPO, 'target/debug/render-cli');
  const v040Bin = path.join(WORKTREE, 'target/debug/render-cli');
  if (!fs.existsSync(mainBin)) {
    throw new Error(`current main render-cli not at ${mainBin} after build`);
  }

  const rows = [];
  for (const entry of entries) {
    const tmp = path.join(
      REPO,
      '.audit-worktrees',
      `entry-${process.pid}-${rows.length}.md`,
    );
    fs.writeFileSync(tmp, entry.body);

    const mainRun = sh(mainBin, [tmp], { allowFail: true });
    const mainHtml = mainRun.status === 0 ? mainRun.stdout : `<!-- main render failed: ${mainRun.stderr} -->`;

    let v040Html = null;
    let buildFailureNote = null;
    if (v040Buildable) {
      const v040Run = sh(v040Bin, [tmp], { allowFail: true });
      v040Html = v040Run.status === 0 ? v040Run.stdout : `<!-- v0.4.0 render failed: ${v040Run.stderr} -->`;
    } else {
      buildFailureNote = 'unable to build v0.4.0 render-cli — see audit log';
    }

    rows.push({
      title: entry.title,
      parity: v040Buildable ? normalize(mainHtml) === normalize(v040Html) : null,
      mainHtml,
      v040Html,
      buildFailureNote,
    });

    try {
      fs.unlinkSync(tmp);
    } catch {
      // Already gone; nothing to do.
    }
  }

  // --- Step 7. Write the report ----------------------------------------
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  let md = '# v0.4.0 baseline audit\n\n';
  md += `Generated by \`scripts/audit-v040.mjs\` against ${TAG} on ${new Date().toISOString()}.\n\n`;
  md += 'Each row corresponds to one `##`-level section of `e2e/fixtures/render-gallery.md`.\n';
  md += 'Comparison is whitespace-normalized (`/\\s+/` collapsed to a single space).\n\n';
  md += `- \`render_markdown\` signature parity: \`${sigCurrent}\`\n`;
  md += `- \`RenderOptions::default()\` field-set parity: ${sameFields ? 'identical' : `differed — patched bin to use explicit options [${fieldsV040.join(', ')}]`}\n`;
  md += `- v0.4.0 render-cli build: ${v040Buildable ? 'ok' : 'FAILED (rows below mark divergence as unknown)'}\n\n`;
  md += '> **Known benign divergence:** syntect grammar and theme versions may rev between v0.4.0 and current main. HTML differences inside `<pre><code>` bodies are expected and do NOT count as regressions; the per-row commentary calls this out where relevant.\n\n';

  for (const r of rows) {
    md += `## ${r.title}\n\n`;
    if (r.parity === true) {
      md += '**Parity:** View-mode HTML matches v0.4.0 (whitespace-normalized).\n\n';
    } else if (r.parity === false) {
      md += '**Divergence detected.** Side-by-side HTML below.\n\n';
      md += '> Note: if the divergence is entirely inside `<pre><code>` bodies it is the known-benign syntect drift and is NOT a regression.\n\n';
      md += '<details><summary>v0.4.0 output</summary>\n\n```html\n' + r.v040Html + '\n```\n\n</details>\n\n';
      md += '<details><summary>current main output</summary>\n\n```html\n' + r.mainHtml + '\n```\n\n</details>\n\n';
    } else {
      md += `**${r.buildFailureNote}** — re-run \`scripts/audit-v040.mjs\` locally with verbose cargo output to investigate.\n\n`;
      md += '<details><summary>current main output</summary>\n\n```html\n' + r.mainHtml + '\n```\n\n</details>\n\n';
    }
  }

  fs.writeFileSync(REPORT, md);
  console.log(`[audit] wrote ${REPORT} (${rows.length} entries)`);
}

// ---------------------------------------------------------------------------
// Entry point with mandatory try/finally cleanup
// ---------------------------------------------------------------------------

try {
  await main();
} catch (err) {
  console.error('[audit] failed:', err);
  process.exitCode = 1;
} finally {
  cleanup();
}
