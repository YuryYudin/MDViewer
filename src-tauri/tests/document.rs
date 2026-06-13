use mdviewer_lib::document::{render_markdown, save_document, RenderOptions};
use std::fs;
use tempfile::TempDir;

#[test]
fn save_document_writes_atomically_and_returns_hash() {
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("doc.md");
    let r = save_document(&p, b"hello", |_, _| {}).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"hello");
    assert_eq!(r.bytes_written, 5);
    assert!(r.content_hash != 0);
    // The temp file used for atomic-rename must not be left on disk.
    assert!(!tmp.path().join("doc.md.tmp").exists());
}

#[test]
fn save_document_extensionless_path_uses_tmp_suffix() {
    // Path without an extension exercises the `unwrap_or_else(|| "tmp".into())`
    // branch in the temp-name builder.
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("notes");
    let r = save_document(&p, b"contents", |_, _| {}).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"contents");
    assert_eq!(r.bytes_written, 8);
    assert!(!tmp.path().join("notes.tmp").exists());
}

#[test]
fn save_document_overwrites_existing_file() {
    // Verify that a save replaces existing bytes (the rename-over-existing
    // path) and computes a hash that differs from the original contents.
    let tmp = TempDir::new().unwrap();
    let p = tmp.path().join("doc.md");
    fs::write(&p, b"old contents").unwrap();
    let r1 = save_document(&p, b"old contents", |_, _| {}).unwrap();
    let r2 = save_document(&p, b"new contents", |_, _| {}).unwrap();
    assert_eq!(fs::read(&p).unwrap(), b"new contents");
    assert_ne!(r1.content_hash, r2.content_hash);
}

#[test]
fn renders_gfm_tables_and_tasklists() {
    let src = "| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(html.contains("<table>"), "expected table, got: {html}");
    assert!(html.contains("checked"), "expected checked task list, got: {html}");
}

#[test]
fn table_header_row_uses_th_not_td() {
    // GitHub-style rendering wants the header row to be <th> so the CSS
    // (centered, bold, surface-2 background) applies semantically. Body
    // rows must stay <td> — a regression that emitted <th> for body rows
    // would lose the zebra striping rule's selector.
    let src = "| A | B |\n|---|---|\n| 1 | 2 |\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(html.contains("<thead><tr>"), "missing thead/tr open: {html}");
    assert!(
        html.contains("<th>") && html.contains("</th>"),
        "header cells must be <th>: {html}",
    );
    assert!(
        html.contains("</tr></thead><tbody>"),
        "missing tbody open: {html}",
    );
    // Body cells stay <td>.
    let body_idx = html.find("<tbody>").unwrap();
    let body = &html[body_idx..];
    assert!(body.contains("<td>"), "body row must use <td>: {body}");
    assert!(!body.contains("<th>"), "body row must not use <th>: {body}");
}

#[test]
fn inline_text_carries_data_src_offset() {
    let src = "Hello selectable phrase one.";
    let out = render_markdown(src, &RenderOptions::default());
    // Every text-bearing inline element must declare its source offset.
    assert!(
        out.html.contains("data-src-offset=\"0\""),
        "expected data-src-offset=0 in: {}",
        out.html
    );
    // The recorded offsets must round-trip back to the source slice.
    for (start, end) in out.text_spans {
        assert!(start <= end, "start {} > end {}", start, end);
        assert!(end <= src.len(), "end {} > src len {}", end, src.len());
        let _ = &src[start..end]; // panics if not a UTF-8 boundary
    }
}

