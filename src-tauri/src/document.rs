//! Markdown document renderer.
//!
//! Parses GFM-flavored Markdown via `pulldown-cmark` and emits HTML in which
//! every text-bearing inline element (`<span>` for prose, `<code>` for inline
//! code) carries `data-src-offset` / `data-src-end` attributes whose values
//! are byte offsets into the original source. The frontend uses those
//! attributes (see A10) to map DOM Range selections back to source offsets
//! without character-counting walks.
//!
//! Code blocks honour two settings:
//! - `syntax_highlighting`: when true, fenced code blocks with a recognised
//!   language tag are highlighted via `syntect` (HTML inline-style spans).
//!   When false, raw `<pre><code class="language-...">` is emitted.
//! - `mermaid_enabled`: when true, ```` ```mermaid ```` fences pass through as
//!   `<pre class="mermaid">...</pre>` for client-side rendering. When false
//!   they fall back to a raw `<pre><code>` block.
//!
//! `SyntaxSet` and `ThemeSet` are loaded once via `OnceLock` so first render
//! pays the multi-millisecond load cost and subsequent renders amortize it.

use crate::watcher::quick_hash;
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};
use std::fmt::Write as _;
use std::path::Path;
use std::sync::OnceLock;
use syntect::easy::HighlightLines;
use syntect::highlighting::{Theme, ThemeSet};
use syntect::html::{styled_line_to_highlighted_html, IncludeBackground};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;

/// Result of an atomic `save_document` call.
///
/// `content_hash` is the [`quick_hash`] of the bytes that landed on disk —
/// the same value the watcher uses for self-write suppression. `bytes_written`
/// echoes the input length so callers can surface "Saved 1.2 KB" UI without
/// a follow-up `metadata()` call.
#[derive(Debug, Clone, Copy)]
pub struct SaveResult {
    pub bytes_written: usize,
    pub content_hash: u64,
}

/// IPC-facing save outcome for the `save_document` command. Distinct from
/// the lower-level `SaveResult` struct above (which counts bytes + hashes
/// and is returned by the `save_document` filesystem helper). Only the IPC
/// layer surfaces conflicts — the on-disk write helper is local-only and
/// has no remote-divergence concept.
///
/// `Ok.etag` is the new resource ETag for DriveApi saves and `None` for
/// Local + DriveDesktop saves (no ETag concept on either of those paths).
/// `Conflict.drive_source` disambiguates the two Drive code paths for the
/// banner string in wireframe 07; `None` when the conflict came from the
/// existing Local mtime-mismatch path that predates the Drive integration.
#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SaveOutcome {
    Ok {
        etag: Option<String>,
    },
    Conflict {
        local: String,
        remote: String,
        drive_source: Option<String>,
    },
}

/// Atomically write `contents` to `path`.
///
/// The crash-safe pattern: write to `<path>.tmp`, fsync, then `rename` over
/// the target. A crash between `create` and `rename` leaves the original
/// file intact; a crash between `rename` and the next operation has already
/// committed the new bytes.
///
/// Self-write priming: the spec's Avoid clause requires that the watcher's
/// suppression list be primed BEFORE the rename so notify's worker thread
/// can never deliver an unsuppressed event. Pass a closure that records the
/// hash with [`crate::watcher::Watcher::record_self_write`]; the closure
/// fires after the temp file is fsynced and BEFORE the rename, closing the
/// race window unconditionally rather than relying on notify being slower
/// than a Mutex acquisition.
pub fn save_document<F>(
    path: &Path,
    contents: &[u8],
    prime_self_write: F,
) -> std::io::Result<SaveResult>
where
    F: FnOnce(&Path, u64),
{
    use std::io::Write;
    // Build a sibling `<path>.tmp` (or `<path>.<ext>.tmp` when the original
    // has an extension). `with_extension` would *replace* the extension, so
    // we splice manually to keep the original on the temp name. That makes
    // it trivial to spot abandoned temp files in case of a crash.
    let tmp = path.with_extension(
        path.extension()
            .and_then(|s| s.to_str())
            .map(|e| format!("{e}.tmp"))
            .unwrap_or_else(|| "tmp".into()),
    );
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(contents)?;
        f.sync_all()?;
    }
    // Hash the bytes once. Pass to the priming closure BEFORE rename so the
    // watcher's self-write list can suppress the resulting notify event.
    let content_hash = quick_hash(contents);
    prime_self_write(path, content_hash);

    std::fs::rename(&tmp, path)?;

    // Defensive: fsync the parent directory so the rename itself is durable
    // (the file content is already fsynced above). On filesystems where
    // metadata journaling is not data-ordered, a power loss between rename
    // and the next directory flush can otherwise lose the rename.
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            // Best-effort — sync_all on a directory handle isn't supported
            // on every platform (e.g. Windows). Ignore Err here; the worst
            // case is the same fragility the previous version had.
            let _ = dir.sync_all();
        }
    }

    Ok(SaveResult {
        bytes_written: contents.len(),
        content_hash,
    })
}

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export)]
pub struct RenderOptions {
    pub syntax_highlighting: bool,
    pub mermaid_enabled: bool,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            syntax_highlighting: true,
            mermaid_enabled: true,
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

fn theme() -> &'static Theme {
    static TS: OnceLock<ThemeSet> = OnceLock::new();
    let set = TS.get_or_init(ThemeSet::load_defaults);
    // syntect's defaults always ship "InspiredGitHub"; the fallback exists for
    // belt-and-suspenders against future bundle changes.
    set.themes
        .get("InspiredGitHub")
        .or_else(|| set.themes.values().next())
        .expect("syntect default ThemeSet should contain at least one theme")
}

/// Renders `source` markdown into HTML annotated with `data-src-offset`
/// attributes on inline text carriers.
pub fn render_markdown(source: &str, opts: &RenderOptions) -> RenderResult {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_GFM);

    let parser = Parser::new_ext(source, options).into_offset_iter();

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

    for (event, range) in parser {
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
            Event::SoftBreak => html.push('\n'),
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
            let mut h = HighlightLines::new(syntax, theme());
            let _ = write!(
                out,
                "<pre><code class=\"language-{} hl\">",
                escape_html(lang)
            );
            for line in LinesWithEndings::from(code) {
                if let Ok(regions) = h.highlight_line(line, ss) {
                    if let Ok(html_line) =
                        styled_line_to_highlighted_html(&regions[..], IncludeBackground::No)
                    {
                        out.push_str(&html_line);
                    }
                }
            }
            out.push_str("</code></pre>");
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
