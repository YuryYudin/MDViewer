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
fn render_pin_byte_identical_to_fixture() {
    let opts = RenderOptions {
        syntax_highlighting: true,
        mermaid_enabled: false,
    };
    let result = render_markdown(FIXTURE, &opts);
    assert_eq!(result.html.trim(), EXPECTED.trim());

    // text_spans guard: render_markdown emits one (start, end) tuple per text
    // chunk it walks. The fixture has multiple paragraphs and inline spans, so
    // the count must be > 0 and every offset must lie within the source.
    assert!(
        !result.text_spans.is_empty(),
        "render_markdown should emit at least one text span for the fixture"
    );
    for &(s, e) in &result.text_spans {
        assert!(s <= e, "text_span start {s} > end {e}");
        assert!(
            e <= FIXTURE.len(),
            "text_span end {e} past fixture length {}",
            FIXTURE.len()
        );
    }
}
