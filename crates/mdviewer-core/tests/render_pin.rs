//! Pin test: rendered HTML for a representative GFM source is byte-identical
//! to the desktop's pre-A6 output. Updating the fixture is allowed only if a
//! deliberate render change is intended — that's a separate PR.
//!
//! Why this matters: A10's selection bridge locates `data-src-offset` /
//! `data-src-end` carriers by exact serialization. A single attribute-order
//! change here shifts those offsets and breaks the desktop selection round-
//! trip. The fixture is also the gate for Android's render-equivalence
//! success criterion (#11).

use mdviewer_core::document::{render_markdown, RenderOptions};

const FIXTURE: &str = include_str!("fixtures/render_pin_input.md");
const EXPECTED: &str = include_str!("fixtures/render_pin_expected.html");

#[test]
fn render_byte_identical_to_pin_fixture() {
    let opts = RenderOptions {
        syntax_highlighting: true,
        mermaid_enabled: false,
    };
    let result = render_markdown(FIXTURE, &opts);
    assert_eq!(result.html.trim(), EXPECTED.trim());
}
