//! Markdown document renderer (shared core half).
//!
//! Parses GFM-flavored Markdown via `pulldown-cmark` and emits HTML in which
//! every text-bearing inline element (`<span>` for prose, `<code>` for inline
//! code) carries `data-src-offset` / `data-src-end` attributes whose values
//! are byte offsets into the original source. The frontend uses those
//! attributes (see desktop's A10) to map DOM Range selections back to source
//! offsets without character-counting walks.
//!
//! Code blocks honour two settings:
//! - `syntax_highlighting`: when true, fenced code blocks with a recognised
//!   language tag are highlighted via `syntect` as CLASS-based `syn-*` spans
//!   (theme colors live in document.css with light + `body.theme-dark`
//!   palettes, so a theme toggle recolors code with no re-render). When false,
//!   raw `<pre><code class="language-...">` is emitted.
//! - `mermaid_enabled`: when true, ```` ```mermaid ```` fences pass through as
//!   `<pre class="mermaid">...</pre>` for client-side rendering. When false
//!   they fall back to a raw `<pre><code>` block.
//!
//! `SyntaxSet` and `ThemeSet` are loaded once via `OnceLock` so first render
//! pays the multi-millisecond load cost and subsequent renders amortize it.
//!
//! Split history (A6): this module used to live at `src-tauri/src/document.rs`
//! alongside the desktop save/watcher coupling. The render half (this file)
//! moved here so Android can consume the same parser/HTML emit code via
//! UniFFI without pulling in `notify`/`watcher::quick_hash`/`SaveOutcome`.
//! The desktop save half still lives in `src-tauri/src/document.rs` and
//! re-exports `render_markdown` for existing call sites.

