# Print Sample Document

This fixture exercises the headless PDF export path. It is intentionally
deterministic (no dates, no timestamps) so the smoke's byte-size floor stays
stable across runs.

## Headings and Prose

The export must render block-level content under print media so the Phase-A
`@media print` stylesheet applies. The paragraphs here give the renderer
enough flowing text to fill a meaningful fraction of a page.

Markdown viewers anchor comments to source spans, but for the export smoke we
only care that headings, code, and tables paginate into a non-trivial PDF.

### A Fenced Code Block

```rust
fn render_to_pdf(document: &str) -> Result<Vec<u8>, ExportError> {
    let parsed = parse_markdown(document)?;
    let html = parsed.to_print_html();
    let pdf = print_engine::render(&html, PrintMedia::default())?;
    Ok(pdf.into_bytes())
}
```

### A Data Table

| Column        | Type    | Notes                          |
| ------------- | ------- | ------------------------------ |
| id            | integer | primary key                    |
| title         | text    | document heading               |
| body          | text    | rendered markdown source       |
| created_order | integer | stable, monotonic per document |
| exported      | boolean | set once a PDF is produced     |

## Closing Section

A final block of prose so the document spans enough vertical space to produce a
PDF comfortably above a blank-page size floor. The smoke asserts the `%PDF-`
signature, a size above that floor, and the presence of page content markers so
a blank or prematurely-snapshotted export is rejected.
