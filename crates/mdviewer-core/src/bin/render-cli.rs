//! Tiny render-only CLI shared by the regression-test layers.
//!
//! Reads a `.md` path from argv[1], renders it via the canonical
//! `mdviewer_core::document::render_markdown` with the default
//! `RenderOptions`, and writes the rendered HTML to stdout. Exits
//! non-zero with a stderr message on missing-arg / read errors.
//!
//! Layer 2 (block-tree oracle, B3) and Layer 4 (v0.4.0 baseline audit, D1)
//! both consume this binary so they can obtain View-mode HTML without
//! spinning up Tauri. The `text_spans` field of `RenderResult` is
//! intentionally discarded — those consumers only want the HTML body.

use std::fs;
use std::io::Write as _;
use std::process::ExitCode;

use mdviewer_core::document::{render_markdown, RenderOptions};

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(path) = args.next() else {
        let _ = writeln!(std::io::stderr(), "usage: render-cli <path-to-.md>");
        return ExitCode::from(2);
    };

    let source = match fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            let _ = writeln!(std::io::stderr(), "read {}: {}", path, e);
            return ExitCode::from(3);
        }
    };

    let result = render_markdown(&source, &RenderOptions::default());
    let _ = std::io::stdout().write_all(result.html.as_bytes());
    ExitCode::SUCCESS
}