use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::fmt::Write as _;
use std::sync::OnceLock;
use syntect::html::{ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct RenderOptions {
    pub syntax_highlighting: bool,
    pub mermaid_enabled: bool,
    /// When true, a single newline is kept as a `<br/>` line break ONLY when
    /// the next line begins with a highlight (a bold/`Strong` inline, e.g.
    /// `**Date:** …`) — so label/metadata blocks stay on their own lines while
    /// ordinary prose still collapses soft breaks to a space and reflows to the
    /// window width. When false, strict CommonMark applies (every soft break
    /// collapses). NOT a blanket "break every line" toggle.
    pub render_line_breaks: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            syntax_highlighting: true,
            mermaid_enabled: true,
            render_line_breaks: true,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct RenderResult {
    pub html: String,
    /// All `(start, end)` source offsets emitted as `data-src-offset` /
    /// `data-src-end` on inline carrier elements. Useful for the round-trip
    /// property test. The frontend does not consume this field; it is marked
    /// `#[serde(default)]` so future schema-trim changes don't break the IPC
    /// payload.
    #[serde(default)]
    pub text_spans: Vec<(usize, usize)>,
}

fn syntax_set() -> &'static SyntaxSet {
    static SS: OnceLock<SyntaxSet> = OnceLock::new();
    SS.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Renders `source` markdown into HTML annotated with `data-src-offset`
/// attributes on inline text carriers.
pub fn render_markdown(source: &str, opts: &RenderOptions) -> RenderResult {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_GFM);

    // Peekable so the SoftBreak handler can look at the next inline event and
    // tell whether the upcoming line begins with a highlight (bold), which is
    // the only case we preserve as a hard `<br/>` (see the SoftBreak arm).
    let mut parser = Parser::new_ext(source, options).into_offset_iter().peekable();

    let mut html = String::with_capacity(source.len() * 2);
    let mut text_spans = Vec::new();
    let mut code_buffer = String::new();
    let mut code_lang: Option<String> = None;
    let mut in_code = false;
    // pulldown-cmark emits text events for the body of an image's alt
    // attribute. Wrapping those in <span data-src-offset> would corrupt the
    // attribute string, so we collect them as plain escaped text instead.
    let mut image_depth: usize = 0;
    // Track whether we're inside the <thead> row so TableCell emits <th>
    // (semantic header markup, plus the GFM-style centered+bold styling
    // app.css attaches via the th selector). pulldown-cmark always emits
    // exactly one TableHead per table; subsequent rows are TableRow.
    let mut in_table_head = false;

    while let Some((event, range)) = parser.next() {
        match event {
            Event::Start(Tag::CodeBlock(CodeBlockKind::Fenced(lang))) => {
                in_code = true;
                code_lang = Some(lang.into_string());
                code_buffer.clear();
            }
            Event::Start(Tag::CodeBlock(CodeBlockKind::Indented)) => {
                in_code = true;
                code_lang = Some(String::new());
                code_buffer.clear();
            }
            Event::End(TagEnd::CodeBlock) => {
                let lang = code_lang.take().unwrap_or_default();
                emit_code_block(&mut html, &code_buffer, &lang, opts);
                in_code = false;
                code_buffer.clear();
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                image_depth += 1;
                let _ = write!(html, "<img src=\"{}\" alt=\"", escape_html(&dest_url));
            }
            Event::End(TagEnd::Image) => {
                html.push_str("\"/>");
                image_depth = image_depth.saturating_sub(1);
            }
            Event::Text(t) if in_code => code_buffer.push_str(&t),
            Event::Text(t) if image_depth > 0 => html.push_str(&escape_html(&t)),
            Event::Text(t) => {
                let s = range.start;
                let e = range.end;
                text_spans.push((s, e));
                let _ = write!(
                    html,
                    "<span data-src-offset=\"{s}\" data-src-end=\"{e}\">{}</span>",
                    escape_html(&t)
                );
            }
            Event::Code(c) => {
                let s = range.start;
                let e = range.end;
                text_spans.push((s, e));
                let _ = write!(
                    html,
                    "<code data-src-offset=\"{s}\" data-src-end=\"{e}\">{}</code>",
                    escape_html(&c)
                );
            }
            Event::Start(Tag::TableHead) => {
                in_table_head = true;
                html.push_str("<thead><tr>");
            }
            Event::End(TagEnd::TableHead) => {
                in_table_head = false;
                html.push_str("</tr></thead><tbody>");
            }
            Event::Start(Tag::TableCell) => {
                html.push_str(if in_table_head { "<th>" } else { "<td>" });
            }
            Event::End(TagEnd::TableCell) => {
                html.push_str(if in_table_head { "</th>" } else { "</td>" });
            }
            Event::Start(tag) => emit_open(&mut html, &tag),
            Event::End(tag) => emit_close(&mut html, tag),
            Event::SoftBreak => {
                // A single source newline becomes a hard `<br/>` ONLY when the
                // next line begins with a highlight (a bold/`Strong` inline,
                // e.g. `**Date:** …`). That keeps label/metadata blocks on their
                // own lines while ordinary prose — which the source may have
                // hard-wrapped — collapses to a space and reflows to the window
                // width (standard CommonMark), instead of inheriting the
                // source's wrap points. Gated on `render_line_breaks`: off ⇒
                // strict CommonMark (every soft break collapses).
                let next_starts_with_highlight =
                    matches!(parser.peek(), Some((Event::Start(Tag::Strong), _)));
                if opts.render_line_breaks && next_starts_with_highlight {
                    html.push_str("<br/>");
                } else {
                    html.push('\n');
                }
            }
            Event::HardBreak => html.push_str("<br/>"),
            Event::Rule => html.push_str("<hr/>"),
            Event::TaskListMarker(checked) => {
                if checked {
                    html.push_str("<input type=\"checkbox\" checked disabled/>");
                } else {
                    html.push_str("<input type=\"checkbox\" disabled/>");
                }
            }
            Event::Html(h) | Event::InlineHtml(h) => {
                // pulldown-cmark forwards raw HTML from the source; pass it
                // through verbatim.
                html.push_str(&h);
            }
            // Footnotes / math / metadata are not part of the success-criteria
            // feature set and are dropped here. If a future task enables them
            // it must add the corresponding emit branches and tests.
            _ => {}
        }
    }

    RenderResult { html, text_spans }
}

fn emit_code_block(out: &mut String, code: &str, lang: &str, opts: &RenderOptions) {
    if lang == "mermaid" {
        if opts.mermaid_enabled {
            let _ = write!(out, "<pre class=\"mermaid\">{}</pre>", escape_html(code));
            return;
        }
        // Mermaid disabled: fall through to a plain <pre><code> block.
        out.push_str("<pre><code>");
        out.push_str(&escape_html(code));
        out.push_str("</code></pre>");
        return;
    }
    if opts.syntax_highlighting && !lang.is_empty() {
        let ss = syntax_set();
        if let Some(syntax) = ss
            .find_syntax_by_token(lang)
            .or_else(|| ss.find_syntax_by_extension(lang))
        {
            // Emit CLASS-based highlight markup (scope-derived `syn-*` classes),
            // NOT inline `style="color:…"`. The colors live in document.css with
            // separate light + `body.theme-dark` palettes, so highlighting is
            // theme-reactive: a dark/light toggle just flips the body class — no
            // re-render — and dark code blocks are readable (the old inline
            // light-theme colors were near-black on the dark code panel).
            let mut gen = ClassedHTMLGenerator::new_with_class_style(
                syntax,
                ss,
                ClassStyle::SpacedPrefixed { prefix: "syn-" },
            );
            for line in LinesWithEndings::from(code) {
                let _ = gen.parse_html_for_line_which_includes_newline(line);
            }
            let _ = write!(
                out,
                "<pre><code class=\"language-{} hl\">{}</code></pre>",
                escape_html(lang),
                gen.finalize()
            );
            return;
        }
    }
    if lang.is_empty() {
        out.push_str("<pre><code>");
    } else {
        let _ = write!(out, "<pre><code class=\"language-{}\">", escape_html(lang));
    }
    out.push_str(&escape_html(code));
    out.push_str("</code></pre>");
}

fn emit_open(out: &mut String, tag: &Tag<'_>) {
    match tag {
        Tag::Paragraph => out.push_str("<p>"),
        Tag::Heading { level, .. } => {
            let _ = write!(out, "<{}>", heading_tag(*level));
        }
        Tag::BlockQuote(_) => out.push_str("<blockquote>"),
        Tag::List(Some(_)) => out.push_str("<ol>"),
        Tag::List(None) => out.push_str("<ul>"),
        Tag::Item => out.push_str("<li>"),
        Tag::Emphasis => out.push_str("<em>"),
        Tag::Strong => out.push_str("<strong>"),
        Tag::Strikethrough => out.push_str("<del>"),
        Tag::Link { dest_url, .. } => {
            let _ = write!(out, "<a href=\"{}\">", escape_html(dest_url));
        }
        Tag::Table(_) => out.push_str("<table>"),
        Tag::TableHead => out.push_str("<thead><tr>"),
        Tag::TableRow => out.push_str("<tr>"),
        Tag::TableCell => out.push_str("<td>"),
        // HtmlBlock, FootnoteDefinition, MetadataBlock, CodeBlock, Image fall
        // through silently. CodeBlock and Image are handled inline in
        // `render_markdown`; the rest are not part of the success-criteria
        // feature set.
        _ => {}
    }
}

fn emit_close(out: &mut String, tag: TagEnd) {
    match tag {
        TagEnd::Paragraph => out.push_str("</p>"),
        TagEnd::Heading(level) => {
            let _ = write!(out, "</{}>", heading_tag(level));
        }
        TagEnd::BlockQuote => out.push_str("</blockquote>"),
        TagEnd::List(true) => out.push_str("</ol>"),
        TagEnd::List(false) => out.push_str("</ul>"),
        TagEnd::Item => out.push_str("</li>"),
        TagEnd::Emphasis => out.push_str("</em>"),
        TagEnd::Strong => out.push_str("</strong>"),
        TagEnd::Strikethrough => out.push_str("</del>"),
        TagEnd::Link => out.push_str("</a>"),
        TagEnd::Table => out.push_str("</table>"),
        TagEnd::TableHead => out.push_str("</tr></thead><tbody>"),
        TagEnd::TableRow => out.push_str("</tr>"),
        TagEnd::TableCell => out.push_str("</td>"),
        _ => {}
    }
}

fn heading_tag(level: pulldown_cmark::HeadingLevel) -> &'static str {
    use pulldown_cmark::HeadingLevel::*;
    match level {
        H1 => "h1",
        H2 => "h2",
        H3 => "h3",
        H4 => "h4",
        H5 => "h5",
        H6 => "h6",
    }
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}