#[test]
fn syntax_highlighting_toggle_off_emits_raw_pre_code() {
    let src = "```rust\nfn main() {}\n```\n";
    let opts = RenderOptions { syntax_highlighting: false, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(html.contains("<pre><code"), "expected raw <pre><code>, got: {html}");
    assert!(
        !html.contains("style=\"color:"),
        "syntect color spans leaked into raw output: {html}"
    );
}

#[test]
fn syntax_highlighting_toggle_on_invokes_syntect() {
    let src = "```rust\nfn main() {}\n```\n";
    let opts = RenderOptions { syntax_highlighting: true, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    // Class-based output (theme-reactive): syntect emits `syn-*` scope classes,
    // NOT inline `style="color:…"`. The colors live in document.css (light +
    // body.theme-dark palettes) so dark mode is readable and a theme toggle
    // needs no re-render.
    assert!(
        html.contains("class=\"syn-") || html.contains(" syn-"),
        "syntect class-based output missing syn-* classes: {html}"
    );
    assert!(
        !html.contains("style=\"color:"),
        "highlighting must be class-based, not inline colors: {html}"
    );
    assert!(
        html.contains("<code class=\"language-rust hl\">"),
        "expected the highlighted code wrapper: {html}"
    );
}

#[test]
fn render_line_breaks_on_emits_br_for_single_newline() {
    // Two metadata-style lines with only a single newline between them: with
    // render_line_breaks ON they must NOT be joined into one run — a <br/>
    // separates them. (The reported "mangled headers" bug.)
    let src = "**Date:** 2026-06-10\n**Scope:** full-stack\n";
    let opts = RenderOptions { render_line_breaks: true, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(
        html.contains("<br/>"),
        "expected a <br/> between soft-broken lines, got: {html}"
    );
}

#[test]
fn render_line_breaks_off_keeps_strict_commonmark() {
    // With render_line_breaks OFF, the single newline is a soft break that
    // collapses to whitespace — no <br/> — matching strict CommonMark.
    let src = "**Date:** 2026-06-10\n**Scope:** full-stack\n";
    let opts = RenderOptions { render_line_breaks: false, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(
        !html.contains("<br/>"),
        "strict CommonMark must not insert <br/> for a soft break: {html}"
    );
}

#[test]
fn render_line_breaks_default_is_on() {
    // The RenderOptions default opts into note-style line breaks.
    assert!(RenderOptions::default().render_line_breaks);
}

#[test]
fn mermaid_passthrough_when_enabled() {
    let src = "```mermaid\ngraph TD; A-->B;\n```\n";
    let opts = RenderOptions { mermaid_enabled: true, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(
        html.contains("class=\"mermaid\""),
        "expected mermaid class, got: {html}"
    );
    assert!(html.contains("graph TD"), "expected mermaid source preserved: {html}");
}

#[test]
fn mermaid_disabled_emits_raw_code_block() {
    let src = "```mermaid\ngraph TD; A-->B;\n```\n";
    let opts = RenderOptions { mermaid_enabled: false, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(html.contains("<pre><code"), "expected raw <pre><code>, got: {html}");
    assert!(
        !html.contains("class=\"mermaid\""),
        "mermaid class leaked when disabled: {html}"
    );
}

#[test]
fn offsets_round_trip_property() {
    // Property-style: feed several documents and assert every recorded
    // (start, end) is in-bounds and resolves to a valid UTF-8 slice of the
    // source. Additionally, for the data-src-offset / data-src-end attributes
    // emitted into the HTML, check that the recorded slice text appears
    // (after HTML-escape) inside the matching <span> body in the output —
    // confirming the carrier element really does map to that source range.
    let cases = [
        "Plain paragraph.",
        "Two paragraphs.\n\nSecond.",
        "**bold** and *italic*.",
        "A [link](https://example.com).",
        "Mixed:\n\n- bullet\n- another\n",
    ];
    for src in cases {
        let out = render_markdown(src, &RenderOptions::default());
        assert!(!out.text_spans.is_empty(), "no spans emitted for {src:?}");
        for (s, e) in &out.text_spans {
            let (s, e) = (*s, *e);
            assert!(s <= e && e <= src.len(), "out-of-bounds span in {src:?}: {s}..{e}");
            // Slice must be valid UTF-8 (panics if not on a char boundary).
            let slice = &src[s..e];
            // The HTML must contain a carrier with these exact offsets.
            let needle = format!("data-src-offset=\"{s}\" data-src-end=\"{e}\"");
            assert!(
                out.html.contains(&needle),
                "carrier {needle} missing from html for {src:?}: {}",
                out.html
            );
            // And the slice text (HTML-escaped trivially for these inputs)
            // should be findable in the rendered HTML so the carrier really
            // wraps the source content.
            assert!(
                out.html.contains(slice),
                "slice {slice:?} from offsets {s}..{e} not present in html for {src:?}: {}",
                out.html
            );
        }
    }
}

#[test]
fn renders_headings_blockquote_breaks_and_rules() {
    let src = "# H1\n\n## H2\n\n> a quote\n\nline one  \nline two\n\nfirst\nsecond\n\n---\n";
    // Pin the STRICT-CommonMark distinction here: a hard break (two trailing
    // spaces) is <br/>, a soft break (bare newline) is a literal '\n'. The
    // note-style soft-break-as-<br/> path is covered by
    // render_line_breaks_on_emits_br_for_single_newline.
    let opts = RenderOptions { render_line_breaks: false, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(html.contains("<h1>"), "missing <h1>: {html}");
    assert!(html.contains("</h1>"), "missing </h1>: {html}");
    assert!(html.contains("<h2>") && html.contains("</h2>"), "missing <h2>: {html}");
    assert!(html.contains("<blockquote>") && html.contains("</blockquote>"), "blockquote: {html}");
    assert!(html.contains("<br/>"), "missing hard break: {html}");
    // Soft break inside a paragraph emits a literal newline between the two
    // text spans (no <br/>, no extra <p>) when render_line_breaks is off.
    assert!(
        html.contains("first</span>\n<span"),
        "missing soft break newline between spans: {html}"
    );
    assert!(html.contains("<hr/>"), "missing horizontal rule: {html}");
}

#[test]
fn renders_links_images_strikethrough_and_inline_code() {
    let src = "[anchor](https://example.com) and ![alt](https://example.com/x.png) ~~gone~~ `inline`.";
    let out = render_markdown(src, &RenderOptions::default());
    let html = &out.html;
    assert!(html.contains("<a href=\"https://example.com\">"), "link: {html}");
    assert!(html.contains("</a>"), "link close: {html}");
    assert!(html.contains("<img src=\"https://example.com/x.png\" alt=\""), "image: {html}");
    assert!(html.contains("\"/>"), "image self-close: {html}");
    assert!(html.contains("<del>") && html.contains("</del>"), "strikethrough: {html}");
    // Inline code carries data-src-offset just like text spans.
    assert!(
        html.contains("<code data-src-offset=") && html.contains(">inline</code>"),
        "inline code carrier: {html}"
    );
    // The inline code carrier offsets must be among text_spans too. The
    // pulldown-cmark range covers the backticks, so the source slice is
    // `\`inline\`` (8 chars).
    assert!(
        out.text_spans.iter().any(|(s, e)| &src[*s..*e] == "`inline`"),
        "inline code span missing from text_spans: {:?}",
        out.text_spans
    );
}

#[test]
fn ordered_list_emits_ol_tags() {
    let src = "1. first\n2. second\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(html.contains("<ol>") && html.contains("</ol>"), "ordered list: {html}");
    assert!(html.contains("<li>") && html.contains("</li>"), "list items: {html}");
}

#[test]
fn indented_code_block_emits_raw_pre_code() {
    // Four-space indent triggers an indented code block (no language tag).
    let src = "Paragraph.\n\n    let x = 1;\n    let y = 2;\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(html.contains("<pre><code>"), "indented code block: {html}");
    assert!(html.contains("let x = 1;"), "indented code body: {html}");
    // Indented code blocks have no language and so must not get a language- class.
    assert!(!html.contains("class=\"language-"), "indented block must not be classed: {html}");
}

#[test]
fn syntax_highlight_unknown_language_falls_back_to_classed_pre_code() {
    // A language token that syntect's defaults don't recognise: the renderer
    // must fall back to `<pre><code class="language-xyzzy">` rather than
    // emitting syntect output or dropping the class.
    let src = "```xyzzy\nhello\n```\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(
        html.contains("<pre><code class=\"language-xyzzy\">"),
        "fallback class missing: {html}"
    );
    assert!(!html.contains("style=\"color:"), "syntect leaked for unknown lang: {html}");
}

#[test]
fn syntax_highlight_off_for_unlabelled_fence_emits_plain_pre_code() {
    // Fenced block with no language tag: with highlighting off we still get
    // a plain <pre><code> (no class).
    let src = "```\njust text\n```\n";
    let opts = RenderOptions { syntax_highlighting: false, ..RenderOptions::default() };
    let html = render_markdown(src, &opts).html;
    assert!(html.contains("<pre><code>"), "expected plain pre/code: {html}");
    assert!(!html.contains("class=\"language-"), "no class expected: {html}");
}

#[test]
fn raw_html_passthrough() {
    let src = "<div class=\"x\">raw html</div>\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(html.contains("<div class=\"x\">"), "raw html block dropped: {html}");
    assert!(html.contains("</div>"), "raw html close dropped: {html}");
}

#[test]
fn escape_html_special_characters() {
    // The renderer escapes &, ", and ' in text. Angle brackets that look like
    // tags get parsed as raw HTML by pulldown-cmark, so we verify them via
    // an inline-code path where the renderer does the escaping itself.
    let src = "Quotes: \"hi\" 'yo' & done.\n\nCode: `<tag>` here.\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    assert!(html.contains("&quot;hi&quot;"), "double-quote escape: {html}");
    assert!(html.contains("&#39;yo&#39;"), "single-quote escape: {html}");
    assert!(html.contains("&amp;"), "ampersand escape: {html}");
    assert!(html.contains("&lt;tag&gt;"), "angle-bracket escape inside code: {html}");
}

#[test]
fn renders_all_six_heading_levels() {
    let src = "# h1\n\n## h2\n\n### h3\n\n#### h4\n\n##### h5\n\n###### h6\n";
    let html = render_markdown(src, &RenderOptions::default()).html;
    for level in 1..=6 {
        let open = format!("<h{level}>");
        let close = format!("</h{level}>");
        assert!(html.contains(&open), "missing {open}: {html}");
        assert!(html.contains(&close), "missing {close}: {html}");
    }
}

#[test]
fn unsupported_events_are_dropped_silently() {
    // Pulldown-cmark's GFM mode emits `Event::Html` for raw HTML and
    // `TaskListMarker(false)`. Driving both alongside text events exercises
    // the catch-all arm and the unchecked branch of the task-list marker.
    let src = "<aside>\n\n- [ ] todo only\n";
    let out = render_markdown(src, &RenderOptions::default());
    let html = &out.html;
    assert!(html.contains("<aside>"), "raw html dropped: {html}");
    assert!(
        html.contains("<input type=\"checkbox\" disabled/>"),
        "unchecked task marker missing: {html}"
    );
    // Empty-event paths must not break the offset round-trip.
    for (s, e) in &out.text_spans {
        assert!(*s <= *e && *e <= src.len());
    }
}

#[test]
fn span_carrier_is_inline_not_block_p_tag() {
    // A10's Document.test.ts mounts HTML like
    //   <p><span data-src-offset="0" data-src-end="11">Hello world</span></p>
    // The data-src-offset MUST be on the inline <span>, not the <p>.
    let src = "Hello world";
    let out = render_markdown(src, &RenderOptions::default());
    assert!(
        out.html.contains("<span data-src-offset=\"0\" data-src-end=\"11\">Hello world</span>"),
        "expected inline <span> carrier, got: {}",
        out.html
    );
    // Negative: <p> must not carry the offset attribute.
    assert!(
        !out.html.contains("<p data-src-offset"),
        "data-src-offset leaked onto block <p> tag: {}",
        out.html
    );
}
