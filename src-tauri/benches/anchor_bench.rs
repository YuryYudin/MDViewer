//! Phase-2 (B1) reattachment latency bench.
//!
//! Locked-crate decision support: this bench exercises the fuzzy-match path of
//! `resolve_anchor_with_threshold` against `diff-match-patch-rs`'s Bitap
//! `match_main`. The fixture deliberately mistypes "ipsum" as "ipsem" so the
//! exact-match short-circuit cannot fire and the bench measures the path that
//! actually matters for crate selection.
use criterion::{criterion_group, criterion_main, Criterion};
use mdviewer_lib::anchor::{resolve_anchor_with_threshold, Anchor};

fn fixture_doc(scale: usize) -> String {
    let p = "lorem ipsem dolor sit amet consectetur adipiscing elit ";
    p.repeat(scale)
}

fn bench_fuzzy(c: &mut Criterion) {
    let src = fixture_doc(2_000); // ~110 KB document
    let anchor = Anchor {
        start: 0,
        end: 11,
        exact: "lorem ipsum".into(), // NOT verbatim — fuzzy required
        prefix: "".into(),
        suffix: " dolor".into(),
    };
    c.bench_function("fuzzy_reattach_110kb_fuzzy_path", |b| {
        b.iter(|| resolve_anchor_with_threshold(&src, &anchor, 75));
    });
}

criterion_group!(benches, bench_fuzzy);
criterion_main!(benches);
